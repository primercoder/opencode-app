package relay

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
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
	"github.com/flynn/noise"
)

func testServer(t *testing.T) (*Server, *Store, *httptest.Server) {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	key, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := New(Config{Store: store, RelayKey: key})
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
	Code         string   `json:"code"`
	Message      string   `json:"message"`
}

type noiseClient struct {
	conn    *websocket.Conn
	welcome welcomeFrame
	send    *noise.CipherState
	receive *noise.CipherState
}

func dialNoise(t *testing.T, httpServer *httptest.Server, server *Server, hello map[string]any) *noiseClient {
	t.Helper()
	conn := dialRaw(t, httpServer)
	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: relayCipherSuite(),
		Pattern:     noise.HandshakeNK,
		Initiator:   true,
		Prologue:    []byte(relayNoisePrologue),
		PeerStatic:  server.cfg.RelayKey.Public,
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(hello)
	first, _, _, err := hs.WriteMessage(nil, raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, first); err != nil {
		t.Fatal(err)
	}
	kind, second, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary {
		t.Fatalf("expected binary handshake reply, got %d", kind)
	}
	payload, send, receive, err := hs.ReadMessage(nil, second)
	if err != nil {
		t.Fatal(err)
	}
	var welcome welcomeFrame
	if err := json.Unmarshal(payload, &welcome); err != nil {
		t.Fatalf("decode welcome %q: %v", payload, err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "done") })
	return &noiseClient{conn: conn, welcome: welcome, send: send, receive: receive}
}

func readControl(t *testing.T, client *noiseClient, target any) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := client.conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText {
		t.Fatalf("expected encrypted control text, got %d", kind)
	}
	plaintext, err := decryptRelayControl(client.receive, string(data))
	if err != nil {
		t.Fatalf("decrypt control: %v", err)
	}
	if target != nil {
		if err := json.Unmarshal(plaintext, target); err != nil {
			t.Fatalf("decode control %q: %v", plaintext, err)
		}
	}
	return plaintext
}

func sendControl(t *testing.T, client *noiseClient, value any) {
	t.Helper()
	raw, _ := json.Marshal(value)
	encrypted, err := encryptRelayControl(client.send, raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.conn.Write(ctx, websocket.MessageText, []byte(encrypted)); err != nil {
		t.Fatal(err)
	}
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

func enrollHost(t *testing.T, httpServer *httptest.Server, server *Server, store *Store, name string) (string, string, string) {
	t.Helper()
	host := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": name})
	if host.welcome.T != "relay.welcome" || !host.welcome.Enrolled || host.welcome.Secret == "" || host.welcome.Room == "" {
		t.Fatalf("unexpected host welcome: %+v", host.welcome)
	}
	return host.welcome.SubjectID, host.welcome.Secret, host.welcome.Room
}

func enrollClient(t *testing.T, httpServer *httptest.Server, server *Server, store *Store, room string) (string, string) {
	t.Helper()
	client := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": mustInvite(t, store, KindClient), "name": "phone", "room": room})
	if client.welcome.T != "relay.welcome" || !client.welcome.Enrolled || client.welcome.Secret == "" {
		t.Fatalf("unexpected client welcome: %+v", client.welcome)
	}
	return client.welcome.SubjectID, client.welcome.Secret
}

func TestHostClientEnrollmentAndForwarding(t *testing.T) {
	server, store, httpServer := testServer(t)

	host := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "desktop"})
	if host.welcome.Room == "" || host.welcome.Secret == "" || host.welcome.SubjectID == "" {
		t.Fatalf("host enrollment failed: %+v", host.welcome)
	}
	if !strings.HasPrefix(host.welcome.SubjectID, "sub_") || !strings.HasPrefix(host.welcome.Room, "room_") {
		t.Fatalf("unexpected ids: %+v", host.welcome)
	}

	client := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": mustInvite(t, store, KindClient), "name": "phone", "room": host.welcome.Room})
	if !client.welcome.Enrolled || client.welcome.Room != host.welcome.Room || client.welcome.SubjectID == "" {
		t.Fatalf("client enrollment failed: %+v", client.welcome)
	}
	if client.welcome.ClientID == 0 {
		t.Fatalf("expected room client id, got %+v", client.welcome)
	}

	var peer struct {
		T        string `json:"t"`
		ClientID uint32 `json:"clientId"`
	}
	readControl(t, host, &peer)
	if peer.T != "peer" || peer.ClientID != client.welcome.ClientID {
		t.Fatalf("expected peer control, got %+v", peer)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.conn.Write(ctx, websocket.MessageText, []byte(`{"t":"noise"}`)); err != nil {
		t.Fatal(err)
	}
	kind, data, err := host.conn.Read(ctx)
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
	if err := host.conn.Write(ctx, websocket.MessageBinary, reply); err != nil {
		t.Fatal(err)
	}
	kind, data, err = client.conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || string(data) != "world" {
		t.Fatalf("unexpected host->client frame: %d %q", kind, data)
	}

	// Subjects are long-lived and can reconnect with the returned secret.
	reconnect := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "subjectId": host.welcome.SubjectID, "secret": host.welcome.Secret})
	if reconnect.welcome.T != "relay.welcome" || reconnect.welcome.Room != host.welcome.Room || reconnect.welcome.Secret != "" {
		t.Fatalf("unexpected reconnect welcome: %+v", reconnect.welcome)
	}
}

