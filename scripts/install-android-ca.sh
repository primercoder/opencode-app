#!/usr/bin/env bash
set -euo pipefail

# Install the relay's CA certificate into the Android system trust store.
# Requires a rooted device/emulator and a writable system partition.
#
#   ./scripts/install-android-ca.sh relay-data/tls/ca.crt [serial]
#
# Android expects system CA files to be named <subject_hash_old>.0.

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <ca.crt> [device-serial]" >&2
  exit 2
fi

CA_SOURCE=$1
SERIAL=${2:-}
ADB=(adb)
if [[ -n "$SERIAL" ]]; then
  ADB+=(-s "$SERIAL")
fi

if [[ ! -f "$CA_SOURCE" ]]; then
  echo "CA certificate not found: $CA_SOURCE" >&2
  exit 1
fi

HASH=$(openssl x509 -in "$CA_SOURCE" -subject_hash_old -noout | head -n 1)
if [[ -z "$HASH" ]]; then
  echo "could not compute the CA subject hash" >&2
  exit 1
fi

"${ADB[@]}" root >/dev/null 2>&1 || true
sleep 1
if ! "${ADB[@]}" remount >/dev/null 2>&1; then
  echo "adb remount failed; trying a direct system remount..." >&2
  if ! "${ADB[@]}" shell mount -o rw,remount /system >/dev/null 2>&1; then
    echo "could not make /system writable. Use a rooted device/emulator with an unlocked bootloader, or disable dm-verity first." >&2
    exit 1
  fi
fi

TARGET="/system/etc/security/cacerts/${HASH}.0"
TMP="/data/local/tmp/ocremote-ca-${HASH}.0"
"${ADB[@]}" push "$CA_SOURCE" "$TMP" >/dev/null
"${ADB[@]}" shell "mkdir -p /system/etc/security/cacerts && cp '$TMP' '$TARGET' && chmod 644 '$TARGET' && chown root:root '$TARGET' && rm -f '$TMP'"
"${ADB[@]}" shell "stop; start" >/dev/null 2>&1 || true

echo "installed $CA_SOURCE as $TARGET"
echo "If the app still rejects the relay, reboot the device and reopen the app."
