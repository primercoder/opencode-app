# OC Remote 0.1.3

三端认证体系重构：内置 Noise NK 认证，默认无需第三方 CA，同时保留可选 TLS。

## 本次更新

| 项目 | 内容 |
|---|---|
| 中继认证 | 新增 Noise NK v3 握手；中继身份由邀请链接中的 X25519 公钥固定 |
| 简化部署 | 中继可直接以 `ws://` + `--no-tls` 运行，只需要公网 IP 和端口；TLS 仍可叠加 |
| Token 保护 | host/client 的邀请和长期 secret 只在 Noise 加密 payload 中传输，不再明文发送 |
| 控制帧保护 | 主机的中继控制消息（邀请刷新、peer 通知等）使用 Noise transport 加密 |
| 应用数据 | 手机↔主机仍然保持独立 Noise 端到端加密，中继只能看到密文 |
| 身份固定 | 邀请包含 `rk` 中继公钥；主机和手机静默校验，不需要证书确认弹窗 |
| 部署简化 | 中继数据、身份、日志和 admin socket 都集中在安装目录下 |
| 兼容性 | 协议升级到 v3；旧的 0.1.2 中继主体和配对码需要重新登记/配对 |

## 升级说明

这次是认证协议变更，不能与旧版中继或旧配对码混用：

1. 升级中继到 `0.3.0`
2. 主机重新执行一次 `--relay-link` 登记
3. 手机重新扫描主机配对码

主机和手机配对成功后，后续使用 `--relay` 即可复用长期身份。

## 下载

| 文件 | 平台 | 架构 | 用途 |
|---|---|---|---|
| `ocremote-0.1.3-android-arm64-v8a.apk` | Android | arm64-v8a | 真机、平板 |
| `ocremote-0.1.3-android-x86_64.apk` | Android | x86_64 | 模拟器、x86_64 设备 |
| `ocremote-host-0.1.3-linux-x64.tar.gz` | Linux | x86_64 | 主机端，自带 Bun 与 sherpa-onnx |
| `ocremote-host-0.1.3-linux-arm64.tar.gz` | Linux | arm64 | 主机端，自带 arm64 Bun 与 sherpa-onnx |
| `ocremote-relay-0.3.0-linux-amd64` | Linux | x86_64 | 中继二进制 |
| `ocremote-relay-0.3.0-linux-amd64.tar.gz` | Linux | x86_64 | 中继 + 说明 |
| `ocremote-relay-0.3.0-linux-arm64` | Linux | arm64 | 中继二进制 |
| `ocremote-relay-0.3.0-linux-arm64.tar.gz` | Linux | arm64 | 中继 + 说明 |

## 简化中继启动

```bash
./ocremote-relay serve \
  --data-dir /opt/ocremote/relay/data \
  --listen 0.0.0.0:8443 \
  --public-url ws://<公网IP>:8443/ws \
  --no-tls
```

首次启动会打印一次性 host invite：

```text
ocremote-relay://enroll#...
```

主机登记：

```bash
ocremote start --listen 0.0.0.0:8787 \
  --relay-link 'ocremote-relay://enroll#...'
```

## 快速开始

| 端 | 操作 |
|---|---|
| 手机 | 安装对应架构的 APK，打开后扫码或粘贴主机配对链接 |
| 主机 x64 | `tar xzf ocremote-host-0.1.3-linux-x64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 主机 arm64 | `tar xzf ocremote-host-0.1.3-linux-arm64.tar.gz && cd ocremote && ./ocremote start --listen 0.0.0.0:8787 --pair` |
| 中继（可选） | 启动 `ocremote-relay`，用 host invite 登记主机，再用新的配对码连接手机 |

## 说明

| 项目 | 说明 |
|---|---|
| APK 签名 | 当前使用 Expo debug keystore，正式分发前需替换生产 keystore |
| 加密 | 直连和中继的应用数据都保持手机↔主机 Noise 端到端加密 |
| 中继身份 | 邀请内的 X25519 公钥固定中继身份，不依赖证书或 CA |
| 校验 | `sha256sum -c SHA256SUMS` |

完整功能与三端用法见 [README](https://github.com/primercoder/opencode-app/blob/main/README.md)。
