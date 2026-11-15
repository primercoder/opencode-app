# OC Remote

English | [简体中文](README.md) | [Website](https://primercoder.github.io/opencode-app/)

Remote control for [opencode](https://opencode.ai) from Android.

The host runs next to opencode on your computer. The phone connects directly on
the LAN or through an optional relay. Every application frame is protected
end-to-end with **Noise NK**; the relay only forwards ciphertext.

## Contents

- [What it does](#what-it-does)
- [Release downloads](#release-downloads)
- [Quick start](#quick-start)
- [Android app](#android-app)
- [Host](#host)
- [Relay](#relay)
- [Security model](#security-model)
- [Build from source](#build-from-source)
- [Project layout](#project-layout)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## What it does

OC Remote turns an Android phone into a remote client for a local opencode 2.x
server:

- Browse projects and sessions in a single workspace.
- Read streaming assistant output, reasoning and tool calls; long activity runs
  collapse and text is paced like a chat client.
- Send messages, queue input while an agent is working, stop running work and
  follow background tools/subagents.
- Choose agent, model, reasoning depth, MCP servers, skills and dictation engine
  from the bottom session panel.
- Run slash commands (`/new`, `/review`, `/goal`, `/compact`, ...) and shell
  commands (`!ls`).
- Review project files with file-type icons, a fixed root path, parent-directory
  navigation, text/binary detection and a wrap toggle.
- View session diffs and attach line comments to a review prompt.
- Use hybrid voice input: phone Whisper model, host SenseVoice model, or the
  Android system recognizer.
- Connect over LAN directly or through a self-hosted relay with Noise NK
  authentication, optional TLS and one-time enrollment links.

The opencode server stays bound to `127.0.0.1`; the host reads its local service
registration and keeps the opencode password on the computer.

## Release downloads

Release assets name the operating system and CPU architecture in the filename.

| Asset | OS | CPU / target | Use |
|---|---|---|---|
| `ocremote-0.1.3-android-arm64-v8a.apk` | Android | arm64-v8a | Real phones and tablets |
| `ocremote-0.1.3-android-x86_64.apk` | Android | x86_64 | Emulators and x86_64 devices |
| `ocremote-host-0.1.3-linux-x64.tar.gz` | Linux | x86_64 | Host companion; bundled Bun + sherpa-onnx |
| `ocremote-host-0.1.3-linux-arm64.tar.gz` | Linux | arm64 | Host companion; bundled arm64 Bun + sherpa-onnx |
| `ocremote-relay-0.3.0-linux-amd64` | Linux | x86_64 | Relay binary |
| `ocremote-relay-0.3.0-linux-amd64.tar.gz` | Linux | x86_64 | Relay binary + README |
| `ocremote-relay-0.3.0-linux-arm64` | Linux | arm64 | Relay binary |
| `ocremote-relay-0.3.0-linux-arm64.tar.gz` | Linux | arm64 | Relay binary + README |

`SHA256SUMS` verifies every asset. The release APKs are currently signed with
the Expo debug keystore; replace it with a production keystore before
distributing them to end users.

## Quick start

1. **Start the host** next to a running opencode server:

   ```bash
   tar xzf ocremote-host-0.1.3-linux-x64.tar.gz   # use linux-arm64 on arm64
   cd ocremote
   ./ocremote start --listen 0.0.0.0:8787 --pair
   ```

2. **Install the Android APK** matching the phone/emulator architecture, open
   OC Remote, and scan the host's QR code or paste the pairing link.

3. **Optional relay**: start the relay, enroll the host with its one-time host
   invite, then use the host's next pairing code. The phone enrolls with the
   relay automatically.

Direct and relay routing are independent. A saved relay is only used when the
host is started with `--relay-link`/`--relay`; direct mode never waits for a
relay.

## Android app

### Install

Use the APK matching the device:

- `ocremote-0.1.3-android-arm64-v8a.apk` for real Android devices.
- `ocremote-0.1.3-android-x86_64.apk` for an x86_64 emulator.

```bash
adb install ocremote-0.1.3-android-arm64-v8a.apk
```

### Add a host

1. Open the app and tap **+**.
2. Scan the host QR code, or use **Paste link**.
3. Compare the displayed host fingerprint with the fingerprint shown on the
   computer.
4. Tap **Connect and pair**. If the pairing code includes a relay route, the
   phone enrolls with the relay automatically.
5. The device token and relay subject secret are stored in Android SecureStore.

The app remembers the last session per host. The first visit starts empty; later
visits reopen the last session you were reading.

### Workspace

- Left drawer: switch sessions, create a session, or open host settings.
- Header: host status, review and diff entry points.
- Composer: message input, voice input, queue indicator and send/stop.
- Bottom status strip: agent, model, reasoning depth, context usage and percent;
  swipe horizontally to read long values, tap to open session settings.
- Session settings: agent, provider/model tree, reasoning depth, MCP servers,
  skills, dictation engine.
- Background tasks: running tools, shells and subagents; view or stop supported
  tasks.

### Commands

- `/` at the start of an empty message opens the command palette.
- `/models`, `/agents`, `/mcps` and `/variants` open the matching picker sheet.
- `/skills` opens the skill list; selected skills are attached to the next
  message sent from the phone.
- `/sessions`, `/new`, `/compact`, `/status`, `/diff` and `/help` are handled
  locally.
- Server commands from opencode are also listed, such as `/init`, `/review` and
  `/goal`.
- Terminal-only TUI commands are shown greyed out and disabled instead of being
  sent to the server.
- Aliases such as `/model`, `/agent`, `/mcp`, `/thinking`, `/effort` and
  `/resume` are accepted.
- `!command` runs a shell command in the session working directory and shows
  the command, exit code and output.
- While a session is active, normal messages are queued and sent when the
  session becomes idle. Agent/model changes made in another client refresh the
  phone through the event stream without leaving the screen.

### Code review

- File browser: fixed project root path, file-type icons, current-directory
  parent row, cached directory navigation and FlatList rendering.
- File preview: text/binary detection is supplied by the host; long lines can
  be wrapped with the wrap icon.
- Select a line range and add comments; **Send** creates one review prompt.

### Voice

Voice models are downloaded or imported separately; they are not bundled in the
APK. The phone prefers the local Whisper model, then the host SenseVoice model,
then the Android system recognizer. Recognized text is inserted into the input
box and is never sent automatically.

## Host

### Install and run

The Linux x64/arm64 archives are self-contained (Bun and sherpa-onnx included):

```bash
tar xzf ocremote-host-0.1.3-linux-x64.tar.gz   # use linux-arm64 on arm64
cd ocremote
./ocremote start --listen 0.0.0.0:8787 --pair
```

`start` detaches by default. Manage it with:

```bash
./ocremote status
./ocremote clients
./ocremote stop
```

Use `--foreground` for tmux/systemd:

```bash
./ocremote start --foreground --listen 0.0.0.0:8787
```

The default listen address is `127.0.0.1:8787` (local only). Use
`0.0.0.0:8787` for phones on the LAN, or bind one card:

```bash
./ocremote start --listen 192.168.1.23:8787 --pair
```

### Pairing

`--pair` prints a QR plus a full pairing link. A running host can issue another
code with:

```bash
./ocremote pair
./ocremote pair --read-only
./ocremote pair --relay
```

Pair codes are one-time and expire after 5 minutes by default (`--ttl` changes
this).

### Relay

The relay is a single Go binary. It forwards encrypted frames only; it does not
run opencode, ASR or model logic.

### Simple start: built-in Noise NK

```bash
./ocremote-relay serve \
  --data-dir /opt/ocremote/relay/data \
  --listen 0.0.0.0:8443 \
  --public-url ws://<PUBLIC_IP>:8443/ws \
  --no-tls
```

The first run prints a one-time host invite. No extra certificate is required
to start; the invite contains `rk` (the relay X25519 public key), which pins the
relay identity for Noise NK. TLS remains available as an optional layer.

| File | Purpose |
|---|---|
| `data/relay.db` | BoltDB: rooms, subjects and invite hashes |
| `data/relay-identity.json` | Relay Noise static key (0600) |
| `data/admin.sock` | Local admin socket (0600) |
| `data/tls/*` | Only created when wss is enabled |

### Authentication model

| Item | Mechanism |
|---|---|
| Relay identity | X25519 key pinned in the invite; no prompt and no CA |
| Host/phone auth | Noise NK; tokens only travel inside encrypted payloads |
| Host control | Encrypted with the Noise transport (`relay.invite`, `peer`, …) |
| App data | Phone↔host Noise end-to-end; the relay sees ciphertext only |
| Replay | Fresh Noise ephemerals + one-time invite + server state |
| Persistence | `relay.db` survives restarts |

### Admin

```bash
./ocremote-relay init --data-dir ./data \
  --public-url ws://<PUBLIC_IP>:8443/ws --no-tls

./ocremote-relay admin --data-dir ./data status
./ocremote-relay admin --data-dir ./data subjects
./ocremote-relay admin --data-dir ./data invites
./ocremote-relay admin --data-dir ./data rooms
./ocremote-relay admin --data-dir ./data add-host --name office
./ocremote-relay admin --data-dir ./data revoke <subject-id>
```

### Optional TLS

TLS is still available, but it is no longer part of relay authentication. When
using a self-signed `wss://` relay, the host still needs `--relay-ca`; the
Android release trusts only system CAs.

```bash
./ocremote-relay serve --data-dir ./data --listen :8443 \
  --public-url wss://relay.example/ws \
  --tls-cert relay.crt --tls-key relay.key --tls-ca ca.crt
```

## Security model

- **Pairing**: host Noise static public key, one-time pairing code, device info;
  host returns a random device token. Host stores only token hashes.
- **Noise NK**: X25519 ephemeral keys per connection, ChaCha20-Poly1305,
  SHA-256. Every OCRP control frame and proxied HTTP/SSE/file payload is inside a
  protected record.
- **Direct**: `ws://` transport plus Noise E2EE.
- **Relay**: Noise NK pins the relay X25519 key and authenticates host/client;
  auth and host-control frames are encrypted. TLS is optional. The relay sees
  rooms, identities and timing metadata, but only Noise ciphertext for
  application data between phone and host.
- **Keys at rest**: host identity/config are mode 0600; relay BoltDB stores
  token/secret hashes; phone credentials live in Android SecureStore.
- **Release vs QA CA**: release APKs trust only the Android system CA store and
  do not bundle the development test CA. QA builds additionally trust
  `relay_test_ca.pem`. This affects TLS trust only; Noise remains end-to-end
  encrypted in both builds.


## Build from source

### Requirements

- Node 26
- Bun 1.4+
- Go 1.24+
- JDK 21
- Android SDK 35/36 for Android builds

### Install and test

```bash
bun install
bun run test
bun run typecheck
cd apps/relay && go test ./...
```

### Run in development

```bash
bun run host start --listen 0.0.0.0:8787 --pair

cd apps/relay
go run ./cmd/relay

cd apps/mobile
bunx expo run:android
```

### Build release artifacts

```bash
./scripts/build-host-release.sh x64
# Linux arm64 host builds require an arm64 Bun runtime.

cd apps/relay
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o ../../dist/ocremote-relay-0.3.0-linux-amd64 ./cmd/relay
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" \
  -o ../../dist/ocremote-relay-0.3.0-linux-arm64 ./cmd/relay

cd apps/mobile
bunx expo prebuild --platform android --clean
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64
```

Rename the generated APKs to include the OS and CPU architecture, then update
`dist/SHA256SUMS` and `dist/RELEASE.txt`.

## Project layout

```text
packages/protocol/   OCRP frames, Noise NK, pairing and relay link schemas
apps/host/           Bun host companion and local opencode proxy
apps/relay/          Go relay with Noise NK auth, optional TLS, BoltDB, invites and subjects
apps/mobile/         Expo / React Native Android app
scripts/             build, TLS and development helpers
dist/                release artifacts (generated)
```

## Configuration reference

### Host environment

| Variable | Meaning |
|---|---|
| `OCREMOTE_HOME` | Config/identity directory |
| `OCREMOTE_STATE_DIR` | Runtime state/log directory |
| `OCREMOTE_RELAY_CA` | CA used to verify the relay |
| `OCREMOTE_HOST_NAME` | Host display name |

### Relay environment

| Variable | Meaning |
|---|---|
| `RELAY_DATA_DIR` | Data directory (default `./data`) |
| `RELAY_LISTEN` | Listen address (default `:8443`) |
| `RELAY_PUBLIC_URL` | Public `ws://` or `wss://` URL |
| `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | User TLS certificate/key |
| `RELAY_TLS_CA` | User CA certificate |
| `RELAY_TLS_OFF` | Run plain WebSocket; Noise NK still authenticates and encrypts auth/control |
| `RELAY_ADMIN_SOCKET` | Admin Unix socket |
| `RELAY_MAX_CLIENTS`, `RELAY_MAX_FRAME` | Relay limits |
| `RELAY_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

### Phone storage

Credentials are stored in Android SecureStore, not in the repository:

- `ocremote.device.<hostId>` — device id and token.
- `ocremote.relay.<relay-url>` — relay subject id and secret.

## Troubleshooting

**Phone cannot reach the host directly**

- Use `--listen 0.0.0.0:8787`, not only `127.0.0.1`.
- Check that the phone is on the same network and the computer firewall allows
  TCP 8787.
- The pairing link shows the exact `ws://` address the phone will use.

**Relay identity or optional TLS error**

- Noise NK failures usually mean the host invite was already consumed or the
  phone was paired with an older relay key. Re-enroll the host and scan a new
  pairing code.
- Only when `wss://` is enabled with a self-signed certificate: install that CA
  into the Android system store, or use a public CA. The host uses `--relay-ca`
  for a self-signed TLS relay.
- Check the certificate SAN covers the host/IP in `--public-url`.

**Relay starts but host cannot enroll**

- Confirm the host invite was not already consumed.
- Generate a new host invite with `admin add-host`.
- Confirm the host and relay clocks are correct. `--relay-ca` is only needed for an optional self-signed TLS relay.

**APK install fails with architecture mismatch**

- Use `android-arm64-v8a` for a real phone.
- Use `android-x86_64` for an x86_64 emulator.

**Android app cannot use relay after upgrading**

- Generate a new pairing code after the host reconnects; the phone enrolls with
  the new one-time phone invite automatically.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The Noise and
protected-record implementation contains portions adapted from Paseo.
