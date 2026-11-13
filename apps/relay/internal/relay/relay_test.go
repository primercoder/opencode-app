package relay

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testServer(t *testing.T) (*Server, *Store, *httptest.Server) {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	server := New(Config{Store: store})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, store, httpServer
}

func mustInvite(t *testing.T, store *Store, kind string) string {
	t.Helper()
	_, token, err := store.CreateInvite(kind, "", time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func wsURL(httpServer *httptest.Server) string {
	return "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
}

func dialRaw(t *testing.T, httpServer *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL(httpServer), nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

type welcomeFrame struct {
	T            string   `json:"t"`
	V            int      `json:"v"`
	Kind         string   `json:"kind"`
	SubjectID    string   `json:"subjectId"`
	Secret       string   `json:"secret"`
	Room         string   `json:"room"`
	Enrolled     bool     `json:"enrolled"`
	ClientID     uint32   `json:"clientId"`
	ClientInvite string   `json:"clientInvite"`
	Caps         []string `json:"caps"`
}

func sendHello(t *testing.T, conn *websocket.Conn, hello map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	raw, _ := json.Marshal(hello)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, conn *websocket.Conn, target any) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if target != nil {
		if err := json.Unmarshal(data, target); err != nil {
			t.Fatalf("decode %q: %v", data, err)
		}
	}
	return kind, data
}

func enrollHost(t *testing.T, httpServer *httptest.Server, store *Store, name string) (string, string, string) {
	t.Helper()
	host := dialRaw(t, httpServer)
	t.Cleanup(func() { _ = host.Close(websocket.StatusNormalClosure, "done") })
	sendHello(t, host, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": name})
	var welcome welcomeFrame
	readJSON(t, host, &welcome)
	if welcome.T != "relay.welcome" || !welcome.Enrolled || welcome.Secret == "" || welcome.Room == "" {
		t.Fatalf("unexpected host welcome: %+v", welcome)
	}
	return welcome.SubjectID, welcome.Secret, welcome.Room
}

func enrollClient(t *testing.T, httpServer *httptest.Server, store *Store, room string) (string, string) {
	t.Helper()
	client := dialRaw(t, httpServer)
	t.Cleanup(func() { _ = client.Close(websocket.StatusNormalClosure, "done") })
	sendHello(t, client, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": mustInvite(t, store, KindClient), "name": "phone", "room": room})
	var welcome welcomeFrame
	readJSON(t, client, &welcome)
	if welcome.T != "relay.welcome" || !welcome.Enrolled || welcome.Secret == "" {
		t.Fatalf("unexpected client welcome: %+v", welcome)
	}
	_, data := readJSON(t, client, nil)
	if !strings.Contains(string(data), `"t":"welcome"`) {
		t.Fatalf("expected room welcome, got %s", data)
	}
	return welcome.SubjectID, welcome.Secret
}

func TestHostClientEnrollmentAndForwarding(t *testing.T) {
	_, store, httpServer := testServer(t)

	host := dialRaw(t, httpServer)
	defer host.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, host, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "desktop"})
	var hostWelcome welcomeFrame
	readJSON(t, host, &hostWelcome)
	if hostWelcome.Room == "" || hostWelcome.Secret == "" || hostWelcome.SubjectID == "" {
		t.Fatalf("host enrollment failed: %+v", hostWelcome)
	}
	if !strings.HasPrefix(hostWelcome.SubjectID, "sub_") || !strings.HasPrefix(hostWelcome.Room, "room_") {
		t.Fatalf("unexpected ids: %+v", hostWelcome)
	}

	client := dialRaw(t, httpServer)
	defer client.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, client, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": mustInvite(t, store, KindClient), "name": "phone", "room": hostWelcome.Room})
	var clientWelcome welcomeFrame
	readJSON(t, client, &clientWelcome)
	if !clientWelcome.Enrolled || clientWelcome.Room != hostWelcome.Room || clientWelcome.SubjectID == "" {
		t.Fatalf("client enrollment failed: %+v", clientWelcome)
	}
	var roomWelcome struct {
		T        string `json:"t"`
		ClientID uint32 `json:"clientId"`
	}
	readJSON(t, client, &roomWelcome)
	if roomWelcome.T != "welcome" || roomWelcome.ClientID == 0 {
		t.Fatalf("expected room welcome, got %+v", roomWelcome)
	}

	var peer struct {
		T        string `json:"t"`
		ClientID uint32 `json:"clientId"`
	}
	readJSON(t, host, &peer)
	if peer.T != "peer" || peer.ClientID != roomWelcome.ClientID {
		t.Fatalf("expected peer control, got %+v", peer)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Write(ctx, websocket.MessageText, []byte(`{"t":"noise"}`)); err != nil {
		t.Fatal(err)
	}
	kind, data, err := host.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || len(data) < 4 || string(data[4:]) != `{"t":"noise"}` {
		t.Fatalf("unexpected client->host frame: %d %q", kind, data)
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

	// Subjects are long-lived and can reconnect with the returned secret.
	reconnect := dialRaw(t, httpServer)
	defer reconnect.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, reconnect, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "subjectId": hostWelcome.SubjectID, "secret": hostWelcome.Secret})
	var again welcomeFrame
	readJSON(t, reconnect, &again)
	if again.T != "relay.welcome" || again.Room != hostWelcome.Room || again.Secret != "" {
		t.Fatalf("unexpected reconnect welcome: %+v", again)
	}
}

func TestHostReceivesOneTimePhoneInvites(t *testing.T) {
	_, store, httpServer := testServer(t)

	host := dialRaw(t, httpServer)
	defer host.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, host, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "desktop"})
	var hostWelcome welcomeFrame
	readJSON(t, host, &hostWelcome)
	if hostWelcome.ClientInvite == "" {
		t.Fatalf("host welcome did not include a phone invite: %+v", hostWelcome)
	}
	if len(hostWelcome.Caps) == 0 || hostWelcome.Caps[0] != "clientInvite" {
		t.Fatalf("host welcome did not advertise phone invites: %+v", hostWelcome)
	}
	token, kind := linkToken(t, hostWelcome.ClientInvite)
	if kind != KindClient {
		t.Fatalf("host phone invite has kind %q", kind)
	}

	// The host-issued link enrolls a phone for this room.
	client := dialRaw(t, httpServer)
	defer client.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, client, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": token, "room": hostWelcome.Room})
	var clientWelcome welcomeFrame
	readJSON(t, client, &clientWelcome)
	if !clientWelcome.Enrolled || clientWelcome.Room != hostWelcome.Room {
		t.Fatalf("phone enrollment with host invite failed: %+v", clientWelcome)
	}
	// Drain the client's room welcome and the host's peer notification.
	readJSON(t, client, nil)
	readJSON(t, host, nil)

	// The link is single-use.
	again := dialRaw(t, httpServer)
	defer again.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, again, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": token, "room": hostWelcome.Room})
	var failure struct {
		Code string `json:"code"`
	}
	readJSON(t, again, &failure)
	if failure.Code != "RELAY_INVITE_CONSUMED" {
		t.Fatalf("expected consumed invite, got %+v", failure)
	}

	// A room-bound invite cannot be replayed against another host room.
	other := dialRaw(t, httpServer)
	defer other.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, other, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "other"})
	var otherWelcome welcomeFrame
	readJSON(t, other, &otherWelcome)
	otherToken, _ := linkToken(t, otherWelcome.ClientInvite)
	wrongRoom := dialRaw(t, httpServer)
	defer wrongRoom.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, wrongRoom, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": otherToken, "room": hostWelcome.Room})
	readJSON(t, wrongRoom, &failure)
	if failure.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected room binding failure, got %+v", failure)
	}

	// A connected host can ask for another invite on demand. The pairing offer
	// uses this fresh link.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := host.Write(ctx, websocket.MessageText, []byte(`{"t":"relay.invite","kind":"client"}`)); err != nil {
		t.Fatal(err)
	}
	var inviteFrame struct {
		T      string `json:"t"`
		Invite string `json:"invite"`
	}
	readJSON(t, host, &inviteFrame)
	if inviteFrame.T != "relay.invite" || inviteFrame.Invite == "" {
		t.Fatalf("unexpected invite control reply: %+v", inviteFrame)
	}
	requested, _ := linkToken(t, inviteFrame.Invite)
	phone := dialRaw(t, httpServer)
	defer phone.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, phone, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": requested, "room": hostWelcome.Room})
	var phoneWelcome welcomeFrame
	readJSON(t, phone, &phoneWelcome)
	if !phoneWelcome.Enrolled {
		t.Fatalf("phone enrollment with requested invite failed: %+v", phoneWelcome)
	}
}

