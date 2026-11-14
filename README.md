# OC Remote

Encrypted remote control for [opencode](https://opencode.ai) from Android.

The host runs next to opencode, the phone connects directly on the LAN or through an optional relay, and every application frame is protected end-to-end with Noise NK. The relay only forwards ciphertext.

## Status

P0 foundation and the first encrypted vertical slice are in place:

- `packages/protocol`: OCRP frames, pairing offers, Noise NK, protected records, tests.
- `apps/host`: opencode discovery, device pairing/auth, LAN WebSocket server, HTTP/SSE proxy, relay host client.
- `apps/relay`: Go WebSocket relay with per-room forwarding, first-frame subject authentication, one-time invites, BoltDB persistence and an admin API.
- `apps/mobile`: encrypted HostRuntime (Noise NK, auth, requests, SSE), persisted hosts/tokens, QR/paste pairing (including short HTTP pairing links), project/session drawer, Markdown chat with collapsible tools and a live running state, a single workspace with a slide-in session drawer, a bottom session-settings sheet (agent, provider/model tree, reasoning depth, MCP, skills, dictation engine), diff viewer with paging, read-only review with line comments, general settings (theme, language, voice models, relay access), and hybrid voice dictation (phone whisper model / host SenseVoice / system recognizer).
- `apps/host`: also runs local SenseVoice speech recognition through sherpa-onnx; models are downloaded or imported by the user, never bundled.

Not implemented yet: background service, offline cache, image/file preview rendering.

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

Start the host (needs a running opencode). Release builds use one command and
do not require Bun:

```bash
./ocremote start --listen 0.0.0.0:8787 --pair
```

`start` detaches by default. Manage it with `./ocremote status`, `./ocremote
clients`, and `./ocremote stop`. Use `--foreground` for tmux/systemd. The default
listen address is `127.0.0.1:8787` (local only); use `0.0.0.0:8787` for the LAN,
or a single card such as `192.168.1.23:8787`.

`--pair` prints a compact QR that points at a short local URL; the full pairing
link is printed below it for pasting. A running host can issue another code with:

```bash
./ocremote pair --read-only
```

Relay is a separate mode and is used only when requested. Relay v2 authenticates
the WebSocket with a first-frame hello (no token in the URL), stores invites and
subjects in BoltDB, and lets any enrolled client subject join any host room:

```bash
# zero-argument default: wss on :8443, local CA/cert generated in ./data,
# and a one-time host invite printed on first run
apps/relay/ocremote-relay

# optional overrides
apps/relay/ocremote-relay serve --data-dir ./relay-data --listen :8443 \
  --public-url wss://relay.example/ws

# issue another host invite (for a new host) or manage subjects
apps/relay/ocremote-relay admin --data-dir ./relay-data add-host --name office
apps/relay/ocremote-relay admin --data-dir ./relay-data subjects|invites|rooms
apps/relay/ocremote-relay admin --data-dir ./relay-data revoke <subject-id>
```

The first run or `init` creates a complete set in `<data-dir>/tls`:
`ca.crt`, `ca.key`, `relay.crt` and `relay.key`. Existing files are validated
and reused, never overwritten. A partial or invalid set is an error; use
`--rotate-tls` to rebuild it explicitly. Install the CA in the Android system
trust store once; the release APK uses the system roots:

```bash
./scripts/install-android-ca.sh ./data/tls/ca.crt
```

Pass `--tls-cert/--tls-key` (and optionally `--tls-ca`) to use your own
certificate; it always takes precedence over the local files. `--no-tls` is for
local plain-ws tests. The generated certificate covers localhost, the machine
hostname, all local addresses and the `--public-url` host at creation time.

Enroll the host with its one-time host invite and trust the relay CA:

```bash
./ocremote start --listen 0.0.0.0:8787 --pair \
  --relay-link 'ocremote-relay://enroll#...' \
  --relay-ca ./data/tls/ca.crt
```

When it connects, the relay gives the host a fresh one-time phone link. The
host puts that link into its pairing QR/link, so a phone that scans the code
enrolls with the relay automatically; there is no admin-issued client invite to
copy. The subject secret is kept in the Android keystore and reused for future
connections. A server-issued phone invite is single-use and bound to that
host's room; generating a new pairing code requests a new one. A saved relay is
never activated implicitly: starting without `--relay-link` or a saved relay
subject ignores it.

Development TLS (`relay.ocremote.test`, loopback, `10.0.2.2` and the LAN IP in
the SAN) is still available for the QA build:

```bash
./scripts/gen-dev-tls.sh
apps/relay/ocremote-relay serve --data-dir ./relay-data \
  --tls-cert deploy/tls/relay.crt --tls-key deploy/tls/relay.key
# QA builds trust deploy/tls/ca.crt via src/qa/res; release builds use the
# system trust store, so install the CA produced by the relay there.
```

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
./ocremote asr list
./ocremote asr install host-sense-voice-int8 \
  --model-server http://127.0.0.1:9000
./ocremote asr test \
  --file path/to/16k-mono.wav
```

Start the host with the installed model directory if needed:

```bash
./ocremote start --listen 0.0.0.0:8787 --models-dir ~/.local/share/ocremote/models
```

The phone prefers a local model, then a host model, then the Android system
recognizer. Recognized text is only inserted into the input box; it is never
sent automatically. Relay nodes never receive ASR frames as anything but
ciphertext and have no ASR capability.

## Release 0.1.0

`dist/` contains:

```text
ocremote-0.1.0-arm64-v8a.apk           real phones (arm64)
ocremote-0.1.0-x86_64.apk              emulator (x86_64)
ocremote-host-0.1.0-linux-x64.tar.gz   self-contained host (bundled Bun + sherpa-onnx)
ocremote-relay-0.1.0-linux-amd64       static relay
ocremote-relay-0.1.0-linux-arm64       static relay
SHA256SUMS, RELEASE.txt
```

The host archive needs no Bun installation: extract it and run `./ocremote`.
Android builds still use the Expo debug keystore; replace it with a production
keystore before distributing.

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
