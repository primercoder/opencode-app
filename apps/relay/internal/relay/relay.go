package relay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Config struct {
	RegistrationSecret string
	PublicURL          string
	MaxClients         int
	MaxFrame           int64
	RoomTTL            time.Duration
	PingInterval       time.Duration
	PongTimeout        time.Duration
	QueueSize          int
}

func (c *Config) normalize() {
	if c.MaxClients <= 0 {
		c.MaxClients = 8
	}
	if c.MaxFrame <= 0 {
		c.MaxFrame = 1024 * 1024
	}
	if c.RoomTTL <= 0 {
		c.RoomTTL = 30 * 24 * time.Hour
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
}

type Server struct {
	cfg   Config
	mu    sync.Mutex
	rooms map[string]*room
}

type room struct {
	id              string
	hostTokenHash   [32]byte
	clientTokenHash [32]byte
	expiresAt       time.Time

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
	server *Server
	room   *room
	role   string
	id     uint32
	conn   *websocket.Conn
	out    chan frame
	done   chan struct{}
	once   sync.Once
}

func New(cfg Config) *Server {
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
	mux.HandleFunc("/v1/rooms", s.handleRooms)
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		rooms := len(s.rooms)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "ocremote_relay_rooms %d\n", rooms)
	})
	return mux
}

func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.cfg.RegistrationSecret != "" && !constantEqual(bearer(r), s.cfg.RegistrationSecret) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		Room        string `json:"room"`
		HostToken   string `json:"hostToken"`
		ClientToken string `json:"clientToken"`
		TTL         int64  `json:"ttl"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if len(body.Room) < 8 || len(body.Room) > 128 || body.HostToken == "" || body.ClientToken == "" {
		http.Error(w, "invalid room or token", http.StatusBadRequest)
		return
	}
	ttl := time.Duration(body.TTL) * time.Second
	if ttl <= 0 || ttl > s.cfg.RoomTTL {
		ttl = s.cfg.RoomTTL
	}

	// Registration is an upsert: a host re-registers after a relay restart,
	// recreating the in-memory room with the same room id and tokens.
	s.mu.Lock()
	s.rooms[body.Room] = &room{
		id:              body.Room,
		hostTokenHash:   sha256.Sum256([]byte(body.HostToken)),
		clientTokenHash: sha256.Sum256([]byte(body.ClientToken)),
		expiresAt:       time.Now().Add(ttl),
		clients:         make(map[uint32]*peer),
		nextClientID:    1,
	}
	s.mu.Unlock()

	wsURL := s.cfg.PublicURL
	if wsURL == "" {
		wsURL = "ws://" + r.Host + "/ws"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"room": body.Room, "wsUrl": wsURL})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	role := q.Get("role")
	if role != "host" && role != "client" {
		http.Error(w, "invalid role", http.StatusBadRequest)
		return
	}
	if version := q.Get("v"); version != "" && version != "1" {
		http.Error(w, "unsupported protocol version", http.StatusBadRequest)
		return
	}
	roomID := q.Get("room")
	if roomID == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}
	room := s.room(roomID)
	if room == nil || time.Now().After(room.expiresAt) {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	token := bearer(r)
	if token == "" {
		// Browser/React Native WebSocket cannot set Authorization headers.
		token = q.Get("token")
	}
	if !room.authorized(role, token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		slog.Warn("websocket accept failed", "error", err)
		return
	}
	conn.SetReadLimit(s.cfg.MaxFrame + 4)

	p := &peer{
		server: s,
		room:   room,
		role:   role,
		conn:   conn,
		out:    make(chan frame, s.cfg.QueueSize),
		done:   make(chan struct{}),
	}
	if role == "client" {
		var ok bool
		p.id, ok = room.attachClient(p, s.cfg.MaxClients)
		if !ok {
			p.close(websocket.StatusTryAgainLater, "room is full")
			return
		}
	} else if !room.attachHost(p) {
		p.close(websocket.StatusPolicyViolation, "host rejected")
		return
	}

	go p.writeLoop()
	go p.pingLoop(s.cfg.PingInterval, s.cfg.PongTimeout)
	defer func() {
		if role == "host" {
			room.detachHost(p)
		} else {
			room.detachClient(p)
		}
		p.close(websocket.StatusNormalClosure, "bye")
	}()

	if role == "client" {
		p.sendText(fmt.Sprintf(`{"t":"welcome","clientId":%d,"hostOnline":true}`, p.id))
		room.notifyHost(fmt.Sprintf(`{"t":"peer","clientId":%d,"role":"client"}`, p.id))
	}

	for {
		kind, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		if int64(len(data)) > s.cfg.MaxFrame {
			p.close(websocket.StatusMessageTooBig, "frame too large")
			return
		}
		if role == "host" {
			if kind != websocket.MessageBinary || len(data) < 4 {
				p.close(websocket.StatusMessageTooBig, "host frames require a client id")
				return
			}
			clientID := binary.BigEndian.Uint32(data[:4])
			room.deliver(clientID, data[4:])
		} else {
			// Clients may use text for the initial Noise handshake. Keep the
			// payload opaque and always forward it as prefixed host binary.
			room.deliverToHost(p.id, data)
		}
	}
}

func (s *Server) room(id string) *room {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rooms[id]
}

func (room *room) authorized(role, token string) bool {
	hash := sha256.Sum256([]byte(token))
	expected := room.clientTokenHash
	if role == "host" {
		expected = room.hostTokenHash
	}
	return subtle.ConstantTimeCompare(hash[:], expected[:]) == 1
}

func (room *room) attachHost(p *peer) bool {
	room.mu.Lock()
	old := room.host
	room.host = p
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
	delete(room.clients, p.id)
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
		_ = p.conn.Close(code, reason)
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

func constantEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func randomID(prefix string) string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	return prefix + hex.EncodeToString(data[:])
}