func TestHostReceivesOneTimePhoneInvites(t *testing.T) {
	server, store, httpServer := testServer(t)

	host := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "desktop"})
	if host.welcome.ClientInvite == "" {
		t.Fatalf("host welcome did not include a phone invite: %+v", host.welcome)
	}
	if len(host.welcome.Caps) == 0 || host.welcome.Caps[0] != "clientInvite" {
		t.Fatalf("host welcome did not advertise phone invites: %+v", host.welcome)
	}
	token, kind := linkToken(t, host.welcome.ClientInvite)
	if kind != KindClient {
		t.Fatalf("host phone invite has kind %q", kind)
	}

	// The host-issued link enrolls a phone for this room.
	client := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": token, "room": host.welcome.Room})
	if !client.welcome.Enrolled || client.welcome.Room != host.welcome.Room {
		t.Fatalf("phone enrollment with host invite failed: %+v", client.welcome)
	}
	var peer struct {
		T string `json:"t"`
	}
	readControl(t, host, &peer)

	// The link is single-use.
	again := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": token, "room": host.welcome.Room})
	if again.welcome.T != "relay.error" || again.welcome.Code != "RELAY_INVITE_CONSUMED" {
		t.Fatalf("expected consumed invite, got %+v", again.welcome)
	}

	// A room-bound invite cannot be replayed against another host room.
	other := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": mustInvite(t, store, KindHost), "name": "other"})
	otherToken, _ := linkToken(t, other.welcome.ClientInvite)
	wrongRoom := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": otherToken, "room": host.welcome.Room})
	if wrongRoom.welcome.T != "relay.error" || wrongRoom.welcome.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected room binding failure, got %+v", wrongRoom.welcome)
	}

	// A connected host can ask for another invite on demand. The pairing offer
	// uses this fresh link.
	sendControl(t, host, map[string]any{"t": "relay.invite", "kind": "client"})
	var inviteFrame struct {
		T      string `json:"t"`
		Invite string `json:"invite"`
	}
	readControl(t, host, &inviteFrame)
	if inviteFrame.T != "relay.invite" || inviteFrame.Invite == "" {
		t.Fatalf("unexpected invite control reply: %+v", inviteFrame)
	}
	requested, _ := linkToken(t, inviteFrame.Invite)
	phone := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": requested, "room": host.welcome.Room})
	if !phone.welcome.Enrolled {
		t.Fatalf("phone enrollment with requested invite failed: %+v", phone.welcome)
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
	server, store, httpServer := testServer(t)
	token := mustInvite(t, store, KindHost)

	first := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": token})
	if !first.welcome.Enrolled {
		t.Fatalf("first enrollment failed: %+v", first.welcome)
	}

	second := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": token})
	if second.welcome.T != "relay.error" || second.welcome.Code != "RELAY_INVITE_CONSUMED" {
		t.Fatalf("expected consumed invite error, got %+v", second.welcome)
	}
}

