# OC Remote

[English](README.en.md) | 简体中文 | [项目主页](https://primercoder.github.io/opencode-app/)

用 Android 手机远程操作电脑上的 [opencode](https://opencode.ai)。

主机端运行在 opencode 旁边；手机可以在局域网直连，也可以通过自建中继连接。所有应用数据都使用 **Noise NK 端到端加密**，中继只转发密文。

## 功能

| 能力 | 说明 |
|---|---|
| 会话 | 查看项目与会话，实时接收文本、思考过程和工具调用 |
| 输入 | 发送消息、排队输入、停止任务、跟踪后台工具和子代理 |
| 会话设置 | 切换 Agent、模型、思考深度、MCP、Skill 和听写引擎 |
| 命令 | 支持 `/new`、`/review`、`/goal`、`/compact` 等斜杠命令，以及 `!ls` shell 命令 |
| 代码审阅 | 文件浏览器、文件类型图标、换行切换、行级评论、Diff 查看 |
| 语音 | 手机 Whisper、主机 SenseVoice、Android 系统识别三选一或自动回退 |
| 连接 | 局域网直连或自建中继；Noise NK 认证；可选 TLS；配对码一次性有效；支持设备撤销 |

适用于 OpenCode 2.x 的 `/api` 服务。本轮在 OpenCode 2.4.2 上验证。OpenCode 可只监听 `127.0.0.1`，OC Remote 主机从本机服务注册信息获取连接配置。手机连接的是 OC Remote 主机，OpenCode 密码留在电脑上。

## 下载

Release 资源文件名包含操作系统和 CPU 架构。

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-1.0.6-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-1.0.6-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-1.0.6-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 和 sherpa-onnx |
| `ocremote-host-1.0.6-linux-arm64.tar.gz` | Linux | arm64 | 主机端，自带 arm64 Bun 和 sherpa-onnx |
| `ocremote-relay-1.0.6-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 |
| `ocremote-relay-1.0.6-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 |

`SHA256SUMS` 可校验全部资源。当前 APK 仍使用 Expo debug keystore 签名，正式分发前需要替换生产 keystore。

## 快速开始

### 同一局域网：只开直连

```bash
tar xzf ocremote-host-1.0.6-linux-x64.tar.gz   # arm64 使用 linux-arm64
cd ocremote
./ocremote start
./ocremote direct 0.0.0.0:8787
./ocremote pair
```

### 跨网络：只开中继

```bash
# 中继端（公网服务器）
./ocremote-relay --listen 0.0.0.0:8443 \
  --public-url ws://<公网IP>:8443/ws

# 主机端：默认连接 118.31.124.193:8443
./ocremote start
./ocremote relay
./ocremote pair
```

`pair` 会为每个**实际启用**的线路单独打印二维码：直连只显示直连，中继只显示中继；两种都开时打印两个二维码。只有回环地址的直连不会出现在配对码里。

直连和中继互不依赖，可以在主机运行期间随时增删：

```bash
./ocremote direct 192.168.1.20:8787   # 开启或更换直连
./ocremote relay 1.2.3.4:8443        # 更换中继地址
./ocremote relay off                 # 关闭中继但保留身份
./ocremote relay on                  # 重新启用保存的中继
./ocremote direct off
```

## Android 手机端

### 安装与配对

```bash
adb install ocremote-1.0.6-android-arm64-v8a.apk
```

1. 打开 OC Remote，点右上角 **+**。
2. 扫描主机二维码，或选择 **粘贴链接**。
3. 核对手机上显示的主机指纹与电脑一致。
4. 点 **连接并配对**。中继线路会自动登记，不需要手动粘贴中继邀请。
5. 配对成功后返回主机列表。首次进入新主机时显示空白工作区，之后恢复上次打开的会话。会话被删除后会回到空白工作区。设备令牌和中继凭据保存在 Android SecureStore。

主机设置里的 **添加连接方式** 只保存两类线路：直连和中继。再次添加同一类型会覆盖旧线路，不会堆叠；最多各一条。扫码入口使用全屏相机，避免嵌套弹层导致无法识别。

### 会话界面

| 区域 | 作用 |
|---|---|
| 左侧抽屉 | 切换会话、新建会话、进入主机设置 |
| 顶部 | 主机状态、代码审阅、Diff |
| 消息区 | 流式文本、思考与工具折叠、压缩状态 |
| 输入区 | 消息、语音、排队提示、发送/停止 |
| 底部状态栏 | Agent、模型、思考深度、上下文用量；点按打开会话设置 |

从屏幕左侧向右滑可以拉出会话抽屉。点 **新建会话** 后可选最近的 OpenCode 项目，也可从家目录逐级展开，或输入家目录内的相对路径和绝对路径。手机会在创建前显示路径校验结果。

阅读历史时，会话保留当前阅读位置。点 **回到最新内容** 可继续跟随流式输出。网络恢复后，手机会补拉漏掉的记录。如果同步失败，会保留已有记录并显示 **重试**。

点 **后台任务** 可展开任务详情。全局 **停止** 可停止当前 Agent、子会话和可取消的后台任务。排队消息在输入框上方单独取消。OpenCode 会清理被终止 Shell 的临时输出，已写入会话记录的内容仍可查看。

主机在线与 OpenCode 可用是两个状态。OpenCode 停止或重启时，工作区提示服务不可用，服务恢复后自动同步。

### 命令

| 输入 | 行为 |
|---|---|
| `/` | 打开命令面板 |
| `/models`、`/agents`、`/mcps`、`/variants` | 弹出模型、Agent、MCP、思考深度面板 |
| `/skills` | 弹出 Skill 列表；选中的 Skill 附加到下一次发送 |
| `/sessions`、`/new`、`/compact`、`/status`、`/diff`、`/help` | 会话切换、新建、压缩、状态、Diff 和命令帮助 |
| `/init`、`/review`、`/goal`、其他服务端命令 | 调用 opencode 命令接口 |
| `!命令` | 在会话工作目录执行 shell 命令 |
| 手机端不支持的 TUI 命令 | 在面板中置灰失活，不会发送请求 |

`/model`、`/agent`、`/mcp`、`/thinking`、`/effort`、`/resume` 等是兼容别名。

会话运行中继续发送普通消息会排队，等当前任务结束后自动发送。其他终端切换 Agent、模型或修改配置时，手机端会通过事件流自动刷新，不需要切换页面。

### 语音

语音模型不打包进 APK，需要单独下载或导入。优先级为：手机 Whisper → 主机 SenseVoice → Android 系统识别。识别结果只插入输入框，不会自动发送。

## 主机端

### 安装与运行

```bash
tar xzf ocremote-host-1.0.6-linux-x64.tar.gz   # arm64 使用 linux-arm64
cd ocremote
./ocremote start
```

x64 和 arm64 归档都自带对应架构的 Bun 与 sherpa-onnx，无需额外安装运行时。`start` 默认后台运行，读取已保存的直连/中继设置。

```bash
./ocremote status
./ocremote clients
./ocremote stop
```

调试或交给 systemd/tmux 时使用前台模式：

```bash
./ocremote start --foreground
```

### 连接方式

| 命令 | 作用 |
|---|---|
| `./ocremote direct` | 查看当前直连 |
| `./ocremote direct 0.0.0.0:8787` | 开启或修改直连，运行中立即生效 |
| `./ocremote direct 192.168.1.20:8787` | 绑定指定网卡 |
| `./ocremote direct 127.0.0.1:8787` | 仅本机，不会放进手机配对码 |
| `./ocremote direct off` | 关闭直连 |
| `./ocremote relay` | 连接默认中继 `118.31.124.193:8443` |
| `./ocremote relay 1.2.3.4:8443` | 连接自定义 IP:端口 |
| `./ocremote relay status` | 查看当前中继和房间 |
| `./ocremote relay on` | 重新启用已保存的中继身份 |
| `./ocremote relay off` | 关闭中继但保留身份，便于再次启用 |
| `./ocremote relay --ca ca.pem 1.2.3.4:8443` | 可选 TLS 使用自签证书时校验中继 |

直连监听器和中继客户端彼此独立。修改一边不会影响另一边；只有实际启用的线路会出现在 `status` 和 `pair` 输出中。

### 配对与设备

| 命令 | 作用 |
|---|---|
| `./ocremote pair` | 为每个启用线路分别生成一次性配对码 |
| `./ocremote pair --read-only` | 生成只读配对码 |
| `./ocremote pair --ttl 10` | 自定义有效期（分钟） |
| `./ocremote pair --json` | 脚本读取二维码和链接 |
| `./ocremote devices list` | 查看已配对设备 |
| `./ocremote devices revoke <id>` | 撤销设备授权 |

配对码一次性有效，默认 5 分钟过期。中继配对码包含一次性手机 invite；手机会在配对时自动登记。

### 中继登记

中继不再生成 host link。主机只需要 IP 和端口：

```bash
./ocremote relay                       # 默认 118.31.124.193:8443
./ocremote relay 203.0.113.10:8443    # 自定义中继
```

主机首次连接时通过中继的 `/v1/info` 获取并固定中继 X25519 公钥，然后自行登记，保存长期 subject secret。之后用 Noise NK 重连。

`relay off` 保留身份，`relay on` 重新启用。中继身份 key 变化时会拒绝连接，确认服务器后可用：

```bash
./ocremote relay --refresh-key 203.0.113.10:8443
```

手机邀请只在执行 `./ocremote pair` 时向中继申请，每次配对得到独立的一次性链接。

### 语音模型

```bash
./ocremote asr list
./ocremote asr install host-sense-voice-int8
./ocremote asr import host-sense-voice-int8 /path/to/model
./ocremote asr test --file path/to/16k-mono.wav
```

### 文件位置

| 路径 | 内容 |
|---|---|
| `~/.config/ocremote/identity.json` | 主机 Noise 静态密钥（0600） |
| `~/.config/ocremote/config.json` | 设备哈希、待配对哈希、直连/中继设置（0600） |
| `~/.local/state/ocremote/host.log` | 主机日志 |
| `OCREMOTE_HOME` | 覆盖配置和身份目录 |

## 中继端

中继是 Go 单文件程序，只转发加密帧，不运行 opencode、ASR 或模型逻辑。默认使用 `ws://` + Noise NK，不需要证书即可服务公网 IP；TLS 仍可按需叠加。

### 启动与配置文件

```bash
./ocremote-relay --data-dir /opt/ocremote/relay/data \
  --listen 0.0.0.0:8443 \
  --public-url ws://<公网IP>:8443/ws
```

不需要 `init`，首次启动会自动创建中继身份和数据库。启动输出只包含监听地址、限额和数据目录，不再打印 host link。主要参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--data-dir` | `./data` | 数据库、中继身份和管理 socket |
| `--listen` | `:8443` | 监听地址 |
| `--public-url` | 根据 listen 推导 | 写进手机邀请的公网 ws/wss 地址 |
| `--max-hosts` | `3` | 同时登记的主机数量 |
| `--max-clients` | `3` | 每个主机房间可连接的手机数量 |
| `--tls-cert` / `--tls-key` | 无 | 可选 TLS 证书 |
| `--log-level` | `info` | 日志级别 |

配置持久化在 `<data-dir>/relay-config.json`：带参数启动时自动把生效配置写入该文件；之后裸运行（例如系统服务单元只传 `--data-dir`）会读取它。优先级为命令行参数、环境变量、配置文件、内置默认，按顺序查找。

| 文件 | 内容 |
|---|---|
| `data/relay.db` | BoltDB，保存房间、主机/手机主体和邀请哈希 |
| `data/relay-identity.json` | 中继 Noise 静态密钥（0600） |
| `data/admin.sock` | 本机管理 socket（0600） |

### 任意主机登记

中继接受实现 OC Remote 中继协议的主机自行登记，不需要预发 host invite：

- 主机首次连接发送稳定的 `hostId`
- 中继创建独立 host subject 和 room
- 返回长期 secret，主机保存后用于后续 Noise NK 认证
- 同一 `hostId` 已登记且未撤销时拒绝重复登记
- 超过 `--max-hosts` 返回 `RELAY_HOST_LIMIT`
- 每个 room 超过 `--max-clients` 返回 `RELAY_ROOM_FULL`

这种开放登记意味着任何拿到中继地址并实现协议的主机都能尝试占用名额；用主机数量上限、`admin revoke` 和房间隔离控制滥用。它是可用性边界，不是“官方主机”密码学证明。

### 认证模型

| 项目 | 机制 |
|---|---|
| 中继身份 | 主机通过 `/v1/info` 获取并固定的 X25519 公钥；不需要 CA |
| 主机/手机认证 | Noise NK 握手，subject secret 只在加密 payload 中传输 |
| 主机控制帧 | 使用 Noise transport 加密（`relay.invite`、`peer` 等） |
| 手机邀请 | 只在 `pair` 时申请，一次性、绑定 room，每次不同 |
| 应用数据 | 手机↔主机 Noise 端到端加密，中继只看到密文 |
| 重放 | Noise 临时密钥 + 一次性手机 invite + 服务端状态 |
| 持久化 | `relay.db` 重启不丢失 |

### 管理

```bash
./ocremote-relay admin --data-dir ./data status
./ocremote-relay admin --data-dir ./data hosts
./ocremote-relay admin --data-dir ./data clients
./ocremote-relay admin --data-dir ./data rooms
./ocremote-relay admin --data-dir ./data revoke <subject-id>
```

`status` 输出当前主机数/上限和每房间手机上限。`revoke` 会断开该主体并释放主机名额。

### 后台运行与开机自启

前台运行是默认方式（systemd、容器等由自身管理重启）。需要脱离终端时用 `--daemon`，进程进入后台、日志写入 `<data-dir>/relay.log`：

```bash
./ocremote-relay --daemon --data-dir ./data --listen 0.0.0.0:8443 \
  --public-url ws://<公网IP>:8443/ws
./ocremote-relay stop --data-dir ./data    # 优雅停止
```

同一数据目录同时只允许一个中继（pid 文件单例）；重复启动会报 `another relay is already running`。

开机自启用**系统级服务**（Linux 为 systemd，macOS 为 LaunchDaemon）。`service install` 将生效配置写入 `relay-config.json`，服务启动时读取该文件。Linux 上重新安装会重启已运行的服务。编辑配置文件后可用 `systemctl restart ocremote-relay.service` 应用修改。安装与卸载需要 root。

```bash
sudo ./ocremote-relay service install --data-dir ./data \
  --listen 0.0.0.0:8443 --public-url ws://<公网IP>:8443/ws
systemctl enable --now ocremote-relay.service   # 启用开机自启
./ocremote-relay service status      # 查看状态与 enable/disable/logs 命令
sudo ./ocremote-relay service uninstall   # 移除服务
```

服务单元内为前台进程 + `Restart=on-failure`（macOS 为 `KeepAlive`），崩溃自动恢复由 systemd/launchd 负责。

### 可选 TLS

TLS 是可选传输层，Noise NK 认证和加密控制帧不依赖它。中继不自动生成自签 CA；需要 TLS 时直接提供证书，或放在 Caddy/nginx 后面：

```bash
./ocremote-relay --data-dir ./data --listen 0.0.0.0:8443 \
  --public-url wss://relay.example/ws \
  --tls-cert /etc/ocremote/fullchain.pem \
  --tls-key /etc/ocremote/privkey.pem
```

使用公共 CA 时主机不需要额外参数；只有自签证书才需要在主机端 `--ca`，并把 CA 安装到 Android 系统信任库。

## 安全模型

| 层面 | 机制 |
|---|---|
| 配对 | 主机 Noise 静态公钥 + 一次性配对码；主机只保存设备令牌哈希 |
| 应用数据 | Noise NK，X25519 临时密钥，ChaCha20-Poly1305，SHA-256 |
| 直连 | `ws://` 传输 + Noise 端到端加密 |
| 中继 | 使用 Noise NK 固定中继公钥并认证 host/client；应用数据仍由手机↔主机 Noise 端到端加密 |
| 中继可见信息 | 房间、身份、时间、帧大小等元数据；应用数据只有密文 |
| 静态凭据 | 主机文件 0600；中继保存 token 哈希；手机使用 Android SecureStore |

## 技术路线

| 模块 | 技术 |
|---|---|
| 协议 | TypeScript，OCRP 帧、Noise NK、受保护记录、配对与中继链接 |
| 主机 | Bun + TypeScript，局域网 WebSocket、HTTP/SSE 代理、中继主机客户端 |
| 中继 | Go，WebSocket 房间转发、Noise NK 认证、可选 TLS、BoltDB、Admin API |
| 手机 | Expo / React Native（Android），Expo Router、Zustand、SecureStore |
| 流式渲染 | SSE 事件 → 帧式呈现控制器 → 文本/思考/工具分块渲染 |
| 文件审阅 | 主机侧文件类型与二进制判定，手机端 FlatList 浏览与行评论 |

## 构建与测试

需要 Node 26、Bun 1.4+、Go 1.24+、JDK 21、Android SDK 35/36。

```bash
bun install
bun run test
bun run typecheck
cd apps/relay && go test ./...
```

开发运行：

```bash
bun run --cwd apps/host src/index.ts start
bun run --cwd apps/host src/index.ts direct 0.0.0.0:8787
bun run --cwd apps/host src/index.ts pair
cd apps/relay && go run ./cmd/relay
cd apps/mobile && bunx expo run:android
```

### 模拟器和弱网验收

在测试机上使用独立的 OpenCode 实例和中继数据目录。以下命令启动 Docker 中继和 Toxiproxy，将模拟器的本机端口转发到测试机：

```bash
RELAY_DEV_DATA_DIR="$(mktemp -d)" docker compose -f docker-compose.dev.yml up -d --build
curl -fsS http://127.0.0.1:8474/proxies -H 'Content-Type: application/json' \
  -d '{"name":"relay","listen":"0.0.0.0:26379","upstream":"relay:8443"}'
adb reverse tcp:26379 tcp:26379
```

为**测试主机**运行 `./ocremote relay 127.0.0.1:26379`，使用 `./ocremote pair` 输出的中继链接配对。验收时可以在 Toxiproxy 增加延迟、限制带宽，或将 `relay` 代理切换为禁用再恢复。检查会话能否续接和补齐、已结束任务是否消失。使用真实 OpenCode 服务验证接口，用定时输出的本地模型验证流式滚动。验收用例对应 [GitHub Issues #1–#10](https://github.com/primercoder/opencode-app/issues?q=is%3Aissue) 和 [OpenCode API](https://opencode.ai/docs/api)。

本轮使用 Android API 35 x86_64 和 OpenCode 2.4.2。在 Toxiproxy 下行延迟 220 ± 30 毫秒、限速 96 KB/s 的配置下恢复中继连接，核对了跨两页的 75 条记录。模拟器覆盖配对、目录校验、恢复或回退到空白会话、流式历史定位、任务详情和停止，以及 OpenCode 恢复后的自动同步。

## 故障排查

| 现象 | 处理 |
|---|---|
| 手机连不上主机 | 运行 `ocremote direct 0.0.0.0:8787`；确认同一网络、防火墙允许 TCP 8787，并且 `pair` 输出的是直连二维码 |
| 中继身份校验失败 | 中继 key 可能已变化；确认服务器后用 `ocremote relay --refresh-key <ip:port>` 重新固定，必要时重新登记并让手机重新扫描配对码 |
| 可选 TLS 证书错误 | 只有启用 `wss://` 时涉及；使用公共 CA，或把自签 CA 安装到系统信任库 |
| 主机无法登记中继 | 确认中继地址可达、`--max-hosts` 未满、同一 `hostId` 没有被旧主体占用；只有自签 `wss://` 才需要 `--ca` |
| APK 架构不匹配 | 真机用 `android-arm64-v8a`，x86_64 模拟器用 `android-x86_64` |
| 升级后中继不可用 | 从旧版升级后重新登记一次中继；`relay off/on` 会复用已保存身份 |
| `/compact` 没反应 | 先确认会话已有可压缩内容；压缩结果会显示在消息区 |

## 许可证

Apache-2.0。见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。Noise 与受保护记录实现包含改编自 Paseo 的部分。

本次 Release 说明见 [docs/releases/v1.0.6.md](docs/releases/v1.0.6.md)。
