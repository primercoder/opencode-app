package relay

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TLSFiles describes the certificate set used by the relay.
type TLSFiles struct {
	CertFile  string
	KeyFile   string
	CAFile    string
	CAKeyFile string
	Generated bool
	User      bool
}

type TLSOptions struct {
	DataDir  string
	CertFile string
	KeyFile  string
	CAFile   string
	Rotate   bool
	// Host is the public host name or IP phones will use. It is validated
	// against the server certificate SAN so misconfiguration fails early.
	Host string
}

// EnsureTLS creates or reuses the default certificate set in <data-dir>/tls.
func EnsureTLS(dataDir string) (TLSFiles, error) {
	return ResolveTLS(TLSOptions{DataDir: dataDir})
}

// ResolveTLS applies the relay precedence rules:
//  1. explicit cert/key (+ optional CA) always wins and is validated;
//  2. complete files in <data-dir>/tls are validated and reused;
//  3. an empty directory gets a generated CA and server certificate;
//  4. partial or invalid directories are errors and are never overwritten
//     unless Rotate is explicitly requested.
func ResolveTLS(opts TLSOptions) (TLSFiles, error) {
	if (opts.CertFile == "") != (opts.KeyFile == "") {
		return TLSFiles{}, errors.New("--tls-cert and --tls-key must be provided together")
	}
	if opts.CertFile != "" {
		if opts.Rotate {
			return TLSFiles{}, errors.New("--rotate-tls cannot be used with an explicit --tls-cert/--tls-key")
		}
		if opts.CAFile != "" {
			ca, err := loadCertificate(opts.CAFile)
			if err != nil {
				return TLSFiles{}, fmt.Errorf("relay CA certificate: %w", err)
			}
			if err := validateCA(ca, nil); err != nil {
				return TLSFiles{}, fmt.Errorf("relay CA certificate: %w", err)
			}
			if _, err := validateServerPair(opts.CertFile, opts.KeyFile, ca, opts.Host); err != nil {
				return TLSFiles{}, err
			}
		} else if _, err := validateServerPair(opts.CertFile, opts.KeyFile, nil, opts.Host); err != nil {
			return TLSFiles{}, err
		}
		return TLSFiles{
			CertFile: opts.CertFile,
			KeyFile:  opts.KeyFile,
			CAFile:   opts.CAFile,
			User:     true,
		}, nil
	}
	if opts.CAFile != "" {
		return TLSFiles{}, errors.New("--tls-ca requires --tls-cert and --tls-key")
	}

	dir := filepath.Join(opts.DataDir, "tls")
	files := TLSFiles{
		CertFile:  filepath.Join(dir, "relay.crt"),
		KeyFile:   filepath.Join(dir, "relay.key"),
		CAFile:    filepath.Join(dir, "ca.crt"),
		CAKeyFile: filepath.Join(dir, "ca.key"),
	}
	existing, missing, err := existingTLSFiles(files)
	if err != nil {
		return TLSFiles{}, err
	}
	if opts.Rotate {
		for _, path := range existing {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return TLSFiles{}, fmt.Errorf("remove old TLS file %s: %w", path, err)
			}
		}
		existing, missing = nil, allTLSFiles(files)
	}
	if len(existing) == 0 {
		if err := generateTLS(files, opts.Host); err != nil {
			return TLSFiles{}, err
		}
		files.Generated = true
		if err := validateDefaultTLS(files, opts.Host); err != nil {
			return TLSFiles{}, err
		}
		return files, nil
	}
	if len(missing) > 0 {
		return TLSFiles{}, fmt.Errorf(
			"incomplete relay TLS directory %s; missing %s. Restore the missing files, pass --tls-cert/--tls-key, or use --rotate-tls to rebuild",
			dir,
			strings.Join(missing, ", "),
		)
	}
	if err := validateDefaultTLS(files, opts.Host); err != nil {
		return TLSFiles{}, fmt.Errorf(
			"relay TLS files in %s are invalid: %w. Replace them, pass --tls-cert/--tls-key, or use --rotate-tls",
			dir,
			err,
		)
	}
	return files, nil
}

