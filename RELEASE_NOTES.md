# OC Remote 0.1.6

主机端与中继端的连接方式简化：中继只提供地址，不再生成 host link；手机邀请严格改为 `pair` 时按需申请。

## 版本

| 组件 | 版本 |
|---|---|
| 手机 / 主机 | `0.1.6` |
| Android versionCode | `8` |
| 中继 | `0.4.1` |

## 中继端

- 启动时不再打印 `ocremote-relay://host#...` 长链接。
- 移除 `admin link` 和 `HostLink` 生成逻辑。
- 启动输出只保留：relay id、监听地址、ws URL、TLS 状态、主机/手机限额、数据目录和管理 socket。
- 主机连接时 welcome 只返回 room、subject secret 和 `clientInvite` 能力，不再下发手机邀请。
- 只有主机发送 `relay.invite` 控制帧时才创建手机邀请：
  - 一次性
  - 绑定当前 host room
  - 每次请求不同
  - 请求带 `id`，回复回传 `id`
- 同一主机重复连接不会产生未使用的手机邀请。

## 主机端

- 中继连接只需要地址：

```bash
ocremote relay                       # 默认 118.31.124.193:8443
ocremote relay 1.2.3.4:8443          # 自定义
ocremote relay status
ocremote relay off
ocremote relay on
```

- 首次连接通过 `GET /v1/info` 获取：
  - `relayId`
  - `wsUrl`
  - `relayPublicKey`
- 中继 key 首次获取后固定保存；key 变化会拒绝连接，只有 `--refresh-key` 才接受新 key。
- 删除 `clientInvite` 缓存。
- `ocremote pair` 时才调用 `requestClientInvite()`；申请失败不再回退旧邀请。
- 连续两次 `pair` 会得到两个不同的手机 invite。
- 主机仍可识别旧 host link 做迁移，但帮助和文档只推荐 IP:端口。

## 手机端

- 手机端逻辑不变。
- 配对码仍包含 relay URL、room、relayKey 和本次专属手机 invite，扫码后自动登记。

## 部署

- 中继 `0.4.1` 已部署到 `alisvr`：
  - URL：`ws://118.31.124.193:8443/ws`
  - 保留原 `relay-identity.json` 和 `relay.db`
  - 更新 systemd 参数，移除 `serve`/`--no-tls`
- 主机 `0.1.6` 已部署到 `~/Desktop/usage-test/ocremote`：
  - 旧版进程已停止
  - 仅启用中继，不开启直连
  - 主机已登记到默认云中继
  - 手机通过中继完成配对和连接

## 验证

- 协议测试 30 通过
- 主机测试 17 通过
- 手机测试 74 通过
- 中继 Go 测试通过
- 本机地址解析、`/v1/info` key 固定、key 变化拒绝测试通过
- 云中继验证：
  - 启动无 host link
  - 主机只用 IP:端口登记
  - pair 前无手机邀请
  - `pair` 两次得到两个不同 invite
  - 手机通过专属 invite 自动登记并连接
- 主机 `status` 只显示 relay，不显示直连
