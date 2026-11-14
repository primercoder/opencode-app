# OC Remote 0.1.1

核心斜杠命令、多端实时同步和 Linux arm64 主机端。

## 本次更新

| 项目 | 内容 |
|---|---|
| 命令面板 | 对齐 opencode TUI：`/models`、`/agents`、`/mcps`、`/skills`、`/variants`、`/sessions`、`/new`、`/compact`、`/status`、`/diff`、`/help` |
| Skill | `/skills` 选中后附加到下一次发送，输入框上方显示可移除 chip |
| 不可用命令 | 终端专属命令在面板中置灰失活，不再返回 404 |
| 多端同步 | 其他端修改 Agent、模型、MCP、配置或删除会话时，手机自动刷新 |
| 主机端 | 新增 Linux arm64 构建，自带 arm64 Bun 和 sherpa-onnx |

## 本次修复

| 项目 | 内容 |
|---|---|
| 代码审阅 | 评论不再立即发送；先作为卡片放到会话输入框上方，可逐条删除，会话输入内容追加到评论末尾后一起发送 |
| 输入体验 | 代码审阅的评论输入框随软键盘抬起，不再被输入法遮挡 |
| 流式输出 | 输出结束后自动隐藏光标，并按积压量平滑变速，减少整段跳出的生硬感 |
| 主机列表 | 点“连接”只建立连接并停留在列表；点主机卡片区域才进入会话界面 |
| 文本复制 | 会话正文、Markdown 代码块、表格和列表可长按选择复制 |
| 后台任务 | Agent 执行期间为任务提示预留固定高度，任务出现或结束时正文不再上下抖动 |
| 上下文压缩 | 右侧“手动”改为“查看”，展开内容按 Markdown 渲染 |

## 下载

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-0.1.1-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-0.1.1-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-0.1.1-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 与 sherpa-onnx |
| `ocremote-host-0.1.1-linux-arm64.tar.gz` | Linux | arm64 | 主机端，自带 arm64 Bun 与 sherpa-onnx |
| `ocremote-relay-0.2.0-linux-amd64` | Linux | x86_64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 + CA 安装脚本 |
| `ocremote-relay-0.2.0-linux-arm64` | Linux | arm64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 + CA 安装脚本 |

## 快速开始

| 端 | 操作 |
|---|---|
| 手机 | 安装对应架构的 APK，打开后扫码或粘贴主机配对链接 |
| 主机 x64 | `tar xzf ocremote-host-0.1.1-linux-x64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 主机 arm64 | `tar xzf ocremote-host-0.1.1-linux-arm64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 中继（可选） | 启动 `ocremote-relay`，用 host invite 登记主机，再用新的配对码连接手机 |

## 说明

| 项目 | 说明 |
|---|---|
| APK 签名 | 当前使用 Expo debug keystore，正式分发前需替换生产 keystore |
| TLS 信任 | Release APK 只信任 Android 系统 CA 库，不包含开发测试 CA |
| 加密 | 直连和中继都保持手机↔主机 Noise 端到端加密 |
| 校验 | `sha256sum -c SHA256SUMS` |

完整功能与三端用法见 [README](https://github.com/primercoder/opencode-app/blob/main/README.md)。
