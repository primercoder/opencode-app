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
)

const version = "1.0.0"

func main() {
	var err error
	if len(os.Args) < 2 {
		err = runServe(nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}
	first := os.Args[1]
	switch first {
	case "serve":
		// Hidden compatibility alias for older service files.
		err = runServe(os.Args[2:])
	case "admin":
		err = runAdmin(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		if strings.HasPrefix(first, "-") {
			err = runServe(os.Args[1:])
			break
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", first)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `ocremote-relay %s — encrypted relay for OC Remote

Usage:
  ocremote-relay [options]              start the relay
  ocremote-relay admin <command>        inspect or revoke subjects
  ocremote-relay version

Start options:
  --data-dir <dir>        data directory (default ./data, env RELAY_DATA_DIR)
  --listen <addr>         listen address (default :8443, env RELAY_LISTEN)
  --public-url <url>      public ws:// or wss:// URL placed in phone invites
  --tls-cert <pem>        optional TLS certificate
  --tls-key <pem>         optional TLS private key
  --max-hosts <n>         active hosts (default 3, env RELAY_MAX_HOSTS)
  --max-clients <n>       phones per host room (default 3, env RELAY_MAX_CLIENTS)
  --admin-socket <path>   admin Unix socket (default <data-dir>/admin.sock)
  --log-level <level>     debug|info|warn|error (default info)

Admin commands:
  status                  relay state and limits
  hosts                   registered host identities
  clients                 registered phone identities
  rooms                   rooms and current occupancy
  revoke <subjectId>      revoke a host or phone identity

Examples:
  # Public IP, Noise NK authentication, no certificate needed
  ocremote-relay --listen 0.0.0.0:8443 \
    --public-url ws://203.0.113.10:8443/ws

  # Optional TLS in front of the same Noise protocol
  ocremote-relay --listen 0.0.0.0:8443 \
    --public-url wss://relay.example.com/ws \
    --tls-cert /etc/ocremote/fullchain.pem \
    --tls-key /etc/ocremote/privkey.pem

  # Allow at most 3 hosts, 3 phones per host
  ocremote-relay --max-hosts 3 --max-clients 3

  ocremote-relay admin status
  ocremote-relay admin rooms
  ocremote-relay admin revoke sub_1234

Host connection:
  Hosts connect with only the relay IP and port, for example:
    ocremote relay 203.0.113.10:8443
  Any OC Remote host that implements the relay protocol may register until
  --max-hosts is reached. Phone invites are created only when a host pairs.

Environment:
  RELAY_DATA_DIR, RELAY_LISTEN, RELAY_PUBLIC_URL, RELAY_ADMIN_SOCKET,
  RELAY_MAX_HOSTS, RELAY_MAX_CLIENTS, RELAY_LOG_LEVEL,
  RELAY_TLS_CERT, RELAY_TLS_KEY
`, version)
}

func runServe(args []string) error {
	flags := flag.NewFlagSet("ocremote-relay", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	listen := flags.String("listen", env("RELAY_LISTEN", ":8443"), "listen address")
	publicURL := flags.String("public-url", env("RELAY_PUBLIC_URL", ""), "public ws(s) URL")
	certFile := flags.String("tls-cert", env("RELAY_TLS_CERT", ""), "TLS certificate")
	keyFile := flags.String("tls-key", env("RELAY_TLS_KEY", ""), "TLS private key")
	maxHosts := flags.Int("max-hosts", envInt("RELAY_MAX_HOSTS", 3), "active hosts")
	maxClients := flags.Int("max-clients", envInt("RELAY_MAX_CLIENTS", 3), "phones per room")
	adminSocket := flags.String("admin-socket", env("RELAY_ADMIN_SOCKET", ""), "admin Unix socket")
	level := flags.String("log-level", env("RELAY_LOG_LEVEL", "info"), "log level")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *maxHosts <= 0 {
		return errors.New("--max-hosts must be greater than zero")
	}
	if *maxClients <= 0 {
		return errors.New("--max-clients must be greater than zero")
	}
	if (*certFile == "") != (*keyFile == "") {
		return errors.New("--tls-cert and --tls-key must be provided together")
	}

	logger := newLogger(*level)
	slog.SetDefault(logger)

	if *publicURL == "" {
		*publicURL = derivePublicURL(*listen, *certFile != "")
		if strings.Contains(*publicURL, "://127.0.0.1") || strings.Contains(*publicURL, "://localhost") {
			fmt.Fprintf(os.Stderr, "warning: --public-url is not set; phone invites will use %s. Pass the public IP or domain for remote hosts.\n", *publicURL)
		}
	}
	if *certFile != "" {
		if _, err := relay.ResolveTLS(relay.TLSOptions{
			DataDir:  *dataDir,
			CertFile: *certFile,
			KeyFile:  *keyFile,
			Host:     relay.TLSHostFromURL(*publicURL, *listen),
		}); err != nil {
			return fmt.Errorf("relay TLS: %w", err)
		}
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
	server := relay.New(relay.Config{
		Store:      store,
		PublicURL:  *publicURL,
		RelayKey:   relayKey,
		MaxHosts:   *maxHosts,
		MaxClients: *maxClients,
	})

	socket := *adminSocket
	if socket == "" {
		socket = filepath.Join(*dataDir, "admin.sock")
	}
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

	hosts, _ := store.ActiveHostCount()
	fmt.Printf("ocremote-relay %s\n", version)
	fmt.Printf("relay id   %s\n", store.RelayID())
	fmt.Printf("listen     %s\n", *listen)
	fmt.Printf("ws url     %s\n", *publicURL)
	if *certFile == "" {
		fmt.Printf("tls        off (Noise NK still encrypts auth and control frames)\n")
	} else {
		fmt.Printf("tls        on (%s)\n", *certFile)
	}
	fmt.Printf("hosts      %d/%d active\n", hosts, *maxHosts)
	fmt.Printf("phones     %d per host\n", *maxClients)
	fmt.Printf("data       %s\n", *dataDir)
	fmt.Printf("admin      %s\n", socket)
	fmt.Println()

	slog.Info("ocremote relay listening", "addr", *listen, "publicUrl", *publicURL, "relayId", store.RelayID(), "tls", *certFile != "", "maxHosts", *maxHosts, "maxClients", *maxClients)
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

func runAdmin(args []string) error {
	flags := flag.NewFlagSet("admin", flag.ContinueOnError)
	dataDir := flags.String("data-dir", env("RELAY_DATA_DIR", "./data"), "data directory")
	socket := flags.String("admin-socket", env("RELAY_ADMIN_SOCKET", ""), "admin Unix socket")
	publicURL := flags.String("public-url", env("RELAY_PUBLIC_URL", ""), "public ws(s) URL")
	jsonOut := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	rest := flags.Args()
	if len(rest) == 0 {
		return errors.New("missing admin command (status|hosts|clients|rooms|revoke)")
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
		if *publicURL == "" {
			*publicURL = derivePublicURL(":8443", false)
		}
		client = &directAdmin{store: store, publicURL: *publicURL}
	}

	switch command {
	case "status":
		status, err := client.status()
		if err != nil {
			return err
		}
		if *jsonOut {
			return printValue(status, true)
		}
		return printStatus(status)
	case "hosts":
		data, err := client.subjects()
		if err != nil {
			return err
		}
		return printSubjects(data, relay.KindHost, *jsonOut)
	case "clients":
		data, err := client.subjects()
		if err != nil {
			return err
		}
		return printSubjects(data, relay.KindClient, *jsonOut)
	case "rooms":
		data, err := client.rooms()
		if err != nil {
			return err
		}
		return printValue(data, true)
	case "revoke":
		if len(rest) < 2 {
			return errors.New("revoke needs a subject id")
		}
		subject, err := client.revoke(rest[1])
		if err != nil {
			return err
		}
		return printValue(subject, *jsonOut)
	default:
		return fmt.Errorf("unknown admin command %q", command)
	}
}

func printSubjects(data []relay.Subject, kind string, asJSON bool) error {
	filtered := make([]relay.Subject, 0, len(data))
	for _, subject := range data {
		if subject.Kind == kind {
			filtered = append(filtered, subject)
		}
	}
	if asJSON {
		return printValue(filtered, true)
	}
	if len(filtered) == 0 {
		fmt.Printf("no %s subjects\n", kind)
		return nil
	}
	if kind == relay.KindHost {
		fmt.Printf("%-24s %-20s %-24s %-18s %-10s %s\n", "ID", "NAME", "HOST ID", "ROOM", "SEEN", "STATE")
		for _, subject := range filtered {
			fmt.Printf("%-24s %-20s %-24s %-18s %-10s %s\n", subject.ID, subject.Name, subject.HostID, subject.Room, formatTime(subject.LastSeenAt), subjectState(subject))
		}
		return nil
	}
	fmt.Printf("%-24s %-20s %-18s %-10s %s\n", "ID", "NAME", "ROOM", "SEEN", "STATE")
	for _, subject := range filtered {
		fmt.Printf("%-24s %-20s %-18s %-10s %s\n", subject.ID, subject.Name, subject.Room, formatTime(subject.LastSeenAt), subjectState(subject))
	}
	return nil
}

func subjectState(subject relay.Subject) string {
	if subject.RevokedAt > 0 {
		return "revoked"
	}
	return "active"
}

func printStatus(value map[string]any) error {
	fmt.Printf("relay id   %v\n", value["relayId"])
	fmt.Printf("version    %v\n", value["v"])
	fmt.Printf("ws url     %v\n", value["wsUrl"])
	fmt.Printf("hosts      %v/%v active\n", value["hosts"], value["maxHosts"])
	fmt.Printf("phones     %v per host\n", value["maxClients"])
	if rooms, ok := value["rooms"].([]any); ok {
		fmt.Printf("rooms      %d\n", len(rooms))
	}
	return nil
}

type adminAPI interface {
	status() (map[string]any, error)
	subjects() ([]relay.Subject, error)
	rooms() (any, error)
	revoke(subjectID string) (any, error)
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

func (a *httpAdmin) status() (map[string]any, error) {
	var value map[string]any
	return value, a.call(http.MethodGet, "/v1/admin/status", nil, &value)
}

func (a *httpAdmin) subjects() ([]relay.Subject, error) {
	var response struct {
		Data []relay.Subject `json:"data"`
	}
	return response.Data, a.call(http.MethodGet, "/v1/admin/subjects", nil, &response)
}

func (a *httpAdmin) rooms() (any, error) {
	var value any
	return value, a.call(http.MethodGet, "/v1/admin/rooms", nil, &value)
}

func (a *httpAdmin) revoke(subjectID string) (any, error) {
	var value any
	return value, a.call(http.MethodPost, "/v1/admin/revoke", map[string]any{"subjectId": subjectID}, &value)
}

type directAdmin struct {
	store     *relay.Store
	publicURL string
}

func (a *directAdmin) status() (map[string]any, error) {
	subjects, err := a.store.ListSubjects()
	if err != nil {
		return nil, err
	}
	rooms, err := a.store.ListRooms()
	if err != nil {
		return nil, err
	}
	hosts, clients := 0, 0
	for _, subject := range subjects {
		if subject.RevokedAt > 0 {
			continue
		}
		if subject.Kind == relay.KindHost {
			hosts++
		} else {
			clients++
		}
	}
	return map[string]any{
		"relayId":      a.store.RelayID(),
		"v":            3,
		"wsUrl":        a.publicURL,
		"hosts":        hosts,
		"maxHosts":     envInt("RELAY_MAX_HOSTS", 3),
		"clients":      clients,
		"maxClients":   envInt("RELAY_MAX_CLIENTS", 3),
		"rooms":        rooms,
		"offline":      true,
		"protocolNote": "relay is not running; limits are shown from the saved configuration",
	}, nil
}

func (a *directAdmin) subjects() ([]relay.Subject, error) { return a.store.ListSubjects() }
func (a *directAdmin) rooms() (any, error)                { return a.store.ListRooms() }

func (a *directAdmin) revoke(subjectID string) (any, error) {
	subject, err := a.store.RevokeSubject(subjectID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": subject.ID, "kind": subject.Kind, "revokedAt": subject.RevokedAt, "note": "relay is not running; live connections are already gone"}, nil
}

func derivePublicURL(listen string, tls bool) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		host, port = "127.0.0.1", "8443"
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

func printValue(value any, _ bool) error {
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
