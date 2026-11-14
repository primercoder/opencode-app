# OC Remote 0.1.0

Android 远程控制 opencode 的首个公开版本。主机直连或自建中继，应用数据使用 Noise NK 端到端加密，中继只转发密文。

## 下载

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-0.1.0-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-0.1.0-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-0.1.0-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 与 sherpa-onnx |
| `ocremote-relay-0.2.0-linux-amd64` | Linux | x86_64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 + CA 安装脚本 |
| `ocremote-relay-0.2.0-linux-arm64` | Linux | arm64 | 中继二进制 |
| `ocremote-relay-0.2.0-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 + CA 安装脚本 |

## 快速开始

| 端 | 操作 |
|---|---|
| 手机 | 安装对应架构的 APK，打开后扫码或粘贴主机配对链接 |
| 主机 | `tar xzf ocremote-host-0.1.0-linux-x64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 中继（可选） | 启动 `ocremote-relay`，用 host invite 登记主机，再用新的配对码连接手机 |

## 说明

| 项目 | 说明 |
|---|---|
| APK 签名 | 当前使用 Expo debug keystore，正式分发前需替换生产 keystore |
| TLS 信任 | Release APK 只信任 Android 系统 CA 库，不包含开发测试 CA |
| 加密 | 直连和中继都保持手机↔主机 Noise 端到端加密 |
| 校验 | `sha256sum -c SHA256SUMS` |

完整功能与三端用法见 [README](https://github.com/primercoder/opencode-app/blob/main/README.md)。
