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
| `ocremote-1.0.3-android-arm64-v8a.apk` | Android | arm64-v8a | Real phones and tablets |
| `ocremote-1.0.3-android-x86_64.apk` | Android | x86_64 | Emulators and x86_64 devices |
| `ocremote-host-1.0.3-linux-x64.tar.gz` | Linux | x86_64 | Host companion; bundled Bun + sherpa-onnx |
| `ocremote-host-1.0.3-linux-arm64.tar.gz` | Linux | arm64 | Host companion; bundled arm64 Bun + sherpa-onnx |
| `ocremote-relay-1.0.3-linux-amd64` | Linux | x86_64 | Relay binary |
| `ocremote-relay-1.0.3-linux-amd64.tar.gz` | Linux | x86_64 | Relay binary + README |
| `ocremote-relay-1.0.3-linux-arm64` | Linux | arm64 | Relay binary |
| `ocremote-relay-1.0.3-linux-arm64.tar.gz` | Linux | arm64 | Relay binary + README |

`SHA256SUMS` verifies every asset. The release APKs are currently signed with
the Expo debug keystore; replace it with a production keystore before
distributing them to end users.

## Quick start

### Same LAN: direct only

```bash
tar xzf ocremote-host-1.0.3-linux-x64.tar.gz   # use linux-arm64 on arm64
cd ocremote
./ocremote start
./ocremote direct 0.0.0.0:8787
./ocremote pair
```

### Across networks: relay only

```bash
# Relay host (public server)
./ocremote-relay --listen 0.0.0.0:8443 \
  --public-url ws://<PUBLIC_IP>:8443/ws

# Host: connect to the default relay at 118.31.124.193:8443
./ocremote start
./ocremote relay
./ocremote pair
```

`pair` prints a separate QR for every route that is actually enabled: direct
only, relay only, or both. A loopback-only direct listener is never offered to
phones. Routes are independent and can be changed while the host runs:

```bash
./ocremote direct 192.168.1.20:8787
./ocremote relay 1.2.3.4:8443        # change the relay address
./ocremote relay off                 # stop the client, keep the identity
./ocremote relay on                  # re-enable the saved identity
./ocremote direct off
```

## Android app

### Install

Use the APK matching the device:

- `ocremote-1.0.3-android-arm64-v8a.apk` for real Android devices.
- `ocremote-1.0.3-android-x86_64.apk` for an x86_64 emulator.

```bash
adb install ocremote-1.0.3-android-arm64-v8a.apk
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
tar xzf ocremote-host-1.0.3-linux-x64.tar.gz   # use linux-arm64 on arm64
cd ocremote
./ocremote start
```

`start` detaches by default and reads the saved direct/relay routes:

```bash
./ocremote status
./ocremote clients
./ocremote stop
```

Use `--foreground` for tmux/systemd:

```bash
./ocremote start --foreground
```

### Routes

| Command | Effect |
|---|---|
| `./ocremote direct` | Show the current direct route |
| `./ocremote direct 0.0.0.0:8787` | Enable or update direct, live |
| `./ocremote direct 192.168.1.20:8787` | Bind one interface |
| `./ocremote direct 127.0.0.1:8787` | Local only; never offered to phones |
| `./ocremote direct off` | Disable direct |
| `./ocremote relay` | Connect the default relay `118.31.124.193:8443` |
| `./ocremote relay 1.2.3.4:8443` | Connect a custom IP:port |
| `./ocremote relay status` | Show the current relay and room |
| `./ocremote relay on` | Re-enable the saved relay identity |
| `./ocremote relay off` | Stop the relay client but keep its identity |
| `./ocremote relay --ca ca.pem 1.2.3.4:8443` | Optional self-signed TLS relay |

Direct and relay are independent. Changing one never stops the other, and only
enabled routes appear in `status` and `pair`.

### Pairing and devices

| Command | Effect |
|---|---|
| `./ocremote pair` | One one-time code per enabled route |
| `./ocremote pair --read-only` | Read-only device code |
| `./ocremote pair --ttl 10` | Code lifetime in minutes |
| `./ocremote pair --json` | Machine-readable QR/link data |
| `./ocremote devices list` | List paired devices |
| `./ocremote devices revoke <id>` | Revoke a device |

Codes are one-time and expire after 5 minutes by default. Relay codes carry a
one-time phone invite and enroll the phone automatically.

