# OC Remote

Encrypted remote control for [opencode](https://opencode.ai) from Android.

The host runs next to opencode, the phone connects directly on the LAN or through an optional relay, and every application frame is protected end-to-end with Noise NK. The relay only forwards ciphertext.

## Status

P0 foundation is in place:

- `packages/protocol`: OCRP frames, pairing offers, Noise NK, protected records, tests.
- `apps/host`: opencode discovery, device pairing/auth, LAN WebSocket server, HTTP/SSE proxy.
- `apps/relay`: Go WebSocket relay with rooms, bearer tokens, forwarding and backpressure.
- `apps/mobile`: Expo Router scaffold with host list and pairing-link screen.

Not implemented yet: host relay client, mobile encrypted transport, session/chat UI, ASR, code review, notifications.

## Layout

```text
packages/protocol/   TypeScript protocol + Noise/E2EE
apps/host/           Bun host companion (LAN first)
apps/relay/          Go relay (opaque WebSocket forwarding)
apps/mobile/         Expo / React Native Android app
scripts/             environment and network helpers
```

## Requirements

- Node 22 (`.nvmrc`)
- Bun 1.4+
- Go 1.24+
- JDK 21 (`JAVA_HOME`)
- Android SDK 35/36 + AVD `oc35` for early emulator testing
- Docker + Compose for the local relay network

Environment details are recorded in the local-only setup log.

## Quick start

```bash
bun install
```

Protocol/host tests:

```bash
cd packages/protocol && bun test
cd ../../apps/host && bun test
```

Relay tests:

```bash
cd apps/relay && go test ./...
```

Start the LAN host (needs a running opencode):

```bash
cd apps/host
bun run src/index.ts start --lan --pair
```

`--pair` prints a QR and pairing link. For a separate pairing code before startup:

```bash
bun run src/index.ts pair --lan
bun run src/index.ts start --lan
```

Relay development network:

```bash
docker compose -f docker-compose.dev.yml up -d relay toxiproxy
curl -X POST http://127.0.0.1:8474/proxies \
  -H 'Content-Type: application/json' \
  -d '{"name":"relay","listen":"0.0.0.0:26379","upstream":"relay:8080","enabled":true}'
```

Add latency/bandwidth toxics through the Toxiproxy API when testing failover.

Mobile:

```bash
cd apps/mobile
bunx expo start
# or, after Android prebuild/tooling:
bunx expo run:android
```

Current emulator note: the development machine has no `/dev/kvm`, so `oc35` must run with
`-accel off`; first cold boot is slow. See the setup log for details.

## Security model

- opencode stays on `127.0.0.1`; the host reads its service registration and keeps its password local.
- Phones pair with a one-time code and receive a device token; the host stores only token hashes.
- Noise NK authenticates the host with the static key from the QR and encrypts every OCRP frame.
- The relay sees rooms, roles, sizes and timing, never prompts, code or tokens.
- Relay/ASR/code-review boundaries follow `opencode-remote-mobile-development-guide.md` (local-only document).
