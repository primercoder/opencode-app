# OC Remote 0.1.8

手机端 Agent 列表过滤修复。

## 版本

| 组件 | 版本 |
|---|---|
| 手机 | `0.1.8` |
| Android versionCode | `10` |
| 主机 | `0.1.6` |
| 中继 | `0.4.1` |

## 修复

- Agent 选择器只显示：
  - `mode === "primary"`
  - `hidden !== true`
- 排除 opencode 内部 Agent：
  - `compaction`
  - `title`
  - `summary`
- 排除 subagent：
  - `general`
  - `explore`
- 用户自建且可见的 primary Agent 仍会正常显示。
- 默认 Agent 从过滤后的可见列表选择，优先 `build`。

## 验证

- 协议测试 30 通过
- 主机测试 17 通过
- 手机测试 75 通过
- 新增 Agent 过滤测试：只保留 `build`、`plan` 和自定义可见 primary Agent
