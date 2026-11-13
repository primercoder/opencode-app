package relay

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const ProtocolVersion = 2

type Config struct {
	Store        *Store
	PublicURL    string
	MaxClients   int
	MaxFrame     int64
	PingInterval time.Duration
	PongTimeout  time.Duration
	QueueSize    int
	HelloTimeout time.Duration
}

func (c *Config) normalize() {
	if c.MaxClients <= 0 {
		c.MaxClients = 8
	}
	if c.MaxFrame <= 0 {
		c.MaxFrame = 1024 * 1024
	}
	if c.PingInterval <= 0 {
		c.PingInterval = 20 * time.Second
	}
	if c.PongTimeout <= 0 {
		c.PongTimeout = 60 * time.Second
	}
	if c.QueueSize <= 0 {
		c.QueueSize = 64
	}
	if c.HelloTimeout <= 0 {
		c.HelloTimeout = 10 * time.Second
	}
}

type Server struct {
	cfg   Config
	mu    sync.Mutex
	rooms map[string]*room
}

type room struct {
	id            string
	hostSubjectID string

	mu           sync.Mutex
	host         *peer
	clients      map[uint32]*peer
	nextClientID uint32
}

type frame struct {
	kind websocket.MessageType
	data []byte
}

type peer struct {
	server    *Server
	room      *room
	role      string
	subjectID string
	id        uint32
	conn      *websocket.Conn
	out       chan frame
	done      chan struct{}
	once      sync.Once
}

type helloFrame struct {
	T         string `json:"t"`
	V         int    `json:"v"`
	Kind      string `json:"kind"`
	Invite    string `json:"invite"`
	SubjectID string `json:"subjectId"`
	Secret    string `json:"secret"`
	Name      string `json:"name"`
	Room      string `json:"room"`
}

func New(cfg Config) *Server {
	if cfg.Store == nil {
		panic("relay: Config.Store is required")
	}
	cfg.normalize()
	return &Server{cfg: cfg, rooms: make(map[string]*room)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready\n")
	})
	mux.HandleFunc("/v1/info", s.handleInfo)
	mux.HandleFunc("/v1/rooms", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGone)
		_, _ = io.WriteString(w, `{"error":"relay v2 requires an enrollment invite; see /v1/info"}`+"\n")
	})
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		rooms := len(s.rooms)
		s.mu.Unlock()
		subjects, _ := s.cfg.Store.ListSubjects()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "ocremote_relay_rooms %d\nocremote_relay_subjects %d\n", rooms, len(subjects))
	})
	return mux
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"relayId": s.cfg.Store.RelayID(),
		"v":       ProtocolVersion,
		"wsUrl":   s.publicWSURL(r),
	})
}