func allTLSFiles(files TLSFiles) []string {
	return []string{files.CAFile, files.CAKeyFile, files.CertFile, files.KeyFile}
}

func existingTLSFiles(files TLSFiles) (existing []string, missing []string, err error) {
	for _, path := range allTLSFiles(files) {
		_, statErr := os.Stat(path)
		switch {
		case statErr == nil:
			existing = append(existing, path)
		case errors.Is(statErr, os.ErrNotExist):
			missing = append(missing, filepath.Base(path))
		default:
			return nil, nil, fmt.Errorf("check TLS file %s: %w", path, statErr)
		}
	}
	return existing, missing, nil
}

func validateDefaultTLS(files TLSFiles, host string) error {
	ca, err := loadCertificate(files.CAFile)
	if err != nil {
		return fmt.Errorf("CA certificate: %w", err)
	}
	caKey, err := loadPrivateKey(files.CAKeyFile)
	if err != nil {
		return fmt.Errorf("CA private key: %w", err)
	}
	if err := validateCA(ca, caKey); err != nil {
		return err
	}
	_, err = validateServerPair(files.CertFile, files.KeyFile, ca, host)
	return err
}

func validateServerPair(certFile, keyFile string, ca *x509.Certificate, host string) (*x509.Certificate, error) {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("server certificate/key: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return nil, errors.New("server certificate file is empty")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("server certificate: %w", err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) {
		return nil, fmt.Errorf("server certificate is not valid before %s", leaf.NotBefore.Format(time.RFC3339))
	}
	if now.After(leaf.NotAfter) {
		return nil, fmt.Errorf("server certificate expired at %s", leaf.NotAfter.Format(time.RFC3339))
	}
	if len(leaf.ExtKeyUsage) > 0 && !containsExtKeyUsage(leaf.ExtKeyUsage, x509.ExtKeyUsageServerAuth) {
		return nil, errors.New("server certificate is not valid for server authentication")
	}
	if ca != nil {
		if err := leaf.CheckSignatureFrom(ca); err != nil {
			return nil, fmt.Errorf("server certificate is not signed by the relay CA: %w", err)
		}
	}
	if err := certificateCoversHost(leaf, host); err != nil {
		return nil, err
	}
	return leaf, nil
}

func validateCA(ca *x509.Certificate, key crypto.Signer) error {
	now := time.Now()
	if !ca.IsCA {
		return errors.New("CA certificate is not a CA")
	}
	if ca.KeyUsage&x509.KeyUsageCertSign == 0 {
		return errors.New("CA certificate is missing the certificate-signing key usage")
	}
	if now.Before(ca.NotBefore) {
		return fmt.Errorf("CA certificate is not valid before %s", ca.NotBefore.Format(time.RFC3339))
	}
	if now.After(ca.NotAfter) {
		return fmt.Errorf("CA certificate expired at %s", ca.NotAfter.Format(time.RFC3339))
	}
	if key != nil && !publicKeysEqual(ca.PublicKey, key.Public()) {
		return errors.New("CA private key does not match the CA certificate")
	}
	return nil
}

func certificateCoversHost(ca *x509.Certificate, host string) error {
	host = strings.TrimSpace(strings.ToLower(strings.TrimSuffix(host, ".")))
	if host == "" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil {
		for _, candidate := range ca.IPAddresses {
			if candidate.Equal(ip) {
				return nil
			}
		}
		return fmt.Errorf("certificate does not cover IP %s", host)
	}
	for _, name := range ca.DNSNames {
		pattern := strings.ToLower(strings.TrimSuffix(name, "."))
		if pattern == host {
			return nil
		}
		if strings.HasPrefix(pattern, "*.") && strings.Count(host, ".") == strings.Count(pattern, ".") {
			if strings.HasSuffix(host, pattern[1:]) {
				return nil
			}
		}
	}
	return fmt.Errorf("certificate does not cover host %s", host)
}

func loadCertificate(path string) (*x509.Certificate, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("not a PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	return cert, nil
}

func loadPrivateKey(path string) (crypto.Signer, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("not a PEM private key")
	}
	switch block.Type {
	case "EC PRIVATE KEY":
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return key, nil
	case "RSA PRIVATE KEY":
		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return key, nil
	case "PRIVATE KEY":
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		signer, ok := key.(crypto.Signer)
		if !ok {
			return nil, errors.New("private key does not support signing")
		}
		return signer, nil
	default:
		return nil, fmt.Errorf("unsupported private key type %q", block.Type)
	}
}

