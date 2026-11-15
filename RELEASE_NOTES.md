# OC Remote 0.1.2

更顺手的会话操作、语音输入和长会话阅读体验。

## 本次更新

| 项目 | 内容 |
|---|---|
| 停止任务 | 会话右下角新增红色停止按钮，位于发送按钮上方；点击后二次确认，发送按钮仍可用于输入和排队消息 |
| 后台任务 | 调整任务提示槽位高度，后台任务出现或结束时正文和输入框不再细微跳动 |
| 语音输入 | 点击麦克风后在输入框下方拉起语音面板并抬升输入框；录音时显示动效，停止后出现确认和取消 |
| 语音确认 | 确认后才发送到手机本地或主机识别；取消会丢弃录音；两种操作都会关闭面板并恢复输入框位置 |
| 语音拼接 | 多次录音和手动输入按顺序追加，不再覆盖已有内容；每段识别结果以英文逗号结尾 |
| 历史消息 | 上滑接近更早消息时自动加载，不再需要点击提示文字 |
| 文本选择 | 长按选择正文、点击其他区域取消选择时保持当前滚动位置，不再随机跳动 |
| 折叠内容 | 思考工具、工具调用和上下文压缩展开或收起时保持阅读锚点 |
| 会话状态 | 会话设置面板顶部新增“会话状态”入口，和 `/status` 共用同一份状态 |
| 冷启动 | 通过会话链接冷启动时，等待主机信息恢复后再发起连接 |

## 下载

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-0.1.2-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-0.1.2-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-0.1.2-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 与 sherpa-onnx |
| `ocremote-host-0.1.2-linux-arm64.tar.gz` | Linux | arm64 | 主机端，自带 arm64 Bun 与 sherpa-onnx |
| `ocremote-relay-0.2.0-linux-amd64` | Linux | x86_64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 + CA 安装脚本 |
| `ocremote-relay-0.2.0-linux-arm64` | Linux | arm64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 + CA 安装脚本 |

## 快速开始

| 端 | 操作 |
|---|---|
| 手机 | 安装对应架构的 APK，打开后扫码或粘贴主机配对链接 |
| 主机 x64 | `tar xzf ocremote-host-0.1.2-linux-x64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 主机 arm64 | `tar xzf ocremote-host-0.1.2-linux-arm64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 中继（可选） | 启动 `ocremote-relay`，用 host invite 登记主机，再用新的配对码连接手机 |

## 说明

| 项目 | 说明 |
|---|---|
| APK 签名 | 当前使用 Expo debug keystore，正式分发前需替换生产 keystore |
| TLS 信任 | Release APK 只信任 Android 系统 CA 库，不包含开发测试 CA |
| 加密 | 直连和中继都保持手机↔主机 Noise 端到端加密 |
| 校验 | `sha256sum -c SHA256SUMS` |

完整功能与三端用法见 [README](https://github.com/primercoder/opencode-app/blob/main/README.md)。