func (s *Server) publicWSURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "ws"
	if r.TLS != nil {
		scheme = "wss"
	}
	return scheme + "://" + r.Host + "/ws"
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if q := r.URL.Query(); len(q) > 0 {
		// Tokens never travel in the URL in v2. Reject legacy clients early so
		// they fail fast instead of hanging on an authentication frame.
		if q.Get("token") != "" || q.Get("role") != "" {
			http.Error(w, "relay v2 authenticates with the first websocket frame; upgrade the client", http.StatusUpgradeRequired)
			return
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		slog.Warn("websocket accept failed", "error", err)
		return
	}
	conn.SetReadLimit(s.cfg.MaxFrame + 4)

	p := &peer{
		server: s,
		conn:   conn,
		out:    make(chan frame, s.cfg.QueueSize),
		done:   make(chan struct{}),
	}

	hello, err := readHello(r.Context(), conn, s.cfg.HelloTimeout)
	if err != nil {
		p.sendProtocolError(err)
		p.close(websocket.StatusPolicyViolation, "invalid relay hello")
		return
	}

	var subject Subject
	var secret string
	var enrolled bool
	if hello.Invite != "" {
		subject, secret, err = s.cfg.Store.Enroll(hello.Invite, hello.Kind, hello.Name, hello.Room)
		enrolled = true
	} else {
		subject, err = s.cfg.Store.AuthenticateSubject(hello.SubjectID, hello.Secret, hello.Kind)
	}
	if err != nil {
		p.sendProtocolError(err)
		p.close(websocket.StatusPolicyViolation, "relay authentication failed")
		return
	}

	p.role = subject.Kind
	p.subjectID = subject.ID
	p.room = s.room(subject.Room)

	if p.role == KindClient {
		if _, err := s.cfg.Store.RoomAvailable(hello.Room); err != nil {
			p.sendProtocolError(err)
			p.close(websocket.StatusPolicyViolation, "room unavailable")
			return
		}
		p.room = s.room(hello.Room)
		clientID, ok := p.room.attachClient(p, s.cfg.MaxClients)
		if !ok {
			p.writeDirectJSON(map[string]any{"t": "relay.error", "code": "RELAY_ROOM_FULL", "message": "room has no host or is full"})
			p.close(websocket.StatusTryAgainLater, "room unavailable")
			return
		}
		p.id = clientID
	}

	welcome := map[string]any{
		"t":         "relay.welcome",
		"v":         ProtocolVersion,
		"kind":      p.role,
		"subjectId": subject.ID,
		"room":      p.room.id,
		"enrolled":  enrolled,
	}
	if enrolled {
		welcome["secret"] = secret
	}
	if p.role == KindHost {
		// A host never asks an administrator for a phone invite: the relay hands
		// it a fresh one-time phone link when it connects. The pairing offer
		// carries that link, so the phone enrolls automatically.
		welcome["caps"] = []string{"clientInvite"}
		if link, err := s.ClientInvite(p.room.id, subject.Name); err != nil {
			slog.Warn("relay could not issue a phone invite", "room", p.room.id, "error", err)
		} else {
			welcome["clientInvite"] = link
		}
	}
	// Flush the welcome synchronously: the write loop starts afterwards, and
	// the client must receive the subject secret even if it disconnects early.
	p.writeDirectJSON(welcome)

	if p.role == KindHost {
		if !p.room.attachHost(p) {
			p.close(websocket.StatusPolicyViolation, "host rejected")
			return
		}
	} else {
		p.writeDirectJSON(map[string]any{"t": "welcome", "clientId": p.id, "hostOnline": true})
	}

	s.cfg.Store.TouchSubject(subject.ID)
	slog.Info("relay peer connected", "subject", subject.ID, "kind", p.role, "room", p.room.id)

	go p.writeLoop()
	go p.pingLoop(s.cfg.PingInterval, s.cfg.PongTimeout)
	if p.role == KindClient {
		p.room.notifyHost(fmt.Sprintf(`{"t":"peer","clientId":%d,"role":"client"}`, p.id))
	}
	defer func() {
		if p.role == KindHost {
			p.room.detachHost(p)
		} else {
			p.room.detachClient(p)
		}
		p.close(websocket.StatusNormalClosure, "bye")
		slog.Info("relay peer disconnected", "subject", subject.ID, "kind", p.role)
	}()

	for {
		kind, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		if int64(len(data)) > s.cfg.MaxFrame {
			p.close(websocket.StatusMessageTooBig, "frame too large")
			return
		}
		if p.role == KindHost {
			if kind == websocket.MessageText {
				s.handleHostControl(p, data)
				continue
			}
			if kind != websocket.MessageBinary || len(data) < 4 {
				p.close(websocket.StatusMessageTooBig, "host frames require a client id")
				return
			}
			clientID := binary.BigEndian.Uint32(data[:4])
			p.room.deliver(clientID, data[4:])
		} else {
			// Clients may use text for the Noise handshake. Keep the payload
			// opaque and always forward it as prefixed host binary.
			p.room.deliverToHost(p.id, data)
		}
	}
}

