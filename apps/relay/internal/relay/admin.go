package relay

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type publicSubject struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Room       string `json:"room,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt,omitempty"`
	RevokedAt  int64  `json:"revokedAt,omitempty"`
}

type roomStatus struct {
	ID            string `json:"id"`
	HostSubjectID string `json:"hostSubjectId"`
	Name          string `json:"name"`
	HostOnline    bool   `json:"hostOnline"`
	Clients       int    `json:"clients"`
}

func toPublicSubject(subject Subject) publicSubject {
	return publicSubject{
		ID:         subject.ID,
		Kind:       subject.Kind,
		Name:       subject.Name,
		Room:       subject.Room,
		CreatedAt:  subject.CreatedAt,
		LastSeenAt: subject.LastSeenAt,
		RevokedAt:  subject.RevokedAt,
	}
}

// RoomStatus returns persisted rooms with live connection counts.
func (s *Server) RoomStatus() ([]roomStatus, error) {
	rooms, err := s.cfg.Store.ListRooms()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	live := make(map[string]*room, len(s.rooms))
	for id, value := range s.rooms {
		live[id] = value
	}
	s.mu.Unlock()
	result := make([]roomStatus, 0, len(rooms))
	for _, value := range rooms {
		status := roomStatus{ID: value.ID, HostSubjectID: value.HostSubjectID, Name: value.Name}
		if current, ok := live[value.ID]; ok {
			current.mu.Lock()
			status.HostOnline = current.host != nil
			status.Clients = len(current.clients)
			current.mu.Unlock()
		}
		result = append(result, status)
	}
	return result, nil
}

// ServerStatus is a snapshot used by the admin CLI.
func (s *Server) ServerStatus() map[string]any {
	rooms, _ := s.RoomStatus()
	subjects, _ := s.cfg.Store.ListSubjects()
	hosts, clients := 0, 0
	for _, subject := range subjects {
		if subject.RevokedAt > 0 {
			continue
		}
		if subject.Kind == KindHost {
			hosts++
		} else {
			clients++
		}
	}
	return map[string]any{
		"relayId":      s.cfg.Store.RelayID(),
		"v":            ProtocolVersion,
		"wsUrl":        s.cfg.PublicURL,
		"hosts":        hosts,
		"clients":      clients,
		"rooms":        rooms,
		"adminSocket":  "",
		"generatedAt":  time.Now().Unix(),
		"protocolNote": "relay v3: one-time invites, Noise NK authentication, long-lived subjects",
	}
}

func (s *Server) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/admin/status", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodGet) {
			return
		}
		writeJSON(w, http.StatusOK, s.ServerStatus())
	})
	mux.HandleFunc("/v1/admin/subjects", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodGet) {
			return
		}
		subjects, err := s.cfg.Store.ListSubjects()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		data := make([]publicSubject, 0, len(subjects))
		for _, subject := range subjects {
			data = append(data, toPublicSubject(subject))
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": data})
	})
	mux.HandleFunc("/v1/admin/invites", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodGet, http.MethodPost) {
			return
		}
		if r.Method == http.MethodGet {
			invites, err := s.cfg.Store.ListInvites()
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"data": invites})
			return
		}
		var body struct {
			Kind    string `json:"kind"`
			Name    string `json:"name"`
			Expires int64  `json:"expiresInSeconds"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if body.Kind != KindHost && body.Kind != KindClient {
			writeError(w, http.StatusBadRequest, relayError("RELAY_BAD_REQUEST", "kind must be host or client"))
			return
		}
		expiresAt := time.Time{}
		if body.Expires > 0 {
			expiresAt = time.Now().Add(time.Duration(body.Expires) * time.Second)
		}
		invite, token, err := s.cfg.Store.CreateInvite(body.Kind, body.Name, expiresAt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"invite": invite,
			"link":   s.InviteLink(body.Kind, token),
		})
	})
	mux.HandleFunc("/v1/admin/rotate", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodPost) {
			return
		}
		var body struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		invite, token, err := s.cfg.Store.RotateInvite(body.Kind, body.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"invite": invite,
			"link":   s.InviteLink(body.Kind, token),
		})
	})
	mux.HandleFunc("/v1/admin/revoke", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodPost) {
			return
		}
		var body struct {
			SubjectID string `json:"subjectId"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		subject, err := s.RevokeSubject(body.SubjectID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"subject": toPublicSubject(subject)})
	})
	mux.HandleFunc("/v1/admin/delete-invite", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodPost) {
			return
		}
		var body struct {
			Hash string `json:"hash"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := s.cfg.Store.DeleteInvite(body.Hash); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": body.Hash})
	})
	mux.HandleFunc("/v1/admin/rooms", func(w http.ResponseWriter, r *http.Request) {
		if !allowAdmin(w, r, http.MethodGet) {
			return
		}
		rooms, err := s.RoomStatus()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": rooms})
	})
	return mux
}

// ClientInvite issues a one-time phone link bound to a room. Hosts receive
// these from the relay and embed them in pairing offers.
func (s *Server) ClientInvite(roomID, name string) (string, error) {
	if name == "" {
		name = "phone"
	}
	_, token, err := s.cfg.Store.CreateRoomInvite(roomID, name, time.Now().Add(time.Hour))
	if err != nil {
		return "", err
	}
	return s.InviteLink(KindClient, token), nil
}

// InviteLink encodes a self-contained one-time enrollment link.
func (s *Server) InviteLink(kind, token string) string {
	return EncodeInviteLink(s.cfg.Store.RelayID(), s.cfg.PublicURL, kind, token, PublicKeyText(s.cfg.RelayKey))
}

// EncodeInviteLink builds the self-contained one-time enrollment link shared
// by the relay binary and the admin CLI.
func EncodeInviteLink(relayID, publicURL, kind, token, relayPublicKey string) string {
	payload := map[string]any{
		"v":       3,
		"kind":    kind,
		"url":     publicURL,
		"invite":  token,
		"relayId": relayID,
		"rk":      relayPublicKey,
	}
	raw, _ := json.Marshal(payload)
	return "ocremote-relay://enroll#" + base64.RawURLEncoding.EncodeToString(raw)
}

// ServeAdmin serves the admin API on a local Unix socket and returns the
// running server. The socket is owner-only.
func (s *Server) ServeAdmin(socketPath string) (*http.Server, net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return nil, nil, err
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return nil, nil, err
	}
	server := &http.Server{Handler: s.AdminHandler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// The caller observes failures through the listener; log loudly so
			// a broken admin socket is not silent.
			fmt.Fprintf(os.Stderr, "relay admin socket stopped: %v\n", err)
		}
	}()
	return server, listener, nil
}

func allowAdmin(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, method := range methods {
		if r.Method == method {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func decodeBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return relayError("RELAY_BAD_REQUEST", "invalid JSON body")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	code := "RELAY_INTERNAL"
	message := err.Error()
	var protocol *Error
	if errors.As(err, &protocol) {
		code = protocol.Code
		message = protocol.Message
	}
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}