### Relay enrollment

The relay no longer prints a host link. A host only needs the IP and port:

```bash
./ocremote relay                       # default 118.31.124.193:8443
./ocremote relay 203.0.113.10:8443    # custom relay
```

On first contact the host fetches `/v1/info`, pins the relay X25519 key, then
registers itself and stores a long-lived subject secret. Later reconnects use
Noise NK with that pinned key. If the relay key changes, the host refuses the
connection until you confirm it:

```bash
./ocremote relay --refresh-key 203.0.113.10:8443
```

A phone invite is requested only when `./ocremote pair` runs. Every pair gets a
fresh one-time room-bound link.

### Speech models

```bash
./ocremote asr list
./ocremote asr install host-sense-voice-int8
./ocremote asr import host-sense-voice-int8 /path/to/model
./ocremote asr test --file path/to/16k-mono.wav
```

### Files

| Path | Purpose |
|---|---|
| `~/.config/ocremote/identity.json` | Host Noise static key (0600) |
| `~/.config/ocremote/config.json` | Devices, pending pairs, direct/relay settings (0600) |
| `~/.local/state/ocremote/host.log` | Host log |
| `OCREMOTE_HOME` | Override the config/identity directory |

## Relay

The relay is a single Go binary. It forwards encrypted frames only and does not
run opencode, ASR or model logic. The default is `ws://` + Noise NK; no
certificate is needed for a public IP. TLS remains optional.

### Start

```bash
./ocremote-relay --data-dir /opt/ocremote/relay/data \
  --listen 0.0.0.0:8443 \
  --public-url ws://<PUBLIC_IP>:8443/ws
```

There is no `init` step. The first start creates the relay identity and
database. It prints the listen address, limits and data directory, but no host
link.

| Option | Default | Effect |
|---|---|---|
| `--data-dir` | `./data` | Database, identity and admin socket |
| `--listen` | `:8443` | Listen address |
| `--public-url` | derived | Public ws/wss URL embedded in phone invites |
| `--max-hosts` | `3` | Simultaneously registered hosts |
| `--max-clients` | `3` | Phones per host room |
| `--tls-cert` / `--tls-key` | none | Optional TLS certificate |
| `--log-level` | `info` | Log level |

| File | Purpose |
|---|---|
| `data/relay.db` | BoltDB: rooms, subjects and invite hashes |
| `data/relay-identity.json` | Relay Noise static key (0600) |
| `data/admin.sock` | Local admin socket (0600) |

### Open host registration

Any host implementing the OC Remote relay protocol can register without a
pre-issued host invite:

- the host sends a stable `hostId`
- the relay creates a host subject and a dedicated room
- the relay returns a long-lived secret used for later Noise NK authentication
- the same active `hostId` cannot register twice
- `--max-hosts` and `--max-clients` bound capacity
- `RELAY_HOST_LIMIT` / `RELAY_ROOM_FULL` reject excess peers

This is an availability boundary, not cryptographic proof that a host is
"official": anyone with the relay URL and a compatible client can try to use a
host slot. Use the host limit, `admin revoke` and room isolation to manage abuse.

### Authentication model

| Item | Mechanism |
|---|---|
| Relay identity | X25519 key fetched from `/v1/info` and pinned by the host; no CA |
| Host/phone auth | Noise NK; subject secrets only inside encrypted payloads |
| Host control | Encrypted with the Noise transport (`relay.invite`, `peer`, …) |
| Phone invites | Created only by `pair`, one-time and bound to the host room |
| App data | Phone↔host Noise end-to-end; the relay sees ciphertext only |
| Replay | Fresh Noise ephemerals + one-time phone invites + server state |
| Persistence | `relay.db` survives restarts |

### Admin

```bash
./ocremote-relay admin --data-dir ./data status
./ocremote-relay admin --data-dir ./data hosts
./ocremote-relay admin --data-dir ./data clients
./ocremote-relay admin --data-dir ./data rooms
./ocremote-relay admin --data-dir ./data revoke <subject-id>
```

`status` shows host count/limit and phones per room. `revoke` disconnects the
subject and frees a host slot.

### Running in the background and autostart

Foreground is the default (systemd, containers etc. own restart policy). To
detach from the terminal use `--daemon`; the process goes to the background and
logs to `<data-dir>/relay.log`:

