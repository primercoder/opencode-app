# OC Remote

Encrypted remote control for [opencode](https://opencode.ai) from Android.

The host runs next to opencode, the phone connects directly on the LAN or through an optional relay, and every application frame is protected end-to-end with Noise NK. The relay only forwards ciphertext.

## Status

P0 foundation and the first encrypted vertical slice are in place:

- `packages/protocol`: OCRP frames, pairing offers, Noise NK, protected records, tests.
- `apps/host`: opencode discovery, device pairing/auth, LAN WebSocket server, HTTP/SSE proxy, relay host client.
- `apps/relay`: Go WebSocket relay with rooms, bearer/query tokens, host/client forwarding and backpressure.
- `apps/mobile`: encrypted HostRuntime (Noise NK, auth, requests, SSE), persisted hosts/tokens, host home, pairing by paste or QR scan, session search, project-aware new sessions, chat, permissions/forms, model/agent picker, diff viewer with line numbers, read-only review with line comments, and hybrid voice dictation (phone whisper model / host SenseVoice / system recognizer).
- `apps/host`: also runs local SenseVoice speech recognition through sherpa-onnx; models are downloaded or imported by the user, never bundled.

Not implemented yet: notifications, background service, offline cache, image/file preview rendering.

## Layout

```text
packages/protocol/   TypeScript protocol + Noise/E2EE
apps/host/           Bun host companion (LAN first)
apps/relay/          Go relay (opaque WebSocket forwarding)
apps/mobile/         Expo / React Native Android app
scripts/             environment and network helpers
```

## Requirements

- Node 26 (`.nvmrc`; React Native 0.86 supports Node >=25)
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

All TypeScript tests (including the real Go relay integration test):

```bash
bun run test
```

Read-only smoke test against the locally running opencode service (pairs, lists
sessions/projects/models/files, reads one file):

```bash
bun run smoke:opencode
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

With a relay (register a room once, then reuse it):

```bash
bun run src/index.ts start --lan --pair \
  --relay-url ws://127.0.0.1:26379/ws \
  --relay-secret dev-secret
```

The pairing QR then contains both LAN and relay transports. Rooms are stored in
`~/.config/ocremote/config.json`; pass `--relay-new-room` to register a fresh room.
Relay rooms are in-memory, so a relay restart loses them. When
`RELAY_REGISTRATION_SECRET` (or `--relay-secret`) is available, the host
re-registers the same room and tokens before reconnecting, and paired clients
recover without re-pairing.

Relay development network:

```bash
docker compose -f docker-compose.dev.yml up -d relay toxiproxy
curl -X POST http://127.0.0.1:8474/proxies \
  -H 'Content-Type: application/json' \
  -d '{"name":"relay","listen":"0.0.0.0:26379","upstream":"relay:8080","enabled":true}'
```

Add latency/bandwidth toxics through the Toxiproxy API when testing failover. The
mobile runtime falls back from LAN to relay when the first candidate fails.

Mobile:

```bash
cd apps/mobile
bunx expo start
# or, after Android prebuild/tooling:
bunx expo run:android
```

Android build (Expo CNG: `android/` is generated and gitignored):

```bash
cd apps/mobile
bunx expo prebuild --platform android --clean
cd android
./gradlew :app:assembleDebug    # or assembleRelease
```

Pass `-PreactNativeArchitectures=arm64-v8a` (or `x86_64`) to build one ABI.
The generated release build uses the Expo debug keystore; configure a real
keystore before distributing.

The development machine now exposes `/dev/kvm`; the `oc35` AVD boots in under a minute with
hardware acceleration. Headless testing uses:

```bash
$HOME/Android/Sdk/emulator/emulator -avd oc35 -accel on -no-window \
  -no-audio -no-boot-anim -gpu swiftshader_indirect -memory 3072
adb reverse tcp:26379 tcp:26379   # when testing through toxiproxy/relay
```

The release APKs are smoke-tested on the x86_64 emulator over both LAN and relay
(including relay restart recovery). See the local setup log for details.

## Speech models

Models are not bundled into the APK or host binary. The phone uses a small
Whisper GGML model; the host uses a larger SenseVoice ONNX model.

Development uses a local model server so both sides exercise the same download
path without hitting upstream sites:

```bash
bun run models:fetch   # downloads dev models with SHA-256 verification
bun run models:serve   # http://0.0.0.0:9000/models/...
```

Phone: Settings -> Voice models -> set the model server to
`http://10.0.2.2:9000` (emulator) or your LAN IP, then download/import.
Release builds use the upstream URLs in `packages/models`; the runtime override
is empty by default.

Host:

```bash
cd apps/host
bun run src/index.ts asr list
bun run src/index.ts asr install host-sense-voice-int8 \
  --model-server http://127.0.0.1:9000
bun run src/index.ts asr test \
  --file path/to/16k-mono.wav
```

Start the host with the installed model directory if needed:

```bash
bun run src/index.ts start --lan --models-dir ~/.local/share/ocremote/models
```

The phone prefers a local model, then a host model, then the Android system
recognizer. Recognized text is only inserted into the input box; it is never
sent automatically. Relay nodes never receive ASR frames as anything but
ciphertext and have no ASR capability.

## Security model

- opencode stays on `127.0.0.1`; the host reads its service registration and keeps its password local.
- Phones pair with a one-time code and receive a device token; the host stores only token hashes.
- Noise NK authenticates the host with the static key from the QR and encrypts every OCRP frame.
- The relay sees rooms, roles, sizes and timing, never prompts or code. Relay client tokens are sent in the WebSocket URL query (or Authorization header for non-browser clients); use `wss://` in production so the token is protected by TLS.
- A packet capture of a relay session was checked during development: prompt text, assistant text, session titles and the opencode password were absent; application frames were opaque Noise records. The initial Noise handshake is the only plaintext JSON (base64), containing no application data.
- Relay/ASR/code-review boundaries follow `opencode-remote-mobile-development-guide.md` (local-only document).

## License

Apache-2.0. See `LICENSE` and `NOTICE`; the Noise/protected-record implementation
contains portions adapted from Paseo.
