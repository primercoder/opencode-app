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

opencode 始终只监听 `127.0.0.1`。主机读取本机服务注册信息，opencode 密码不会离开电脑。

## 下载

Release 资源文件名包含操作系统和 CPU 架构。

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-0.1.3-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-0.1.3-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-0.1.3-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 和 sherpa-onnx |
| `ocremote-host-0.1.3-linux-arm64.tar.gz` | Linux | arm64 | 主机端，自带 arm64 Bun 和 sherpa-onnx |
| `ocremote-relay-0.3.0-linux-amd64` | Linux | x86_64 | 中继二进制 |
| `ocremote-relay-0.3.0-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 |
| `ocremote-relay-0.3.0-linux-arm64` | Linux | arm64 | 中继二进制 |
| `ocremote-relay-0.3.0-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 |

`SHA256SUMS` 可校验全部资源。当前 APK 仍使用 Expo debug keystore 签名，正式分发前需要替换生产 keystore。

## 快速开始

| 端 | 操作 |
|---|---|
| 手机 | 安装与设备架构匹配的 APK |
| 主机 | 解压 `ocremote-host-*.tar.gz`，运行 `./ocremote start --listen 0.0.0.0:8787 --pair` |
| 配对 | 手机扫码或粘贴主机打印的配对链接 |
| 中继（可选） | 启动中继，用 host invite 登记主机，再用新的配对码连接手机 |

直连和中继互不依赖。只有启动主机时显式传入 `--relay-link` 或 `--relay`，才会使用已保存的中继。

## Android 手机端

### 安装与配对

```bash
adb install ocremote-0.1.3-android-arm64-v8a.apk
```

1. 打开 OC Remote，点右上角 **+**。
2. 扫描主机二维码，或选择 **粘贴链接**。
3. 核对手机上显示的主机指纹与电脑一致。
4. 点 **连接并配对**。配对码带中继线路时，手机会自动登记中继。
5. 设备令牌和中继凭据保存在 Android SecureStore。

### 会话界面

| 区域 | 作用 |
|---|---|
| 左侧抽屉 | 切换会话、新建会话、进入主机设置 |
| 顶部 | 主机状态、代码审阅、Diff |
| 消息区 | 流式文本、思考与工具折叠、压缩状态 |
| 输入区 | 消息、语音、排队提示、发送/停止 |
| 底部状态栏 | Agent、模型、思考深度、上下文用量；点按打开会话设置 |

从屏幕左侧向右滑可以跟手拉出会话抽屉，向左滑回退。

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
tar xzf ocremote-host-0.1.3-linux-x64.tar.gz   # arm64 使用 linux-arm64
cd ocremote
./ocremote start --listen 0.0.0.0:8787 --pair
```

x64 和 arm64 归档都自带对应架构的 Bun 与 sherpa-onnx，无需额外安装运行时。`start` 默认后台运行。

```bash
./ocremote status
./ocremote clients
./ocremote stop
```

调试或交给 systemd/tmux 时使用前台模式：

```bash
./ocremote start --foreground --listen 0.0.0.0:8787
```

默认监听 `127.0.0.1:8787`；手机在局域网访问时使用 `0.0.0.0:8787` 或指定网卡地址。

### 配对与设备

| 命令 | 作用 |
|---|---|
| `./ocremote pair` | 生成新的只写配对码 |
| `./ocremote pair --read-only` | 生成只读配对码 |
| `./ocremote devices list` | 查看已配对设备 |
| `./ocremote devices revoke <id>` | 撤销设备授权 |

配对码一次性有效，默认 5 分钟过期。

### 中继模式

```bash
./ocremote start --listen 0.0.0.0:8787 --pair \
  --relay-link 'ocremote-relay://enroll#...'
```

| 参数 | 作用 |
|---|---|
| `--relay-link` | 消耗一次性 host invite，保存长期主机身份和中继固定公钥 |
| `--relay-ca` | 仅在使用 `wss://` + 自签证书时需要 |
| 保存后的中继 | 只有显式传 `--relay` / `--relay-link` 才启用 |

中继 v3 不再依赖第三方 CA。邀请链接里带有中继的 X25519 公钥，主机和手机用 Noise NK 完成握手；认证 token 和主机控制帧在 Noise 通道里加密，应用数据仍然由手机↔主机 Noise 端到端加密。