func (s *Server) handleHostControl(p *peer, data []byte) {
	var message struct {
		T    string `json:"t"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &message); err != nil || message.T != "relay.invite" {
		p.sendJSON(map[string]any{
			"t":       "relay.error",
			"code":    "RELAY_BAD_REQUEST",
			"message": "unsupported host control frame",
		})
		return
	}
	name := strings.TrimSpace(message.Name)
	if name == "" {
		name = "phone"
	}
	link, err := s.ClientInvite(p.room.id, name)
	if err != nil {
		code := "RELAY_INTERNAL"
		text := err.Error()
		var protocol *Error
		if errors.As(err, &protocol) {
			code = protocol.Code
			text = protocol.Message
		}
		p.sendJSON(map[string]any{"t": "relay.error", "code": code, "message": text})
		return
	}
	p.sendJSON(map[string]any{
		"t":      "relay.invite",
		"v":      ProtocolVersion,
		"kind":   KindClient,
		"invite": link,
		"room":   p.room.id,
	})
}

func readHello(ctx context.Context, conn *websocket.Conn, timeout time.Duration) (helloFrame, error) {
	helloCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	kind, data, err := conn.Read(helloCtx)
	if err != nil {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "expected a relay.hello frame")
	}
	if kind != websocket.MessageText {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "relay.hello must be a text frame")
	}
	var hello helloFrame
	if err := json.Unmarshal(data, &hello); err != nil {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "relay.hello is not valid JSON")
	}
	if hello.T != "relay.hello" {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "first frame must be relay.hello")
	}
	if hello.V != 0 && hello.V != ProtocolVersion {
		return helloFrame{}, relayError("RELAY_VERSION", fmt.Sprintf("unsupported relay protocol version %d", hello.V))
	}
	if hello.Kind != KindHost && hello.Kind != KindClient {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "kind must be host or client")
	}
	if len(data) > 8*1024 {
		return helloFrame{}, relayError("RELAY_BAD_REQUEST", "relay.hello is too large")
	}
	return hello, nil
}

func (s *Server) room(id string) *room {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.rooms[id]; ok {
		return existing
	}
	value := &room{id: id, clients: make(map[uint32]*peer), nextClientID: 1}
	s.rooms[id] = value
	return value
}

func (s *Server) RevokeSubject(id string) (Subject, error) {
	subject, err := s.cfg.Store.RevokeSubject(id)
	if err != nil {
		return Subject{}, err
	}
	s.disconnectSubject(id)
	return subject, nil
}

func (s *Server) disconnectSubject(id string) {
	s.mu.Lock()
	rooms := make([]*room, 0, len(s.rooms))
	for _, value := range s.rooms {
		rooms = append(rooms, value)
	}
	s.mu.Unlock()
	for _, value := range rooms {
		value.disconnectSubject(id)
	}
}

func (s *Server) Close() {
	s.mu.Lock()
	rooms := make([]*room, 0, len(s.rooms))
	for _, value := range s.rooms {
		rooms = append(rooms, value)
	}
	s.mu.Unlock()
	for _, value := range rooms {
		value.closeAll()
	}
}

func (room *room) attachHost(p *peer) bool {
	room.mu.Lock()
	old := room.host
	room.host = p
	room.hostSubjectID = p.subjectID
	room.mu.Unlock()
	if old != nil {
		old.close(websocket.StatusPolicyViolation, "Replaced by new connection")
	}
	return true
}

func (room *room) detachHost(p *peer) {
	room.mu.Lock()
	if room.host == p {
		room.host = nil
	}
	clients := make([]*peer, 0, len(room.clients))
	for _, client := range room.clients {
		clients = append(clients, client)
	}
	room.clients = make(map[uint32]*peer)
	room.mu.Unlock()
	for _, client := range clients {
		client.close(websocket.StatusServiceRestart, "Server disconnected")
	}
}

func (room *room) attachClient(p *peer, max int) (uint32, bool) {
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.host == nil || len(room.clients) >= max {
		return 0, false
	}
	id := room.nextClientID
	room.nextClientID++
	if room.nextClientID == 0 {
		room.nextClientID = 1
	}
	room.clients[id] = p
	return id, true
}

func (room *room) detachClient(p *peer) {
	room.mu.Lock()
	if current, ok := room.clients[p.id]; ok && current == p {
		delete(room.clients, p.id)
	}
	room.mu.Unlock()
	room.notifyHost(fmt.Sprintf(`{"t":"peer.left","clientId":%d}`, p.id))
}

func (room *room) notifyHost(text string) {
	room.mu.Lock()
	host := room.host
	room.mu.Unlock()
	if host != nil {
		host.sendText(text)
	}
}

func (room *room) deliver(clientID uint32, payload []byte) {
	room.mu.Lock()
	client := room.clients[clientID]
	room.mu.Unlock()
	if client != nil {
		client.sendBinary(payload)
	}
}

func (room *room) deliverToHost(clientID uint32, payload []byte) {
	room.mu.Lock()
	host := room.host
	room.mu.Unlock()
	if host == nil {
		return
	}
	data := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(data, clientID)
	copy(data[4:], payload)
	host.sendBinary(data)
}

func (room *room) disconnectSubject(id string) {
	room.mu.Lock()
	host := room.host
	hostMatch := host != nil && host.subjectID == id
	var clients []*peer
	if hostMatch {
		clients = make([]*peer, 0, len(room.clients))
		for _, client := range room.clients {
			clients = append(clients, client)
		}
		room.clients = make(map[uint32]*peer)
		room.host = nil
	} else {
		for clientID, client := range room.clients {
			if client.subjectID == id {
				clients = append(clients, client)
				delete(room.clients, clientID)
			}
		}
	}
	room.mu.Unlock()
	if hostMatch {
		host.close(websocket.StatusPolicyViolation, "subject revoked")
	}
	for _, client := range clients {
		client.close(websocket.StatusPolicyViolation, "subject revoked")
	}
}

func (room *room) closeAll() {
	room.mu.Lock()
	host := room.host
	clients := make([]*peer, 0, len(room.clients))
	for _, client := range room.clients {
		clients = append(clients, client)
	}
	room.host = nil
	room.clients = make(map[uint32]*peer)
	room.mu.Unlock()
	if host != nil {
		host.close(websocket.StatusGoingAway, "relay shutting down")
	}
	for _, client := range clients {
		client.close(websocket.StatusGoingAway, "relay shutting down")
	}
}

func (p *peer) writeLoop() {
	for {
		select {
		case <-p.done:
			return
		case item := <-p.out:
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := p.conn.Write(ctx, item.kind, item.data)
			cancel()
			if err != nil {
				p.close(websocket.StatusTryAgainLater, "write failed")
				return
			}
		}
	}
}

func (p *peer) pingLoop(interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			err := p.conn.Ping(ctx)
			cancel()
			if err != nil {
				p.close(websocket.StatusPolicyViolation, "ping timeout")
				return
			}
		}
	}
}

func (p *peer) sendText(text string) {
	p.send(frame{kind: websocket.MessageText, data: []byte(text)})
}

func (p *peer) sendJSON(value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	p.send(frame{kind: websocket.MessageText, data: raw})
}

func (p *peer) sendProtocolError(err error) {
	code := "RELAY_BAD_REQUEST"
	message := err.Error()
	var protocol *Error
	if errors.As(err, &protocol) {
		code = protocol.Code
		message = protocol.Message
	}
	p.writeDirectJSON(map[string]any{"t": "relay.error", "code": code, "message": message})
}

func (p *peer) writeDirectJSON(value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = p.conn.Write(ctx, websocket.MessageText, raw)
}

func (p *peer) sendBinary(data []byte) {
	copied := append([]byte(nil), data...)
	p.send(frame{kind: websocket.MessageBinary, data: copied})
}

func (p *peer) send(item frame) {
	select {
	case <-p.done:
		return
	case p.out <- item:
		return
	default:
		p.close(websocket.StatusTryAgainLater, "slow consumer")
	}
}

func (p *peer) close(code websocket.StatusCode, reason string) {
	p.once.Do(func() {
		close(p.done)
		// coder/websocket waits for the close handshake. Never block the
		// handler goroutine on a peer that may be gone.
		go func() { _ = p.conn.Close(code, reason) }()
	})
}

func bearer(r *http.Request) string {
	value := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(value) > len(prefix) && strings.EqualFold(value[:len(prefix)], prefix) {
		return value[len(prefix):]
	}
	return ""
}
