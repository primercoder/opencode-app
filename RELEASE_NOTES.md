# OC Remote 0.1.4

主机端、中继端和手机端一起更新。这次重点是**连接方式可控、中继部署简化、手机界面不添乱**。

## 版本

| 组件 | 版本 |
|---|---|
| 手机 / 主机 | `0.1.4` |
| Android versionCode | `6` |
| 中继 | `0.4.0` |
| 中继协议 | `v3`（Noise NK；扩展开放主机登记） |

## 主机端

- 命令行重新设计：
  - `ocremote start` 只负责启动，读取已保存的直连/中继设置
  - `ocremote direct [地址|off]` 动态开关或修改直连
  - `ocremote relay [host-link|on|off]` 动态登记、启用或关闭中继
  - `ocremote pair` 只输出实际启用的线路
- 运行中修改立即生效，不再提示 `host is running` 后拒绝：
  - 只开中继后可以随时加直连
  - 只开直连后可以随时加中继
  - 修改一边不会影响另一边
- `relay off` 保留中继身份，`relay on` 或同一 host link 可重新启用，不会重复占用中继名额。
- 配对输出按线路拆分：
  - `Direct · same LAN`：只包含直连
  - `Relay · any network`：只包含中继
  - 只有中继时不会出现 `127.0.0.1` 直连
  - 只有直连时不会出现中继
  - 回环地址永不放进手机配对码
- `status` 只显示真实启用的线路。
- 旧版 `start --listen/--pair/--relay-link` 等参数移除，帮助文档给出完整常规流程示例。

## 中继端

- 默认使用 `ws://` + Noise NK，公网 IP 即可启动，不需要证书或 `init`。
- 移除自动生成自签 CA、`--no-tls`、`--tls-ca`、`--rotate-tls` 和 host invite 流程。
- TLS 仍是可选传输层，通过 `--tls-cert/--tls-key` 或反向代理启用。
- 任意 OC Remote 主机可自行登记，不需要预发 host invite：
  - 主机发送稳定 `hostId`
  - 中继分配 subject secret 和 room
  - 同一活动 `hostId` 不能重复登记
- 新增容量限制：
  - `--max-hosts` 默认 `3`
  - `--max-clients` 默认 `3`（每个主机房间）
  - 超限返回 `RELAY_HOST_LIMIT` / `RELAY_ROOM_FULL`
- 启动时打印可复用 `ocremote-relay://host#...`：
  - 只固定中继 X25519 公钥
  - 不包含一次性秘密
  - 主机保存长期 subject secret 后重连
- 管理命令精简为 `status`、`hosts`、`clients`、`rooms`、`link`、`revoke`。
- 帮助文档包含公网 IP、可选 TLS、限额和常用管理示例。

## 手机端

- 修复主机设置里的二维码扫描：
  - 新增全屏相机扫描层
  - 不再把 `CameraView` 套在透明 BottomSheet 和 ScrollView 里
  - 进入扫描自动请求相机权限
- 移除“中继访问/已登录”手动卡片：
  - 中继只从主机配对码里的 invite 自动登记
  - 不再要求手动粘贴手机邀请
- 连接方式固定为直连和中继两类：
  - 同一类型再次添加会覆盖旧线路
  - 最多各一条，不再堆叠
  - 配对时按类型合并，不会因为新增直连而丢掉中继
  - 有中继时清理旧版遗留的回环直连
- 消息正文取消长按复制，移除选择工具栏带来的跳动。
- 折叠区域重新使用底边锚定：
  - 卡片在自身 `onLayout` 中报告高度变化
  - 列表偏移按同一 delta 立即调整，不再等待 `requestAnimationFrame`
  - 展开内容保持可见，避免固定标题导致内容被输入框遮住
  - 折叠后回到原位置，不再出现一帧跳动
- 展开内容仍可正常显示思考、工具输入输出和压缩摘要。

## 升级说明

- 主机和中继都需要更新到本次版本；手机 APK 也要更新。
- 旧版中继的 host invite 不再签发。升级后：
  1. 启动中继 0.4.0
  2. 复制启动输出的 host link
  3. 在主机执行 `ocremote relay '<host link>'`
  4. 手机重新扫描主机生成的配对码
- 旧版已保存的 relay subject 仍可用于 Noise NK 认证；如果主机配置丢失，管理员可用 `admin revoke <subjectId>` 释放名额后重新登记。
- 旧配对码不能继续使用，需要重新生成。

## 安全模型

| 项目 | 机制 |
|---|---|
| 应用数据 | 手机↔主机 Noise NK 端到端加密 |
| 中继认证 | Noise NK；host link 固定中继 X25519 公钥 |
| 主机/手机凭据 | subject secret 只在 Noise 加密 payload 中传输 |
| 主机控制帧 | Noise transport 加密 |
| 手机邀请 | 一次性、绑定 room |
| TLS | 可选；Noise NK 认证不依赖证书 |
| 开放登记边界 | 任何实现协议的主机可尝试登记；用 `max-hosts`、revoke 和 room 隔离控制 |

## 验证

- 协议测试 30 项通过
- 主机测试 14 项通过
- 手机测试 72 项通过
- 中继 Go 测试通过，包括开放主机登记、3 台上限、每房间 3 台手机上限
- TypeScript 检查通过
- Docker 中继 + 主机端到端测试通过
- Android 模拟器验证：
  - 只有中继时不出现直连
  - 只有直连时不出现中继
  - 全屏扫码入口、相机权限
  - 连接方式覆盖与配对合并
  - 折叠展开锚点与正文复制移除