func publicKeysEqual(left, right crypto.PublicKey) bool {
	a, err := x509.MarshalPKIXPublicKey(left)
	if err != nil {
		return false
	}
	b, err := x509.MarshalPKIXPublicKey(right)
	if err != nil {
		return false
	}
	return bytes.Equal(a, b)
}

func containsExtKeyUsage(values []x509.ExtKeyUsage, wanted x509.ExtKeyUsage) bool {
	for _, value := range values {
		if value == wanted || value == x509.ExtKeyUsageAny {
			return true
		}
	}
	return false
}

func generateTLS(files TLSFiles, host string) error {
	dir := filepath.Dir(files.CAFile)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	caSerial, err := randomSerial()
	if err != nil {
		return err
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber:          caSerial,
		Subject:               pkix.Name{CommonName: "OC Remote Relay CA", Organization: []string{"OC Remote"}},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return err
	}

	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serverSerial, err := randomSerial()
	if err != nil {
		return err
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: serverSerial,
		Subject:      pkix.Name{CommonName: "ocremote-relay", Organization: []string{"OC Remote"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.AddDate(3, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     serverDNSNames(host),
		IPAddresses:  serverIPs(host),
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	if err := writePEM(files.CAFile, "CERTIFICATE", caDER, 0o644); err != nil {
		return err
	}
	if err := writePEM(files.CertFile, "CERTIFICATE", serverDER, 0o644); err != nil {
		return err
	}
	if err := writeECKey(files.KeyFile, serverKey); err != nil {
		return err
	}
	if err := writeECKey(files.CAKeyFile, caKey); err != nil {
		return err
	}
	return nil
}

func serverDNSNames(extra string) []string {
	names := []string{"localhost", "relay.ocremote.test"}
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		hostname = strings.TrimSpace(hostname)
		if hostname != "" {
			names = append(names, hostname)
			if !strings.Contains(hostname, ".") {
				names = append(names, hostname+".local")
			}
		}
	}
	if extra != "" && net.ParseIP(extra) == nil {
		names = append(names, strings.ToLower(strings.TrimSuffix(extra, ".")))
	}
	return names
}

func serverIPs(extra string) []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	if ip := net.ParseIP(extra); ip != nil {
		ips = append(ips, ip)
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range interfaces {
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			var ip net.IP
			switch value := address.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip != nil && !ip.IsLoopback() {
				ips = append(ips, ip)
			}
		}
	}
	return ips
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func writePEM(path, blockType string, der []byte, mode os.FileMode) error {
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), mode)
}

func writeECKey(path string, key *ecdsa.PrivateKey) error {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	return writePEM(path, "EC PRIVATE KEY", der, 0o600)
}

// TLSHostFromURL extracts the host phones will use, falling back to the listen
// address/default public URL when no public URL is configured.
func TLSHostFromURL(publicURL, listen string) string {
	value := strings.TrimSpace(publicURL)
	if value == "" {
		value = DefaultPublicURL(listen)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

// DefaultPublicURL derives the URL to advertise when the relay was started
// without --public-url. A LAN address is preferred over loopback so a phone can
// use the link immediately.
func DefaultPublicURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		host, port = "", "8443"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = firstLANIP()
	}
	if port == "" {
		port = "8443"
	}
	return fmt.Sprintf("wss://%s/ws", net.JoinHostPort(host, port))
}

func firstLANIP() string {
	// Prefer the address used for outbound traffic; it is the one a phone on
	// the same network can normally reach. No packet is sent.
	if conn, err := net.Dial("udp4", "8.8.8.8:80"); err == nil {
		if address, ok := conn.LocalAddr().(*net.UDPAddr); ok && address.IP != nil && !address.IP.IsLoopback() {
			_ = conn.Close()
			return address.IP.String()
		}
		_ = conn.Close()
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			var ip net.IP
			switch value := address.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip4 := ip.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return "127.0.0.1"
}
