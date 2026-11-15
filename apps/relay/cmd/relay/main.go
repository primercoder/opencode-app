package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ocremote/relay/internal/relay"

	"github.com/flynn/noise"
)

const version = "0.3.0"

func main() {
	var err error
	if len(os.Args) < 2 {
		// No arguments: run the default wss relay (auto-created CA/cert).
		err = runServe(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}
	switch os.Args[1] {
	case "serve":
		err = runServe(os.Args[2:])
	case "init":
		err = runInit(os.Args[2:])
	case "admin":
		err = runAdmin(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `ocremote-relay %s

Usage:
  ocremote-relay                                  run the default wss relay (:8443)
  ocremote-relay init   [options]                 create relay identity and a host invite
  ocremote-relay serve  [options]                 run the relay (ws or wss)
  ocremote-relay admin  [options] <command> ...   manage subjects, invites and rooms

Serve options:
  --data-dir <dir>        data directory (default ./data, env RELAY_DATA_DIR)
  --listen <addr>         listen address (default :8443, env RELAY_LISTEN)
  --public-url <url>      public ws(s) URL placed in invites (env RELAY_PUBLIC_URL)
  --tls-cert <file>       user TLS certificate (PEM); wins over local files
  --tls-key <file>        user TLS private key (PEM)
  --tls-ca <file>         CA certificate used to verify the user certificate
  --rotate-tls            regenerate the local CA/certificate set
  --no-tls                serve plain ws (development only)
  --admin-socket <path>   admin Unix socket (default <data-dir>/admin.sock)
  --max-clients <n>       clients per room (default 8)
  --max-frame <bytes>     maximum websocket frame (default 1 MiB)
  --log-level <level>     debug|info|warn|error (default info)

Init options:
  --data-dir, --public-url, --name <host label>, --json
  --tls-cert, --tls-key, --tls-ca, --rotate-tls, --no-tls

Admin commands:
  status
  subjects [--kind host|client] [--json]
  invites [--json]
  rooms [--json]
  add-host  --name <label>
  add-client --name <label>                    legacy manual phone invite
  rotate    --kind host|client [--name <label>]
  revoke    <subjectId>
  delete-invite <hash>

Environment:
  RELAY_DATA_DIR, RELAY_LISTEN, RELAY_PUBLIC_URL, RELAY_ADMIN_SOCKET,
  RELAY_LOG_LEVEL, RELAY_MAX_CLIENTS, RELAY_MAX_FRAME,
  RELAY_TLS_CERT, RELAY_TLS_KEY, RELAY_TLS_CA, RELAY_TLS_OFF
`, version)
}

func runServe(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	listen := flags.String("listen", env("RELAY_LISTEN", ":8443"), "listen address")
	publicURL := flags.String("public-url", env("RELAY_PUBLIC_URL", ""), "public ws(s) URL")
	certFile := flags.String("tls-cert", env("RELAY_TLS_CERT", ""), "user TLS certificate")
	keyFile := flags.String("tls-key", env("RELAY_TLS_KEY", ""), "user TLS private key")
	caFile := flags.String("tls-ca", env("RELAY_TLS_CA", ""), "CA certificate for the user TLS certificate")
	rotateTLS := flags.Bool("rotate-tls", false, "regenerate the relay's local CA and certificate")
	noTLS := flags.Bool("no-tls", envBool("RELAY_TLS_OFF", false), "serve plain ws (development only)")
	adminSocket := flags.String("admin-socket", env("RELAY_ADMIN_SOCKET", ""), "admin Unix socket")
	maxClients := flags.Int("max-clients", envInt("RELAY_MAX_CLIENTS", 8), "clients per room")
	maxFrame := flags.Int64("max-frame", int64(envInt("RELAY_MAX_FRAME", 1024*1024)), "maximum frame")
	level := flags.String("log-level", env("RELAY_LOG_LEVEL", "info"), "log level")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if (*certFile == "") != (*keyFile == "") {
		return errors.New("--tls-cert and --tls-key must be provided together")
	}
	if *noTLS && (*certFile != "" || *caFile != "" || *rotateTLS) {
		return errors.New("--no-tls cannot be combined with TLS certificate options")
	}

	logger := newLogger(*level)
	slog.SetDefault(logger)

	store, err := relay.OpenStore(filepath.Join(*dataDir, "relay.db"))
	if err != nil {
		return err
	}
	defer store.Close()

	if *publicURL == "" {
		if *noTLS {
			*publicURL = derivePublicURL(*listen, false)
		} else {
			*publicURL = relay.DefaultPublicURL(*listen)
		}
	}

	// WSS is the default. Explicit user files win; complete files in
	// <data-dir>/tls are validated and reused; an empty directory is generated.
	if !*noTLS {
		files, err := relay.ResolveTLS(relay.TLSOptions{
			DataDir:  *dataDir,
			CertFile: *certFile,
			KeyFile:  *keyFile,
			CAFile:   *caFile,
			Rotate:   *rotateTLS,
			Host:     relay.TLSHostFromURL(*publicURL, *listen),
		})
		if err != nil {
			return fmt.Errorf("relay TLS: %w", err)
		}
		*certFile = files.CertFile
		*keyFile = files.KeyFile
		*caFile = files.CAFile
		switch {
		case files.Generated:
			slog.Info("generated relay TLS certificate", "ca", files.CAFile)
			fmt.Printf("\nRelay CA certificate:\n  %s\nInstall it in the Android system trust store so phones can verify wss://.\n\n", files.CAFile)
		case files.User:
			slog.Info("using user TLS certificate", "cert", files.CertFile, "ca", files.CAFile)
		default:
			slog.Info("using saved relay TLS certificate", "cert", files.CertFile, "ca", files.CAFile)
		}
	}
	socket := *adminSocket
	if socket == "" {
		socket = filepath.Join(*dataDir, "admin.sock")
	}

	relayKey, err := relay.LoadOrCreateRelayKey(*dataDir)
	if err != nil {
		return fmt.Errorf("relay identity: %w", err)
	}
	server := relay.New(relay.Config{
		Store:      store,
		PublicURL:  *publicURL,
		RelayKey:   relayKey,
		MaxClients: *maxClients,
		MaxFrame:   *maxFrame,
	})
	printFirstHostInvite(store, server)
	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	adminServer, listener, err := server.ServeAdmin(socket)
	if err != nil {
		return fmt.Errorf("admin socket: %w", err)
	}
	defer func() {
		_ = adminServer.Close()
		_ = listener.Close()
		_ = os.Remove(socket)
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
		server.Close()
	}()

	slog.Info("ocremote relay listening", "addr", *listen, "publicUrl", *publicURL, "relayId", store.RelayID(), "tls", *certFile != "")
	slog.Info("relay admin socket ready", "path", socket)

	var serveErr error
	if *certFile != "" {
		serveErr = httpServer.ListenAndServeTLS(*certFile, *keyFile)
	} else {
		serveErr = httpServer.ListenAndServe()
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return serveErr
	}
	return nil
}

func runInit(args []string) error {
	flags := flag.NewFlagSet("init", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	publicURL := flags.String("public-url", env("RELAY_PUBLIC_URL", ""), "public ws(s) URL")
	name := flags.String("name", env("RELAY_INVITE_NAME", ""), "host label for the first invite")
	jsonOut := flags.Bool("json", false, "print JSON")
	certFile := flags.String("tls-cert", env("RELAY_TLS_CERT", ""), "user TLS certificate")
	keyFile := flags.String("tls-key", env("RELAY_TLS_KEY", ""), "user TLS private key")
	caFile := flags.String("tls-ca", env("RELAY_TLS_CA", ""), "CA certificate for the user TLS certificate")
	rotateTLS := flags.Bool("rotate-tls", false, "regenerate the relay's local CA and certificate")
	noTLS := flags.Bool("no-tls", envBool("RELAY_TLS_OFF", false), "do not create or check TLS files")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *noTLS && (*certFile != "" || *caFile != "" || *rotateTLS) {
		return errors.New("--no-tls cannot be combined with TLS certificate options")
	}
	if *publicURL == "" {
		if *noTLS {
			*publicURL = derivePublicURL(":8443", false)
		} else {
			*publicURL = relay.DefaultPublicURL(":8443")
		}
	}

	var tlsFiles relay.TLSFiles
	if !*noTLS {
		files, err := relay.ResolveTLS(relay.TLSOptions{
			DataDir:  *dataDir,
			CertFile: *certFile,
			KeyFile:  *keyFile,
			CAFile:   *caFile,
			Rotate:   *rotateTLS,
			Host:     relay.TLSHostFromURL(*publicURL, ":8443"),
		})
		if err != nil {
			return fmt.Errorf("relay TLS: %w", err)
		}
		tlsFiles = files
	}

	store, err := relay.OpenStore(filepath.Join(*dataDir, "relay.db"))
	if err != nil {
		return err
	}
	defer store.Close()

	relayKey, err := relay.LoadOrCreateRelayKey(*dataDir)
	if err != nil {
		return fmt.Errorf("relay identity: %w", err)
	}
	server := relay.New(relay.Config{Store: store, PublicURL: *publicURL, RelayKey: relayKey})
	type inviteOutput struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		Link string `json:"link"`
	}
	outputs := make([]inviteOutput, 0, 1)

	subjects, err := store.ListSubjects()
	if err != nil {
		return err
	}
	haveHost := false
	for _, subject := range subjects {
		if subject.Kind == relay.KindHost && subject.RevokedAt == 0 {
			haveHost = true
			break
		}
	}
	if !haveHost {
		invite, token, err := store.CreateInvite(relay.KindHost, *name, time.Time{})
		if err != nil {
			return err
		}
		outputs = append(outputs, inviteOutput{Kind: relay.KindHost, Name: invite.Name, Link: server.InviteLink(relay.KindHost, token)})
	}

	if *jsonOut {
		raw, _ := json.MarshalIndent(map[string]any{
			"relayId":   store.RelayID(),
			"publicUrl": *publicURL,
			"invites":   outputs,
			"tls": map[string]any{
				"enabled":   !*noTLS,
				"generated": tlsFiles.Generated,
				"cert":      tlsFiles.CertFile,
				"ca":        tlsFiles.CAFile,
			},
		}, "", "  ")
		fmt.Println(string(raw))
		return nil
	}

	fmt.Printf("relay id   %s\n", store.RelayID())
	fmt.Printf("public url %s\n", *publicURL)
	if tlsFiles.CAFile != "" {
		fmt.Printf("relay ca   %s\n", tlsFiles.CAFile)
		if tlsFiles.Generated {
			fmt.Println("Generated a local CA and server certificate in <data-dir>/tls.")
		}
	}
	if len(outputs) == 0 {
		fmt.Println("nothing to do: a host invite already exists (use admin add-host to issue another one)")
		return nil
	}
	fmt.Println()
	fmt.Println("One-time host enrollment link (save it now; the relay stores only its hash):")
	for _, output := range outputs {
		fmt.Printf("\n%s invite:\n  %s\n", output.Kind, output.Link)
	}
	fmt.Println("\nEnroll the host: ./ocremote start --relay-link '<host link>'")
	fmt.Println("The host receives the phone relay link from the relay and puts it in the pairing code.")
	return nil
}

func runAdmin(args []string) error {
	flags := flag.NewFlagSet("admin", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	socket := flags.String("admin-socket", env("RELAY_ADMIN_SOCKET", ""), "admin Unix socket")
	jsonOut := flags.Bool("json", false, "print JSON")
	kind := flags.String("kind", "", "subject/invite kind (host|client)")
	name := flags.String("name", "", "label for a new invite")
	if err := flags.Parse(args); err != nil {
		return err
	}
	rest := flags.Args()
	if len(rest) == 0 {
		return errors.New("missing admin command (status|subjects|invites|rooms|add-host|add-client|rotate|revoke|delete-invite)")
	}
	command := rest[0]
	if *socket == "" {
		*socket = filepath.Join(*dataDir, "admin.sock")
	}

	client, running, err := newAdminClient(*socket)
	if err != nil {
		return err
	}
	if !running {
		store, err := relay.OpenStore(filepath.Join(*dataDir, "relay.db"))
		if err != nil {
			return fmt.Errorf("relay is not running and data store could not be opened: %w", err)
		}
		defer store.Close()
		relayKey, keyErr := relay.LoadOrCreateRelayKey(*dataDir)
		if keyErr != nil {
			return fmt.Errorf("relay identity: %w", keyErr)
		}
		client = &directAdmin{store: store, publicURL: env("RELAY_PUBLIC_URL", ""), relayKey: relayKey}
	}

	switch command {
	case "status":
		status, err := client.status()
		if err != nil {
			return err
		}
		return printValue(status, *jsonOut)
	case "subjects":
		data, err := client.subjects()
		if err != nil {
			return err
		}
		filtered := data[:0]
		for _, subject := range data {
			if *kind == "" || subject.Kind == *kind {
				filtered = append(filtered, subject)
			}
		}
		if *jsonOut {
			return printValue(filtered, true)
		}
		if len(filtered) == 0 {
			fmt.Println("no subjects")
			return nil
		}
		for _, subject := range filtered {
			state := "active"
			if subject.RevokedAt > 0 {
				state = "revoked"
			}
			fmt.Printf("%-8s %-10s %-24s room=%s seen=%s %s\n", subject.Kind, subject.ID, subject.Name, subject.Room, formatTime(subject.LastSeenAt), state)
		}
		return nil
	case "invites":
		data, err := client.invites()
		if err != nil {
			return err
		}
		if *jsonOut {
			return printValue(data, true)
		}
		if len(data) == 0 {
			fmt.Println("no invites")
			return nil
		}
		for _, invite := range data {
			state := "unused"
			if invite.ConsumedAt > 0 {
				state = "used by " + invite.ConsumedBy
			}
			fmt.Printf("%-8s %s %-16s hash=%s %s\n", invite.Kind, formatTime(invite.CreatedAt), invite.Name, invite.Hash[:16], state)
		}
		return nil
	case "rooms":
		data, err := client.rooms()
		if err != nil {
			return err
		}
		return printValue(data, *jsonOut)
	case "add-host", "add-client":
		inviteKind := relay.KindClient
		if command == "add-host" {
			inviteKind = relay.KindHost
		}
		link, err := client.addInvite(inviteKind, *name)
		if err != nil {
			return err
		}
		if *jsonOut {
			return printValue(map[string]any{"kind": inviteKind, "link": link}, true)
		}
		fmt.Println(link)
		return nil
	case "rotate":
		if *kind != relay.KindHost && *kind != relay.KindClient {
			return errors.New("rotate needs --kind host|client")
		}
		link, err := client.rotateInvite(*kind, *name)
		if err != nil {
			return err
		}
		if *jsonOut {
			return printValue(map[string]any{"kind": *kind, "link": link}, true)
		}
		fmt.Println(link)
		return nil
	case "revoke":
		if len(rest) < 2 {
			return errors.New("revoke needs a subject id")
		}
		subject, err := client.revoke(rest[1])
		if err != nil {
			return err
		}
		return printValue(subject, *jsonOut)
	case "delete-invite":
		if len(rest) < 2 {
			return errors.New("delete-invite needs an invite hash")
		}
		if err := client.deleteInvite(rest[1]); err != nil {
			return err
		}
		if !*jsonOut {
			fmt.Println("deleted")
		}
		return nil
	default:
		return fmt.Errorf("unknown admin command %q", command)
	}
}

type adminAPI interface {
	status() (any, error)
	subjects() ([]relay.Subject, error)
	invites() ([]relay.Invite, error)
	rooms() (any, error)
	addInvite(kind, name string) (string, error)
	rotateInvite(kind, name string) (string, error)
	revoke(subjectID string) (any, error)
	deleteInvite(hash string) error
}

type httpAdmin struct {
	client *http.Client
	base   string
}

func newAdminClient(socketPath string) (adminAPI, bool, error) {
	if _, err := os.Stat(socketPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	return &httpAdmin{client: &http.Client{Transport: transport, Timeout: 10 * time.Second}, base: "http://unix"}, true, nil
}

func (a *httpAdmin) call(method, path string, body any, target any) error {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = strings.NewReader(string(raw))
	}
	request, err := http.NewRequest(method, a.base+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := a.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if response.StatusCode >= 400 {
		var failure struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Message != "" {
			return fmt.Errorf("%s: %s", failure.Error, failure.Message)
		}
		return fmt.Errorf("admin request failed with HTTP %d", response.StatusCode)
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(raw, target)
}

func (a *httpAdmin) status() (any, error) {
	var value any
	return value, a.call(http.MethodGet, "/v1/admin/status", nil, &value)
}

func (a *httpAdmin) subjects() ([]relay.Subject, error) {
	var response struct {
		Data []relay.Subject `json:"data"`
	}
	return response.Data, a.call(http.MethodGet, "/v1/admin/subjects", nil, &response)
}

func (a *httpAdmin) invites() ([]relay.Invite, error) {
	var response struct {
		Data []relay.Invite `json:"data"`
	}
	return response.Data, a.call(http.MethodGet, "/v1/admin/invites", nil, &response)
}

func (a *httpAdmin) rooms() (any, error) {
	var value any
	return value, a.call(http.MethodGet, "/v1/admin/rooms", nil, &value)
}

func (a *httpAdmin) addInvite(kind, name string) (string, error) {
	var response struct {
		Link string `json:"link"`
	}
	err := a.call(http.MethodPost, "/v1/admin/invites", map[string]any{"kind": kind, "name": name}, &response)
	return response.Link, err
}

func (a *httpAdmin) rotateInvite(kind, name string) (string, error) {
	var response struct {
		Link string `json:"link"`
	}
	err := a.call(http.MethodPost, "/v1/admin/rotate", map[string]any{"kind": kind, "name": name}, &response)
	return response.Link, err
}

func (a *httpAdmin) revoke(subjectID string) (any, error) {
	var value any
	return value, a.call(http.MethodPost, "/v1/admin/revoke", map[string]any{"subjectId": subjectID}, &value)
}

func (a *httpAdmin) deleteInvite(hash string) error {
	return a.call(http.MethodPost, "/v1/admin/delete-invite", map[string]any{"hash": hash}, nil)
}

type directAdmin struct {
	store     *relay.Store
	publicURL string
	relayKey  noise.DHKey
}

func (a *directAdmin) status() (any, error) {
	subjects, err := a.store.ListSubjects()
	if err != nil {
		return nil, err
	}
	rooms, err := a.store.ListRooms()
	if err != nil {
		return nil, err
	}
	return map[string]any{"relayId": a.store.RelayID(), "hosts": len(subjects), "rooms": rooms, "offline": true}, nil
}

func (a *directAdmin) subjects() ([]relay.Subject, error) { return a.store.ListSubjects() }
func (a *directAdmin) invites() ([]relay.Invite, error)   { return a.store.ListInvites() }
func (a *directAdmin) rooms() (any, error)                { return a.store.ListRooms() }

func (a *directAdmin) addInvite(kind, name string) (string, error) {
	_, token, err := a.store.CreateInvite(kind, name, time.Time{})
	if err != nil {
		return "", err
	}
	return relay.EncodeInviteLink(a.store.RelayID(), a.publicURL, kind, token, relay.PublicKeyText(a.relayKey)), nil
}

func (a *directAdmin) rotateInvite(kind, name string) (string, error) {
	_, token, err := a.store.RotateInvite(kind, name)
	if err != nil {
		return "", err
	}
	return relay.EncodeInviteLink(a.store.RelayID(), a.publicURL, kind, token, relay.PublicKeyText(a.relayKey)), nil
}

func (a *directAdmin) revoke(subjectID string) (any, error) {
	subject, err := a.store.RevokeSubject(subjectID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": subject.ID, "kind": subject.Kind, "revokedAt": subject.RevokedAt, "note": "relay is not running; live connections are already gone"}, nil
}

func (a *directAdmin) deleteInvite(hash string) error { return a.store.DeleteInvite(hash) }

// printFirstHostInvite makes a parameterless relay usable immediately: if no
// host has enrolled and no host invite is pending, print one for the first host.
func printFirstHostInvite(store *relay.Store, server *relay.Server) {
	subjects, err := store.ListSubjects()
	if err != nil {
		return
	}
	for _, subject := range subjects {
		if subject.Kind == relay.KindHost && subject.RevokedAt == 0 {
			return
		}
	}
	if _, ok := store.Invite(relay.KindHost); ok {
		return
	}
	_, token, err := store.CreateInvite(relay.KindHost, "", time.Time{})
	if err != nil {
		return
	}
	fmt.Printf("\nFirst host invite (one-time):\n  %s\n\n", server.InviteLink(relay.KindHost, token))
}

func derivePublicURL(listen string, tls bool) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		host, port = "127.0.0.1", "8080"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	scheme := "ws"
	if tls {
		scheme = "wss"
	}
	if port == "" {
		return fmt.Sprintf("%s://%s/ws", scheme, host)
	}
	return fmt.Sprintf("%s://%s:%s/ws", scheme, host, port)
}

func printValue(value any, asJSON bool) error {
	if asJSON {
		raw, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(raw))
		return nil
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}

func formatTime(unix int64) string {
	if unix <= 0 {
		return "-"
	}
	return time.Unix(unix, 0).Format("2006-01-02 15:04")
}

func newLogger(level string) *slog.Logger {
	parsed := slog.LevelInfo
	switch strings.ToLower(level) {
	case "debug":
		parsed = slog.LevelDebug
	case "warn":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed}))
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
