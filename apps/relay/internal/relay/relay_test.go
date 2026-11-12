package relay

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHostAndClientForwardFrames(t *testing.T) {
	server := httptest.NewServer(New(Config{RegistrationSecret: "secret"}).Handler())
	defer server.Close()

	room, hostToken, clientToken := createRoom(t, server.URL, "secret")
	host := dial(t, server.URL, room, "host", hostToken)
	defer host.Close(websocket.StatusNormalClosure, "done")
	client := dial(t, server.URL, room, "client", clientToken)
	defer client.Close(websocket.StatusNormalClosure, "done")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	kind, data, err := host.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText || !strings.Contains(string(data), `"t":"peer"`) {
		t.Fatalf("expected peer control, got %d %s", kind, data)
	}
	kind, data, err = client.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText || !strings.Contains(string(data), `"t":"welcome"`) {
		t.Fatalf("expected welcome control, got %d %s", kind, data)
	}

	if err := client.Write(ctx, websocket.MessageBinary, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	kind, data, err = host.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || len(data) < 4 || string(data[4:]) != "hello" {
		t.Fatalf("unexpected client->host frame: %d %v", kind, data)
	}
	clientID := binary.BigEndian.Uint32(data[:4])
	reply := make([]byte, 4+len("world"))
	binary.BigEndian.PutUint32(reply, clientID)
	copy(reply[4:], "world")
	if err := host.Write(ctx, websocket.MessageBinary, reply); err != nil {
		t.Fatal(err)
	}
	kind, data, err = client.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || string(data) != "world" {
		t.Fatalf("unexpected host->client frame: %d %q", kind, data)
	}

	// Clients may use a text frame for the Noise handshake. The relay still
	// forwards it to the host with the client id prefix; the framing remains
	// opaque to the relay.
	if err := client.Write(ctx, websocket.MessageText, []byte(`{"t":"noise"}`)); err != nil {
		t.Fatal(err)
	}
	kind, data, err = host.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || len(data) < 4 || string(data[4:]) != `{"t":"noise"}` {
		t.Fatalf("unexpected client text frame: %d %q", kind, data)
	}
}

func TestRoomRequiresRegistrationSecret(t *testing.T) {
	server := httptest.NewServer(New(Config{RegistrationSecret: "secret"}).Handler())
	defer server.Close()

	body := `{"room":"room_12345678","hostToken":"ht","clientToken":"ct"}`
	response, err := http.Post(server.URL+"/v1/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.StatusCode)
	}
}

func createRoom(t *testing.T, baseURL, secret string) (room, hostToken, clientToken string) {
	t.Helper()
	hostToken = "host-token"
	clientToken = "client-token"
	body, _ := json.Marshal(map[string]any{
		"room":        "room_test_123456",
		"hostToken":   hostToken,
		"clientToken": clientToken,
	})
	request, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/rooms", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("create room: %d %s", response.StatusCode, raw)
	}
	var result struct {
		Room string `json:"room"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result.Room, hostToken, clientToken
}

func dial(t *testing.T, baseURL, room, role, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(baseURL, "http") + "/ws?room=" + room + "&role=" + role + "&v=1"
	conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
	})
	if err != nil {
		if response != nil {
			raw, _ := io.ReadAll(response.Body)
			t.Fatalf("dial %s: %v (%d %s)", role, err, response.StatusCode, raw)
		}
		t.Fatal(err)
	}
	return conn
}

func TestClientCanAuthenticateWithQueryToken(t *testing.T) {
	server := httptest.NewServer(New(Config{RegistrationSecret: "secret"}).Handler())
	defer server.Close()

	room, hostToken, clientToken := createRoom(t, server.URL, "secret")
	host := dial(t, server.URL, room, "host", hostToken)
	defer host.Close(websocket.StatusNormalClosure, "done")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?room=" + room + "&role=client&v=1&token=" + clientToken
	client, response, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		if response != nil {
			raw, _ := io.ReadAll(response.Body)
			t.Fatalf("dial client: %v (%d %s)", err, response.StatusCode, raw)
		}
		t.Fatal(err)
	}
	defer client.Close(websocket.StatusNormalClosure, "done")

	kind, data, err := client.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText || !strings.Contains(string(data), `"t":"welcome"`) {
		t.Fatalf("expected welcome control, got %d %s", kind, data)
	}
}