主机连上中继后，中继会下发一次性手机 invite，主机把它写进配对码。

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
| `~/.config/ocremote/config.json` | 设备哈希、待配对哈希、中继身份和房间（0600） |
| `~/.local/state/ocremote/host.log` | 主机日志 |
| `OCREMOTE_HOME` | 覆盖配置和身份目录 |

## 中继端

中继是 Go 单文件程序，只转发加密帧，不运行 opencode、ASR 或模型逻辑。

### 简化启动：内置 Noise NK

```bash
./ocremote-relay serve \
  --data-dir /opt/ocremote/relay/data \
  --listen 0.0.0.0:8443 \
  --public-url ws://<公网IP>:8443/ws \
  --no-tls
```

首次运行会生成并打印一次性 host invite。不需要额外证书即可启动；邀请链接包含 `rk`（中继 X25519 公钥），手机和主机用它固定中继身份。TLS 仍然可以按需叠加。

| 文件 | 内容 |
|---|---|
| `data/relay.db` | BoltDB，保存房间、主体和邀请哈希 |
| `data/relay-identity.json` | 中继 Noise 静态密钥（0600） |
| `data/admin.sock` | 本机管理 socket（0600） |
| `data/tls/*` | 仅在启用 wss 时生成 |

### 认证模型

| 项目 | 机制 |
|---|---|
| 中继身份 | 邀请里的 X25519 公钥；不会弹证书确认，也不需要 CA |
| 主机/手机认证 | Noise NK 握手，token 只在加密 payload 中传输 |
| 主机控制帧 | 使用 Noise transport 加密（`relay.invite`、`peer` 等） |
| 应用数据 | 手机↔主机 Noise 端到端加密，中继只看到密文 |
| 重放 | Noise 临时密钥 + 一次性 invite + 服务端状态 |
| 持久化 | `relay.db` 重启不丢失 |

### 初始化与管理

```bash
./ocremote-relay init --data-dir ./data \
  --public-url ws://<公网IP>:8443/ws --no-tls

./ocremote-relay admin --data-dir ./data status
./ocremote-relay admin --data-dir ./data subjects
./ocremote-relay admin --data-dir ./data invites
./ocremote-relay admin --data-dir ./data rooms
./ocremote-relay admin --data-dir ./data add-host --name office
./ocremote-relay admin --data-dir ./data revoke <subject-id>
```

| 规则 | 说明 |
|---|---|
| invite | 一次性使用 |
| subject | 长期有效，直到主动撤销 |
| 认证 | Noise NK v3；token 不放在 URL，也不明文发送 |
| TLS | 可选；内置 Noise NK 认证可独立运行，TLS 可按需叠加 |

### 可选 TLS

如果希望给传输层再加一层 TLS，可以使用证书；这时主机需要 `--relay-ca`，Android Release 仍只信任系统 CA。

```bash
./ocremote-relay serve --data-dir ./data --listen :8443 \
  --public-url wss://relay.example/ws \
  --tls-cert relay.crt --tls-key relay.key --tls-ca ca.crt
```

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
bun run host start --listen 0.0.0.0:8787 --pair
cd apps/relay && go run ./cmd/relay
cd apps/mobile && bunx expo run:android
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 手机连不上主机 | 主机使用 `--listen 0.0.0.0:8787`；确认同一网络和防火墙允许 TCP 8787 |
| 中继身份校验失败 | 用新的 host invite 重新登记主机，并让手机重新扫描配对码；确认中继的 `rk` 没有变化 |
| 可选 TLS 证书错误 | 只有启用 `wss://` 时涉及；使用公共 CA，或把自签 CA 安装到系统信任库 |
| 主机无法登记中继 | 确认 host invite 未被使用；用 `admin add-host` 重新生成；只有启用 `wss://` 且自签时才需要 `--relay-ca` |
| APK 架构不匹配 | 真机用 `android-arm64-v8a`，x86_64 模拟器用 `android-x86_64` |
| 升级后中继不可用 | 从 0.1.2 升级到 0.1.3 后需要重新登记一次中继并重新配对；之后会复用长期身份 |
| `/compact` 没反应 | 先确认会话已有可压缩内容；压缩结果会显示在消息区 |

## 许可证

Apache-2.0。见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。Noise 与受保护记录实现包含改编自 Paseo 的部分。
