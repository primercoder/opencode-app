package relay

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	KindHost   = "host"
	KindClient = "client"
)

var (
	bucketMeta     = []byte("meta")
	bucketInvites  = []byte("invites")
	bucketSubjects = []byte("subjects")
	bucketRooms    = []byte("rooms")
)

// Error is a relay-level protocol error that is safe to return to clients.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func relayError(code, message string) *Error {
	return &Error{Code: code, Message: message}
}

type Store struct {
	db *bolt.DB
}

type Invite struct {
	Hash       string `json:"hash"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Room       string `json:"room,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt,omitempty"`
	ConsumedAt int64  `json:"consumedAt,omitempty"`
	ConsumedBy string `json:"consumedBy,omitempty"`
}

type Subject struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	HostID     string `json:"hostId,omitempty"`
	SecretHash string `json:"secretHash"`
	Room       string `json:"room,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt,omitempty"`
	RevokedAt  int64  `json:"revokedAt,omitempty"`
}

type Room struct {
	ID            string `json:"id"`
	HostSubjectID string `json:"hostSubjectId"`
	Name          string `json:"name"`
	CreatedAt     int64  `json:"createdAt"`
}

func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	store := &Store{db: db}
	if err := db.Update(func(tx *bolt.Tx) error {
		for _, bucket := range [][]byte{bucketMeta, bucketInvites, bucketSubjects, bucketRooms} {
			if _, err := tx.CreateBucketIfNotExists(bucket); err != nil {
				return err
			}
		}
		meta := tx.Bucket(bucketMeta)
		if meta.Get([]byte("relayId")) == nil {
			if err := meta.Put([]byte("relayId"), []byte(randomID("relay_"))); err != nil {
				return err
			}
		}
		return meta.Put([]byte("schemaVersion"), []byte("2"))
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) RelayID() string {
	var id string
	_ = s.db.View(func(tx *bolt.Tx) error {
		id = string(tx.Bucket(bucketMeta).Get([]byte("relayId")))
		return nil
	})
	return id
}

func (s *Store) CreateInvite(kind, name string, expiresAt time.Time) (Invite, string, error) {
	return s.createInvite(kind, name, "", expiresAt)
}

// CreateRoomInvite mints a one-time phone invite that may only be consumed for
// the given host room. Relays issue these to connected hosts so the host can
// put the phone link into its pairing offer.
func (s *Store) CreateRoomInvite(roomID, name string, expiresAt time.Time) (Invite, string, error) {
	if roomID == "" {
		return Invite{}, "", relayError("RELAY_BAD_REQUEST", "room is required")
	}
	if _, ok := s.Room(roomID); !ok {
		return Invite{}, "", relayError("RELAY_ROOM_NOT_FOUND", "room does not exist")
	}
	return s.createInvite(KindClient, name, roomID, expiresAt)
}

func (s *Store) createInvite(kind, name, roomID string, expiresAt time.Time) (Invite, string, error) {
	if kind != KindHost && kind != KindClient {
		return Invite{}, "", relayError("RELAY_BAD_REQUEST", "invite kind must be host or client")
	}
	token := randomToken()
	invite := Invite{
		Hash:      hashToken(token),
		Kind:      kind,
		Name:      name,
		Room:      roomID,
		CreatedAt: time.Now().Unix(),
	}
	if !expiresAt.IsZero() {
		invite.ExpiresAt = expiresAt.Unix()
	}
	err := s.db.Update(func(tx *bolt.Tx) error {
		if roomID != "" {
			// Keep the invite set tidy: expired and consumed invites for this
			// room can never be used again.
			bucket := tx.Bucket(bucketInvites)
			var stale [][]byte
			if err := bucket.ForEach(func(key, value []byte) error {
				var existing Invite
				if err := json.Unmarshal(value, &existing); err != nil {
					return nil
				}
				expired := existing.ExpiresAt > 0 && existing.ExpiresAt <= time.Now().Unix()
				if existing.Room == roomID && (existing.ConsumedAt > 0 || expired) {
					stale = append(stale, append([]byte(nil), key...))
				}
				return nil
			}); err != nil {
				return err
			}
			for _, key := range stale {
				if err := bucket.Delete(key); err != nil {
					return err
				}
			}
		}
		raw, _ := json.Marshal(invite)
		return tx.Bucket(bucketInvites).Put([]byte(invite.Hash), raw)
	})
	if err != nil {
		return Invite{}, "", err
	}
	return invite, token, nil
}

func (s *Store) ListInvites() ([]Invite, error) {
	invites := make([]Invite, 0)
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketInvites).ForEach(func(_, value []byte) error {
			var invite Invite
			if err := json.Unmarshal(value, &invite); err != nil {
				return err
			}
			invites = append(invites, invite)
			return nil
		})
	})
	sort.Slice(invites, func(i, j int) bool { return invites[i].CreatedAt < invites[j].CreatedAt })
	return invites, err
}

func (s *Store) DeleteInvite(hash string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketInvites).Delete([]byte(hash))
	})
}

// EnrollHost registers any OC Remote host that presents a valid host hello.
// Hosts do not need a pre-issued invite. The number of active host identities
// is bounded by maxHosts, and a hostId may only own one active identity.
func (s *Store) EnrollHost(hostID, name string, maxHosts int) (Subject, string, error) {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return Subject{}, "", relayError("RELAY_BAD_REQUEST", "hostId is required")
	}
	if maxHosts <= 0 {
		maxHosts = 3
	}
	secret := randomToken()
	subject := Subject{
		ID:         randomID("sub_"),
		Kind:       KindHost,
		Name:       name,
		HostID:     hostID,
		SecretHash: hashToken(secret),
		Room:       randomID("room_"),
		CreatedAt:  time.Now().Unix(),
	}
	if subject.Name == "" {
		subject.Name = hostID
	}
	err := s.db.Update(func(tx *bolt.Tx) error {
		subjects := tx.Bucket(bucketSubjects)
		active := 0
		var duplicate error
		if err := subjects.ForEach(func(_, value []byte) error {
			var existing Subject
			if err := json.Unmarshal(value, &existing); err != nil {
				return nil
			}
			if existing.Kind != KindHost || existing.RevokedAt > 0 {
				return nil
			}
			active++
			if existing.HostID != "" && existing.HostID == hostID {
				duplicate = relayError("RELAY_HOST_EXISTS", "this host is already registered; revoke the old subject or restore its saved credentials")
			}
			return nil
		}); err != nil {
			return err
		}
		if duplicate != nil {
			return duplicate
		}
		if active >= maxHosts {
			return relayError("RELAY_HOST_LIMIT", "relay host limit reached")
		}
		rooms := tx.Bucket(bucketRooms)
		if rooms.Get([]byte(subject.Room)) != nil {
			subject.Room = randomID("room_")
		}
		room := Room{ID: subject.Room, HostSubjectID: subject.ID, Name: subject.Name, CreatedAt: time.Now().Unix()}
		roomRaw, _ := json.Marshal(room)
		if err := rooms.Put([]byte(subject.Room), roomRaw); err != nil {
			return err
		}
		subjectRaw, _ := json.Marshal(subject)
		return subjects.Put([]byte(subject.ID), subjectRaw)
	})
	if err != nil {
		return Subject{}, "", err
	}
	return subject, secret, nil
}

// ActiveHostCount returns non-revoked host identities.
func (s *Store) ActiveHostCount() (int, error) {
	count := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSubjects).ForEach(func(_, value []byte) error {
			var subject Subject
			if err := json.Unmarshal(value, &subject); err != nil {
				return nil
			}
			if subject.Kind == KindHost && subject.RevokedAt == 0 {
				count++
			}
			return nil
		})
	})
	return count, err
}

// Enroll consumes a one-time invite and creates a long-lived subject.
func (s *Store) Enroll(inviteToken, kind, name, roomID string, maxHosts int) (Subject, string, error) {
	if kind != KindHost && kind != KindClient {
		return Subject{}, "", relayError("RELAY_BAD_REQUEST", "subject kind must be host or client")
	}
	if inviteToken == "" {
		return Subject{}, "", relayError("RELAY_INVITE_INVALID", "invite is required")
	}
	secret := randomToken()
	subject := Subject{
		ID:         randomID("sub_"),
		Kind:       kind,
		Name:       name,
		SecretHash: hashToken(secret),
		CreatedAt:  time.Now().Unix(),
	}
	var invite Invite
	err := s.db.Update(func(tx *bolt.Tx) error {
		invites := tx.Bucket(bucketInvites)
		hash := hashToken(inviteToken)
		raw := invites.Get([]byte(hash))
		if raw == nil {
			return relayError("RELAY_INVITE_INVALID", "invite is not valid")
		}
		if err := json.Unmarshal(raw, &invite); err != nil {
			return err
		}
		if invite.Kind != kind {
			return relayError("RELAY_INVITE_INVALID", "invite is for a different endpoint type")
		}
		if invite.Room != "" && (kind != KindClient || roomID != invite.Room) {
			return relayError("RELAY_INVITE_INVALID", "invite is bound to a different room")
		}
		if invite.ConsumedAt > 0 {
			return relayError("RELAY_INVITE_CONSUMED", "invite has already been used")
		}
		if invite.ExpiresAt > 0 && time.Now().Unix() > invite.ExpiresAt {
			return relayError("RELAY_INVITE_EXPIRED", "invite has expired")
		}
		if name == "" {
			name = invite.Name
		}
		if name == "" {
			name = kind
		}
		subject.Name = name

		rooms := tx.Bucket(bucketRooms)
		if kind == KindHost {
			if maxHosts <= 0 {
				maxHosts = 3
			}
			active := 0
			if err := tx.Bucket(bucketSubjects).ForEach(func(_, value []byte) error {
				var existing Subject
				if err := json.Unmarshal(value, &existing); err != nil {
					return nil
				}
				if existing.Kind == KindHost && existing.RevokedAt == 0 {
					active++
				}
				return nil
			}); err != nil {
				return err
			}
			if active >= maxHosts {
				return relayError("RELAY_HOST_LIMIT", "relay host limit reached")
			}
			if roomID == "" {
				roomID = randomID("room_")
			}
			if rooms.Get([]byte(roomID)) != nil {
				return relayError("RELAY_ROOM_EXISTS", "room already exists")
			}
			subject.Room = roomID
			room := Room{ID: roomID, HostSubjectID: subject.ID, Name: subject.Name, CreatedAt: time.Now().Unix()}
			roomRaw, _ := json.Marshal(room)
			if err := rooms.Put([]byte(roomID), roomRaw); err != nil {
				return err
			}
		} else {
			// A client may connect to any room; record the first room it used
			// for display purposes only.
			room := rooms.Get([]byte(roomID))
			if room == nil {
				return relayError("RELAY_ROOM_NOT_FOUND", "room does not exist")
			}
			var value Room
			if err := json.Unmarshal(room, &value); err != nil {
				return err
			}
			hostRaw := tx.Bucket(bucketSubjects).Get([]byte(value.HostSubjectID))
			if hostRaw == nil {
				return relayError("RELAY_ROOM_NOT_FOUND", "room host is missing")
			}
			var host Subject
			if err := json.Unmarshal(hostRaw, &host); err != nil {
				return err
			}
			if host.RevokedAt > 0 {
				return relayError("RELAY_ROOM_NOT_FOUND", "room host has been revoked")
			}
			subject.Room = roomID
		}

		invite.ConsumedAt = time.Now().Unix()
		invite.ConsumedBy = subject.ID
		inviteRaw, _ := json.Marshal(invite)
		if err := invites.Put([]byte(invite.Hash), inviteRaw); err != nil {
			return err
		}
		subjectRaw, _ := json.Marshal(subject)
		return tx.Bucket(bucketSubjects).Put([]byte(subject.ID), subjectRaw)
	})
	if err != nil {
		return Subject{}, "", err
	}
	return subject, secret, nil
}

func (s *Store) AuthenticateSubject(id, secret, kind string) (Subject, error) {
	if id == "" || secret == "" {
		return Subject{}, relayError("RELAY_SUBJECT_INVALID", "subject id and secret are required")
	}
	var subject Subject
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSubjects).Get([]byte(id))
		if raw == nil {
			return relayError("RELAY_SUBJECT_INVALID", "subject is not registered")
		}
		return json.Unmarshal(raw, &subject)
	})
	if err != nil {
		return Subject{}, err
	}
	if subject.Kind != kind {
		return Subject{}, relayError("RELAY_SUBJECT_INVALID", "subject is for a different endpoint type")
	}
	if subject.RevokedAt > 0 {
		return Subject{}, relayError("RELAY_SUBJECT_REVOKED", "subject has been revoked")
	}
	expected := []byte(subject.SecretHash)
	actual := []byte(hashToken(secret))
	if len(expected) != len(actual) || subtle.ConstantTimeCompare(expected, actual) != 1 {
		return Subject{}, relayError("RELAY_SUBJECT_INVALID", "subject secret is invalid")
	}
	return subject, nil
}

func (s *Store) TouchSubject(id string) {
	_ = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSubjects)
		raw := bucket.Get([]byte(id))
		if raw == nil {
			return nil
		}
		var subject Subject
		if err := json.Unmarshal(raw, &subject); err != nil {
			return nil
		}
		subject.LastSeenAt = time.Now().Unix()
		updated, _ := json.Marshal(subject)
		return bucket.Put([]byte(id), updated)
	})
}

func (s *Store) Subject(id string) (Subject, bool) {
	var subject Subject
	found := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSubjects).Get([]byte(id))
		if raw == nil {
			return nil
		}
		found = json.Unmarshal(raw, &subject) == nil
		return nil
	})
	return subject, found
}

func (s *Store) ListSubjects() ([]Subject, error) {
	subjects := make([]Subject, 0)
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSubjects).ForEach(func(_, value []byte) error {
			var subject Subject
			if err := json.Unmarshal(value, &subject); err != nil {
				return err
			}
			subjects = append(subjects, subject)
			return nil
		})
	})
	sort.Slice(subjects, func(i, j int) bool { return subjects[i].CreatedAt < subjects[j].CreatedAt })
	return subjects, err
}

func (s *Store) RevokeSubject(id string) (Subject, error) {
	var revoked Subject
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSubjects)
		raw := bucket.Get([]byte(id))
		if raw == nil {
			return relayError("RELAY_SUBJECT_INVALID", "subject is not registered")
		}
		if err := json.Unmarshal(raw, &revoked); err != nil {
			return err
		}
		if revoked.RevokedAt > 0 {
			return relayError("RELAY_SUBJECT_REVOKED", "subject is already revoked")
		}
		revoked.RevokedAt = time.Now().Unix()
		updated, _ := json.Marshal(revoked)
		return bucket.Put([]byte(id), updated)
	})
	if err != nil {
		return Subject{}, err
	}
	return revoked, nil
}

func (s *Store) Room(id string) (Room, bool) {
	var room Room
	found := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketRooms).Get([]byte(id))
		if raw == nil {
			return nil
		}
		found = json.Unmarshal(raw, &room) == nil
		return nil
	})
	return room, found
}

func (s *Store) ListRooms() ([]Room, error) {
	rooms := make([]Room, 0)
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketRooms).ForEach(func(_, value []byte) error {
			var room Room
			if err := json.Unmarshal(value, &room); err != nil {
				return err
			}
			rooms = append(rooms, room)
			return nil
		})
	})
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].CreatedAt < rooms[j].CreatedAt })
	return rooms, err
}

// RoomAvailable reports whether clients may attach to a room: it must exist
// and its host subject must not be revoked.
func (s *Store) RoomAvailable(id string) (Room, error) {
	room, ok := s.Room(id)
	if !ok {
		return Room{}, relayError("RELAY_ROOM_NOT_FOUND", "room does not exist")
	}
	host, ok := s.Subject(room.HostSubjectID)
	if !ok {
		return Room{}, relayError("RELAY_ROOM_NOT_FOUND", "room host is missing")
	}
	if host.RevokedAt > 0 {
		return Room{}, relayError("RELAY_ROOM_NOT_FOUND", "room host has been revoked")
	}
	return room, nil
}

func (s *Store) RotateInvite(kind, name string) (Invite, string, error) {
	if kind != KindHost && kind != KindClient {
		return Invite{}, "", relayError("RELAY_BAD_REQUEST", "invite kind must be host or client")
	}
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketInvites)
		var stale [][]byte
		if err := bucket.ForEach(func(key, value []byte) error {
			var invite Invite
			if err := json.Unmarshal(value, &invite); err != nil {
				return nil
			}
			if invite.Kind == kind && invite.ConsumedAt == 0 {
				stale = append(stale, append([]byte(nil), key...))
			}
			return nil
		}); err != nil {
			return err
		}
		for _, key := range stale {
			if err := bucket.Delete(key); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Invite{}, "", err
	}
	return s.CreateInvite(kind, name, time.Time{})
}

func (s *Store) Invite(kind string) (Invite, bool) {
	var result Invite
	found := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketInvites).ForEach(func(_, value []byte) error {
			if found {
				return nil
			}
			var invite Invite
			if err := json.Unmarshal(value, &invite); err != nil {
				return nil
			}
			if invite.Kind == kind && invite.ConsumedAt == 0 {
				result = invite
				found = true
			}
			return nil
		})
	})
	return result, found
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomToken() string {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(data[:])
}

func randomID(prefix string) string {
	var data [12]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(data[:])
}

// IsProtocolError reports whether err carries a relay error code.
func IsProtocolError(err error) bool {
	var target *Error
	return errors.As(err, &target)
}

func ProtocolError(err error) *Error {
	var target *Error
	if errors.As(err, &target) {
		return target
	}
	return nil
}
