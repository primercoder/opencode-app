package relay

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
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
	Generated bool
}

// EnsureTLS returns the relay's certificate files. When the caller does not
// provide --tls-cert/--tls-key, the relay creates a local CA and a server
// certificate on first run. The CA certificate can be installed in the Android
// system trust store; the server certificate covers localhost, the host name,
// relay.ocremote.test and every local IPv4/IPv6 address at creation time.
func EnsureTLS(dataDir string) (TLSFiles, error) {
	dir := filepath.Join(dataDir, "tls")
	files := TLSFiles{
		CertFile: filepath.Join(dir, "relay.crt"),
		KeyFile:  filepath.Join(dir, "relay.key"),
		CAFile:   filepath.Join(dir, "ca.crt"),
	}
	if usableTLS(files) {
		return files, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return TLSFiles{}, err
	}

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return TLSFiles{}, err
	}
	caSerial, err := randomSerial()
	if err != nil {
		return TLSFiles{}, err
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
		return TLSFiles{}, err
	}

	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return TLSFiles{}, err
	}
	serverSerial, err := randomSerial()
	if err != nil {
		return TLSFiles{}, err
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: serverSerial,
		Subject:      pkix.Name{CommonName: "ocremote-relay", Organization: []string{"OC Remote"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.AddDate(3, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     serverDNSNames(),
		IPAddresses:  serverIPs(),
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return TLSFiles{}, err
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		return TLSFiles{}, err
	}

	if err := writePEM(files.CAFile, "CERTIFICATE", caDER, 0o644); err != nil {
		return TLSFiles{}, err
	}
	if err := writePEM(files.CertFile, "CERTIFICATE", serverDER, 0o644); err != nil {
		return TLSFiles{}, err
	}
	if err := writeECKey(files.KeyFile, serverKey); err != nil {
		return TLSFiles{}, err
	}
	if err := writeECKey(filepath.Join(dir, "ca.key"), caKey); err != nil {
		return TLSFiles{}, err
	}
	// Fail early if the generated pair cannot be loaded.
	if _, err := tls.LoadX509KeyPair(files.CertFile, files.KeyFile); err != nil {
		return TLSFiles{}, err
	}
	files.Generated = true
	return files, nil
}

func usableTLS(files TLSFiles) bool {
	if _, err := os.Stat(files.CertFile); err != nil {
		return false
	}
	if _, err := os.Stat(files.KeyFile); err != nil {
		return false
	}
	if _, err := os.Stat(files.CAFile); err != nil {
		return false
	}
	pair, err := tls.LoadX509KeyPair(files.CertFile, files.KeyFile)
	if err != nil || len(pair.Certificate) == 0 {
		return false
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return false
	}
	return time.Now().Before(leaf.NotAfter.Add(-30 * 24 * time.Hour))
}

func serverDNSNames() []string {
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
	return names
}

func serverIPs() []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
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
