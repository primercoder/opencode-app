#!/usr/bin/env bash
# Generate a local development CA and relay certificate for full TLS testing.
#
# The certificate covers:
#   relay.ocremote.test, localhost, 127.0.0.1, 10.0.2.2 and the primary LAN IP
#
# Output: deploy/tls/{ca.crt,ca.key,relay.crt,relay.key,openssl.cnf}
# The CA is also copied into the Android "qa" source set so a QA APK can trust
# it. Release APKs never include this file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/deploy/tls}"
QA_RAW="$ROOT/apps/mobile/android/app/src/qa/res/raw"

LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="127.0.0.1"
fi

mkdir -p "$OUT"
chmod 700 "$OUT"

cat > "$OUT/openssl.cnf" <<EOF
[req]
distinguished_name = req_distinguished_name
prompt = no
req_extensions = v3_req

[req_distinguished_name]
CN = relay.ocremote.test

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = relay.ocremote.test
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = 10.0.2.2
IP.3 = $LAN_IP
EOF

if [[ ! -f "$OUT/ca.key" || ! -f "$OUT/ca.crt" ]]; then
  echo "generating development CA"
  openssl genrsa -out "$OUT/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -key "$OUT/ca.key" -sha256 -days 825 \
    -subj "/CN=OC Remote Development CA/O=OC Remote" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$OUT/ca.crt" 2>/dev/null
else
  echo "reusing existing development CA"
fi

echo "generating relay certificate for $LAN_IP"
openssl genrsa -out "$OUT/relay.key" 2048 2>/dev/null
openssl req -new -key "$OUT/relay.key" -out "$OUT/relay.csr" -config "$OUT/openssl.cnf" 2>/dev/null
openssl x509 -req -in "$OUT/relay.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -out "$OUT/relay.crt" -days 825 -sha256 \
  -extfile "$OUT/openssl.cnf" -extensions v3_req 2>/dev/null
rm -f "$OUT/relay.csr"

chmod 600 "$OUT"/*.key
chmod 644 "$OUT"/*.crt "$OUT/openssl.cnf"

mkdir -p "$QA_RAW"
cp "$OUT/ca.crt" "$QA_RAW/relay_test_ca.pem"
chmod 644 "$QA_RAW/relay_test_ca.pem"

cat <<EOF

TLS files written to $OUT
  CA certificate : $OUT/ca.crt
  relay cert/key : $OUT/relay.crt  $OUT/relay.key
  SAN            : relay.ocremote.test, localhost, 127.0.0.1, 10.0.2.2, $LAN_IP

Run the relay with:
  ./ocremote-relay --listen :8443 \\
    --public-url wss://relay.ocremote.test:8443/ws \\
    --tls-cert $OUT/relay.crt --tls-key $OUT/relay.key

Enroll the host with:
  ./ocremote relay relay.ocremote.test:8443 --ca $OUT/ca.crt

Verify manually:
  openssl s_client -connect 127.0.0.1:8443 -CAfile $OUT/ca.crt \\
    -verify_hostname relay.ocremote.test </dev/null
EOF
