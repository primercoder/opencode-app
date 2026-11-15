package relay

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/flynn/noise"
)

const (
	relayNoisePrologue = "ocremote-relay-v3"
	relayControlPrefix = "n:"
)

// LoadOrCreateRelayKey persists the relay's Noise static key in the data
// directory. No X.509 certificate or external CA is involved.
func LoadOrCreateRelayKey(dataDir string) (noise.DHKey, error) {
	path := filepath.Join(dataDir, "relay-identity.json")
	raw, err := os.ReadFile(path)
	if err == nil {
		var value struct {
			V         int    `json:"v"`
			PublicKey string `json:"publicKey"`
			SecretKey string `json:"secretKey"`
		}
		if json.Unmarshal(raw, &value) == nil && value.V == 1 && value.PublicKey != "" && value.SecretKey != "" {
			publicKey, publicErr := base64.RawURLEncoding.DecodeString(value.PublicKey)
			secretKey, secretErr := base64.RawURLEncoding.DecodeString(value.SecretKey)
			if publicErr == nil && secretErr == nil && len(publicKey) == 32 && len(secretKey) == 32 {
				return noise.DHKey{Public: publicKey, Private: secretKey}, nil
			}
		}
		return noise.DHKey{}, fmt.Errorf("relay identity %s is invalid", path)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return noise.DHKey{}, err
	}

	key, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		return noise.DHKey{}, err
	}
	payload, err := json.MarshalIndent(map[string]any{
		"v":         1,
		"publicKey": base64.RawURLEncoding.EncodeToString(key.Public),
		"secretKey": base64.RawURLEncoding.EncodeToString(key.Private),
	}, "", "  ")
	if err != nil {
		return noise.DHKey{}, err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return noise.DHKey{}, err
	}
	if err := os.WriteFile(path, append(payload, '\n'), 0o600); err != nil {
		return noise.DHKey{}, err
	}
	return key, nil
}

func relayCipherSuite() noise.CipherSuite {
	return noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
}

func newRelayHandshake(key noise.DHKey) (*noise.HandshakeState, error) {
	if len(key.Public) != 32 || len(key.Private) != 32 {
		return nil, errors.New("relay Noise key must be 32 bytes")
	}
	return noise.NewHandshakeState(noise.Config{
		CipherSuite:   relayCipherSuite(),
		Pattern:       noise.HandshakeNK,
		Initiator:     false,
		Prologue:      []byte(relayNoisePrologue),
		StaticKeypair: key,
	})
}

func encryptRelayControl(state *noise.CipherState, plaintext []byte) (string, error) {
	ciphertext, err := state.Encrypt(nil, nil, plaintext)
	if err != nil {
		return "", err
	}
	return relayControlPrefix + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func decryptRelayControl(state *noise.CipherState, text string) ([]byte, error) {
	if len(text) < len(relayControlPrefix) || text[:len(relayControlPrefix)] != relayControlPrefix {
		return nil, errors.New("relay control frame is not encrypted")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(text[len(relayControlPrefix):])
	if err != nil {
		return nil, err
	}
	return state.Decrypt(nil, nil, ciphertext)
}

func PublicKeyText(key noise.DHKey) string {
	return base64.RawURLEncoding.EncodeToString(key.Public)
}

func relayKeyFromText(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("relay public key must be 32 base64url bytes")
	}
	return decoded, nil
}