```bash
./ocremote-relay --daemon --data-dir ./data --listen 0.0.0.0:8443 \
  --public-url ws://<public-ip>:8443/ws
./ocremote-relay stop --data-dir ./data    # graceful stop
```

One relay per data directory (pid-file singleton); a second start fails with
`another relay is already running`.

Autostart ships as a per-user service (systemd `--user` on Linux, a LaunchAgent
on macOS). `install` freezes the current flags into the unit; re-running
install while the service is running updates the configuration and restarts:

```bash
./ocremote-relay service install --data-dir ./data \
  --listen 0.0.0.0:8443 --public-url ws://<public-ip>:8443/ws
systemctl --user enable --now ocremote-relay.service   # enable autostart
./ocremote-relay service status      # state + enable/disable/log commands
./ocremote-relay service uninstall   # remove the service
```

Inside the unit the relay runs in the foreground with `Restart=on-failure`
(`KeepAlive` on macOS); crash recovery belongs to systemd/launchd.

### Optional TLS

TLS is an optional transport layer; Noise NK authentication and encrypted
control frames do not depend on it. The relay does not generate a self-signed
CA. Pass a certificate directly or terminate TLS in Caddy/nginx:

```bash
./ocremote-relay --data-dir ./data --listen 0.0.0.0:8443 \
  --public-url wss://relay.example/ws \
  --tls-cert /etc/ocremote/fullchain.pem \
  --tls-key /etc/ocremote/privkey.pem
```

A public CA needs no host-side option. Only a self-signed certificate requires
`--ca` on the host and the CA in the Android system trust store.

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
bun run --cwd apps/host src/index.ts start
bun run --cwd apps/host src/index.ts direct 0.0.0.0:8787
bun run --cwd apps/host src/index.ts pair

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
  -o ../../dist/ocremote-relay-1.0.3-linux-amd64 ./cmd/relay
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" \
  -o ../../dist/ocremote-relay-1.0.3-linux-arm64 ./cmd/relay

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
apps/relay/          Go relay with Noise NK auth, optional TLS, BoltDB, hosts and rooms
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
| `OCREMOTE_HOST_NAME` | Host display name |

### Relay environment

| Variable | Meaning |
|---|---|
| `RELAY_DATA_DIR` | Data directory (default `./data`) |
| `RELAY_LISTEN` | Listen address (default `:8443`) |
| `RELAY_PUBLIC_URL` | Public `ws://` or `wss://` URL |
| `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | User TLS certificate/key |
| `RELAY_ADMIN_SOCKET` | Admin Unix socket |
| `RELAY_MAX_HOSTS`, `RELAY_MAX_CLIENTS` | Host and per-room phone limits |
| `RELAY_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

### Phone storage

Credentials are stored in Android SecureStore, not in the repository:

- `ocremote.device.<hostId>` — device id and token.
- `ocremote.relay.<relay-url>` — relay subject id and secret.

## Troubleshooting

**Phone cannot reach the host directly**

- Run `ocremote direct 0.0.0.0:8787`, not `127.0.0.1`, when the phone is remote.
- Check that the phone is on the same network and the firewall allows TCP 8787.
- `ocremote pair` should print a "Direct · same LAN" block. If it prints only a
  relay block, direct is off or bound to loopback.

**Relay identity or optional TLS error**

- Noise NK failures usually mean the saved subject was revoked or the phone was
  paired with an older relay key. Re-enroll the host and scan a fresh relay QR.
- Only when `wss://` is enabled with a self-signed certificate: install that CA
  into the Android system store, or use a public CA. The host uses `--ca`.
- Check the certificate SAN covers the host/IP in `--public-url`.

**Relay starts but host cannot enroll**

- Check that `--public-url` is reachable from the host.
- Check `--max-hosts`; a full relay rejects new hosts with `RELAY_HOST_LIMIT`.
- The same active `hostId` cannot register twice. Revoke the old subject if the
  host lost its config.
- `--ca` is only needed for an optional self-signed TLS relay.

**APK install fails with architecture mismatch**

- Use `android-arm64-v8a` for a real phone.
- Use `android-x86_64` for an x86_64 emulator.

**Android app cannot use relay after upgrading**

- Generate a new pairing code after the host reconnects; the phone enrolls with
  the new one-time phone invite automatically. Re-adding the same route kind
  replaces the old one, so there are never duplicate direct/relay entries.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The Noise and
protected-record implementation contains portions adapted from Paseo.