func linkToken(t *testing.T, link string) (string, string) {
	t.Helper()
	if !strings.HasPrefix(link, "ocremote-relay://enroll#") {
		t.Fatalf("unexpected invite link: %s", link)
	}
	payload := decodeLink(t, strings.TrimPrefix(link, "ocremote-relay://enroll#"))
	token, _ := payload["invite"].(string)
	kind, _ := payload["kind"].(string)
	if token == "" {
		t.Fatalf("invite link has no token: %s", link)
	}
	return token, kind
}

func TestInviteIsOneTime(t *testing.T) {
	_, store, httpServer := testServer(t)
	token := mustInvite(t, store, KindHost)

	first := dialRaw(t, httpServer)
	defer first.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, first, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": token})
	var welcome welcomeFrame
	readJSON(t, first, &welcome)
	if !welcome.Enrolled {
		t.Fatalf("first enrollment failed: %+v", welcome)
	}

	second := dialRaw(t, httpServer)
	defer second.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, second, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": token})
	var failure struct {
		T    string `json:"t"`
		Code string `json:"code"`
	}
	readJSON(t, second, &failure)
	if failure.T != "relay.error" || failure.Code != "RELAY_INVITE_CONSUMED" {
		t.Fatalf("expected consumed invite error, got %+v", failure)
	}
}