func TestRotateInvalidatesInviteAndRevokeDisconnects(t *testing.T) {
	server, store, httpServer := testServer(t)
	hostID, hostSecret, room := enrollHost(t, httpServer, server, store, "desktop")

	oldClientInvite := mustInvite(t, store, KindClient)
	if _, _, err := store.RotateInvite(KindClient, ""); err != nil {
		t.Fatal(err)
	}
	stale := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "invite": oldClientInvite, "room": room})
	if stale.welcome.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected invalid invite after rotate, got %+v", stale.welcome)
	}

	clientID, _ := enrollClient(t, httpServer, server, store, room)
	if _, err := server.RevokeSubject(clientID); err != nil {
		t.Fatal(err)
	}

	reconnect := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "client", "subjectId": clientID, "secret": "whatever", "room": room})
	if reconnect.welcome.Code != "RELAY_SUBJECT_REVOKED" && reconnect.welcome.Code != "RELAY_SUBJECT_INVALID" {
		t.Fatalf("expected revoked subject error, got %+v", reconnect.welcome)
	}

	if _, err := server.RevokeSubject(hostID); err != nil {
		t.Fatal(err)
	}
	hostReconnect := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "subjectId": hostID, "secret": hostSecret})
	if hostReconnect.welcome.Code != "RELAY_SUBJECT_REVOKED" {
		t.Fatalf("expected revoked host error, got %+v", hostReconnect.welcome)
	}
}

func TestWrongKindAndExpiredInvites(t *testing.T) {
	server, store, httpServer := testServer(t)
	clientInvite := mustInvite(t, store, KindClient)

	conn := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": clientInvite})
	if conn.welcome.Code != "RELAY_INVITE_INVALID" {
		t.Fatalf("expected kind mismatch, got %+v", conn.welcome)
	}

	_, expired, err := store.CreateInvite(KindHost, "", time.Now().Add(-time.Second))
	if err != nil {
		t.Fatal(err)
	}
	conn2 := dialNoise(t, httpServer, server, map[string]any{"t": "relay.hello", "v": 3, "kind": "host", "invite": expired})
	if conn2.welcome.Code != "RELAY_INVITE_EXPIRED" {
		t.Fatalf("expected expired invite, got %+v", conn2.welcome)
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
	if payload["invite"] != token || payload["kind"] != KindClient || payload["relayId"] != store.RelayID() || payload["rk"] != PublicKeyText(server.cfg.RelayKey) {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	if invite.Kind != KindClient || invite.ConsumedAt != 0 {
		t.Fatalf("unexpected invite: %+v", invite)
	}
}

func TestTLSRejectsPartialDirectoryWithoutOverwriting(t *testing.T) {
	dir := t.TempDir()
	files, err := EnsureTLS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(files.CAKeyFile); err != nil {
		t.Fatalf("missing CA private key: %v", err)
	}
	before, err := os.ReadFile(files.CertFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(files.CAKeyFile); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureTLS(dir); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("expected incomplete TLS error, got %v", err)
	}
	after, err := os.ReadFile(files.CertFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("partial TLS resolution overwrote the server certificate")
	}
}

func TestTLSRotateRegeneratesOnlyWhenRequested(t *testing.T) {
	dir := t.TempDir()
	files, err := EnsureTLS(dir)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(files.CAFile)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := ResolveTLS(TLSOptions{DataDir: dir, Rotate: true})
	if err != nil {
		t.Fatal(err)
	}
	if !rotated.Generated {
		t.Fatal("rotate should report generated files")
	}
	after, err := os.ReadFile(rotated.CAFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) == string(after) {
		t.Fatal("rotate did not regenerate the CA")
	}
}

func TestTLSRejectsInvalidCAAndHostMismatch(t *testing.T) {
	dir := t.TempDir()
	files, err := EnsureTLS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveTLS(TLSOptions{DataDir: dir, Host: "definitely-not-covered.example"}); err == nil {
		t.Fatal("expected host coverage failure")
	}
	if err := os.WriteFile(files.CAFile, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureTLS(dir); err == nil {
		t.Fatal("expected invalid CA failure")
	}
}

func TestTLSUsesExplicitUserFiles(t *testing.T) {
	source := t.TempDir()
	files, err := EnsureTLS(source)
	if err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	user, err := ResolveTLS(TLSOptions{
		DataDir:  target,
		CertFile: files.CertFile,
		KeyFile:  files.KeyFile,
		CAFile:   files.CAFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !user.User || user.Generated || user.CertFile != files.CertFile {
		t.Fatalf("unexpected user TLS result: %+v", user)
	}
	if _, err := os.Stat(filepath.Join(target, "tls", "relay.crt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("explicit user files should not create default TLS files")
	}
	if _, err := ResolveTLS(TLSOptions{DataDir: target, CertFile: files.CertFile}); err == nil {
		t.Fatal("expected cert/key pairing error")
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
