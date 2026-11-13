#!/usr/bin/env bash
# Builds a self-contained Linux release for the host. The result is a directory
# with a single `ocremote` command, a bundled Bun runtime and the sherpa-onnx
# native library. No Bun installation is required on the target machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/apps/host/package.json" | head -1)"
VERSION="${VERSION:-0.0.1}"
ARCH="${1:-x64}"
case "$ARCH" in
  x64|amd64) PLATFORM="linux-x64"; NPM_ARCH="x64" ;;
  arm64|aarch64) PLATFORM="linux-arm64"; NPM_ARCH="arm64" ;;
  *) echo "usage: $0 [x64|arm64]" >&2; exit 1 ;;
esac

WORK="$ROOT/.release/ocremote"
OUT="$ROOT/dist/ocremote-host-$VERSION-$PLATFORM"
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/app/node_modules" "$WORK/runtime"

echo "==> bundling host JavaScript"
cd "$ROOT/apps/host"
bun build --target bun --external 'sherpa-onnx-*' --outfile "$WORK/app/main.js" src/index.ts

echo "==> copying native runtime"
BUN_BIN="$(command -v bun)"
if [[ "$ARCH" == "arm64" && "$(uname -m)" != "aarch64" ]]; then
  if [[ -n "${BUN_ARM64:-}" ]]; then
    BUN_BIN="$BUN_ARM64"
  else
    echo "Cross-building the host arm64 bundle needs an arm64 Bun runtime." >&2
    echo "Set BUN_ARM64=/path/to/bun before running this script." >&2
    exit 1
  fi
fi
cp "$BUN_BIN" "$WORK/runtime/bun"
chmod +x "$WORK/runtime/bun"

echo "==> copying sherpa-onnx"
SHERPA_NODE="$(find "$ROOT/node_modules" -path '*/node_modules/sherpa-onnx-node/package.json' -print -quit 2>/dev/null || true)"
if [[ -z "$SHERPA_NODE" ]]; then
  echo "sherpa-onnx-node is not installed. Run: cd apps/host && bun install" >&2
  exit 1
fi
cp -R "$(dirname "$SHERPA_NODE")" "$WORK/app/node_modules/sherpa-onnx-node"
SHERPA_NATIVE="$(find "$ROOT/node_modules" -maxdepth 6 -type d -name "sherpa-onnx-linux-$NPM_ARCH" -print -quit 2>/dev/null || true)"
if [[ -z "$SHERPA_NATIVE" ]]; then
  echo "sherpa-onnx-linux-$NPM_ARCH is missing; cannot ship host ASR for $PLATFORM." >&2
  exit 1
fi
cp -R "$SHERPA_NATIVE" "$WORK/app/node_modules/$(basename "$SHERPA_NATIVE")"
printf '{"type":"module"}\n' > "$WORK/app/package.json"

cat > "$WORK/ocremote" <<'LAUNCHER'
#!/bin/sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$DIR/app/node_modules/sherpa-onnx-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$DIR/runtime/bun" "$DIR/app/main.js" "$@"
LAUNCHER
chmod +x "$WORK/ocremote"

cat > "$WORK/README.md" <<'README'
# OC Remote Host

Encrypted remote access for a local opencode 2.x server.

No Bun installation is required; the runtime is bundled.

```bash
./ocremote start --listen 0.0.0.0:8787 --pair   # phones on the same LAN
./ocremote start -d --listen 0.0.0.0:8787        # background
./ocremote status
./ocremote clients
./ocremote stop
```

Relay mode:

```bash
./ocremote start -d --listen 0.0.0.0:8787 \
  --relay wss://relay.example/ws --relay-secret SECRET
```

Speech models are not bundled:

```bash
./ocremote asr list
./ocremote asr install host-sense-voice-int8
```

Run `./ocremote --help` for every option and example.
README

mkdir -p "$ROOT/dist"
cd "$WORK/.."
tar czf "$OUT.tar.gz" "$(basename "$WORK")"
echo "built $OUT.tar.gz"