func TestRotateInvalidatesInviteAndRevokeDisconnects(t *testing.T) {
	server, store, httpServer := testServer(t)
	hostID, hostSecret, room := enrollHost(t, httpServer, store, "desktop")

	oldClientInvite := mustInvite(t, store, KindClient)
	if _, _, err := store.RotateInvite(KindClient, ""); err != nil {
		t.Fatal(err)
	}
	stale := dialRaw(t, httpServer)
	defer stale.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, stale, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "invite": oldClientInvite, "room": room})
	var failure struct {
		Code string `json:"code"`
	}
	readJSON(t, stale, &failure)
	if failure.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected invalid invite after rotate, got %+v", failure)
	}

	clientID, _ := enrollClient(t, httpServer, store, room)
	if _, err := server.RevokeSubject(clientID); err != nil {
		t.Fatal(err)
	}

	reconnect := dialRaw(t, httpServer)
	defer reconnect.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, reconnect, map[string]any{"t": "relay.hello", "v": 2, "kind": "client", "subjectId": clientID, "secret": "whatever", "room": room})
	readJSON(t, reconnect, &failure)
	if failure.Code != "RELAY_SUBJECT_REVOKED" && failure.Code != "RELAY_SUBJECT_INVALID" {
		t.Fatalf("expected revoked subject error, got %+v", failure)
	}

	if _, err := server.RevokeSubject(hostID); err != nil {
		t.Fatal(err)
	}
	hostReconnect := dialRaw(t, httpServer)
	defer hostReconnect.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, hostReconnect, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "subjectId": hostID, "secret": hostSecret})
	readJSON(t, hostReconnect, &failure)
	if failure.Code != "RELAY_SUBJECT_REVOKED" {
		t.Fatalf("expected revoked host error, got %+v", failure)
	}
}

func TestWrongKindAndExpiredInvites(t *testing.T) {
	_, store, httpServer := testServer(t)
	clientInvite := mustInvite(t, store, KindClient)

	conn := dialRaw(t, httpServer)
	defer conn.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, conn, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": clientInvite})
	var failure struct {
		Code string `json:"code"`
	}
	readJSON(t, conn, &failure)
	if failure.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected kind mismatch, got %+v", failure)
	}

	_, expired, err := store.CreateInvite(KindHost, "", time.Now().Add(-time.Second))
	if err != nil {
		t.Fatal(err)
	}
	conn2 := dialRaw(t, httpServer)
	defer conn2.Close(websocket.StatusNormalClosure, "done")
	sendHello(t, conn2, map[string]any{"t": "relay.hello", "v": 2, "kind": "host", "invite": expired})
	readJSON(t, conn2, &failure)
	if failure.Code != "RELAY_INVITE_EXPIRED" {
		t.Fatalf("expected expired invite, got %+v", failure)
	}
}

func TestLegacyQueryIsRejected(t *testing.T) {
	_, _, httpServer := testServer(t)
	response, err := http.Get(httpServer.URL + "/ws?room=room_x&role=host&token=old")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUpgradeRequired {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected 426, got %d %s", response.StatusCode, raw)
	}
}

func TestAdminInviteLinkShape(t *testing.T) {
	server, store, _ := testServer(t)
	invite, token, err := store.CreateInvite(KindClient, "phone", time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	link := server.InviteLink(KindClient, token)
	if !strings.HasPrefix(link, "ocremote-relay://enroll#") {
		t.Fatalf("unexpected link: %s", link)
	}
	raw := strings.TrimPrefix(link, "ocremote-relay://enroll#")
	payload := decodeLink(t, raw)
	if payload["invite"] != token || payload["kind"] != KindClient || payload["relayId"] != store.RelayID() {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	if invite.Kind != KindClient || invite.ConsumedAt != 0 {
		t.Fatalf("unexpected invite: %+v", invite)
	}
}

func TestEnsureTLSCreatesReusableLocalCA(t *testing.T) {
	dir := t.TempDir()
	files, err := EnsureTLS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !files.Generated {
		t.Fatal("first call should generate certificates")
	}
	for _, path := range []string{files.CAFile, files.CertFile, files.KeyFile} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("missing %s: %v", path, err)
		}
	}
	pair, err := tls.LoadX509KeyPair(files.CertFile, files.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ip := range leaf.IPAddresses {
		if ip.Equal(net.ParseIP("127.0.0.1")) {
			found = true
		}
	}
	if !found {
		t.Fatalf("server certificate does not cover 127.0.0.1: %v", leaf.IPAddresses)
	}
	again, err := EnsureTLS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.Generated {
		t.Fatal("second call should reuse the existing certificate")
	}
}

func TestDefaultPublicURLUsesWSS(t *testing.T) {
	if value := DefaultPublicURL(":8443"); !strings.HasPrefix(value, "wss://") || !strings.HasSuffix(value, ":8443/ws") {
		t.Fatalf("unexpected default public URL: %s", value)
	}
}

func decodeRawURL(raw string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(raw)
}

func decodeLink(t *testing.T, raw string) map[string]any {
	t.Helper()
	decoded, err := decodeRawURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(decoded, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}
