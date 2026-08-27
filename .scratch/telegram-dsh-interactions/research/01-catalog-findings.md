# DSH 对话期交互 Catalog（Research 01）

> 来源：deepseek-harness `packages/interaction/` 文档与 API 词汇表；dsh-telegram 代码审阅。  
> 状态：初稿，待 [01-catalog-dsh-interactions](../issues/01-catalog-dsh-interactions.md) 正式关闭。

## 阻塞回合的交互（必须有人类响应）

### 1. 用户提问（User Questions）

| 项 | 内容 |
|---|---|
| **Cordis 接线** | `ctx.userQuestions.registerProvider()` |
| **触发** | 模型工具 `ask_user_question`（`dsh-tool-ask-user`）或插件直接 `ctx.userQuestions.ask()` |
| **请求** | `{ questions: [{ id, question, detail?, header?, options?: [{ label, description? }], multiSelect?, intent? }] }` |
| **应答** | `{ answers: [{ id, selected: string[], custom? }] }` |
| **阻塞** | 是 — provider 未 resolve 则回合挂起 |
| **Telegram 现状** | 否 — 未注册 provider |

特殊 intent：`plan-review`（见 #3）

### 2. 工具执行授权（User Approval）

| 项 | 内容 |
|---|---|
| **Cordis 接线** | `ctx.on('approval/request', handler)` waterfall answerer |
| **触发** | 工具/bash 执行前，policy 为 `ask` |
| **请求** | `{ agent, toolName, callId?, reason?, signal? }` |
| **应答** | `ApprovalOutcome`: `allowed-once` \| `rejected` \| `cancelled` \| `unavailable` |
| **阻塞** | 是 — 无 answerer 且 policy=ask → fail-closed 为 `unavailable` |
| **Telegram 现状** | 否 — 无 listener |

### 3. 计划审核（Plan Review）

| 项 | 内容 |
|---|---|
| **Cordis 接线** | 同上 User Questions provider（`intent: { kind: 'plan-review', approve: '<label>' }`） |
| **触发** | `exit_plan_mode` 工具（`dsh-plan-mode`） |
| **请求** | questions 形态 + `detail` 为完整 markdown 计划 |
| **应答** | 选 approve label → 批准；否则带用户反馈 reject |
| **阻塞** | 是 |
| **Telegram 现状** | 否 — 依赖 #1；示例 cordis 未加载 plan-mode |

## 非阻塞但对话期相关的交互

### 4. 权限预设（Permission Presets）

| 项 | 内容 |
|---|---|
| **Cordis 接线** | `ctx.permissionPresets` |
| **行为** | 切换 sandbox 模式 + approval policy（如 `workspace-write` vs `danger-full-access`） |
| **阻塞** | 否 — 除非用户主动切换；影响后续 #2 是否触发 |
| **Telegram 现状** | 否 — Web 有 Settings UI |

### 5. Harness 内 Slash 命令

| 项 | 内容 |
|---|---|
| **Cordis 接线** | `ctx.commands` |
| **示例** | `/plan`、`/permissionPresets` |
| **阻塞** | 否 — 用户主动触发 |
| **Telegram 现状** | 否 — 桥的 `/start`/`/clear` 等是本地命令，不进入 harness |

## 会话事件（审计/展示，非交互式阻塞）

| 事件 | 用途 | Telegram 现状 |
|---|---|---|
| `turn/start` | 回合开始 | 部分 — 发 typing |
| `turn/end` | 回合结束 | 否 |
| `assistant/message` | 模型可见文本 | 是 — HTML 投递 |
| `assistant/chunk` | 流式 chunk（log-only） | 否 |
| `tool/call` / `tool/result` | 工具调用/结果 | 否 |
| `approval/asked` / `approval/decided` | 授权审计 | 否（需 #2 才有 UI） |
| `plan/mode` | 计划模式开关 | 否 |
| `permission/preset` / `sandbox/mode` / `approval/policy` | 权限状态 | 否 |

## dsh-telegram 已实现的桥本地 UI（非 DSH session 交互）

| 功能 | 触发 | Telegram 组件 |
|---|---|---|
| 用户白名单 | 任意入站 | 纯文本拒绝 / callback toast |
| Workspace 选择 | `/start`、未绑定时 | Inline Keyboard `callback_data: ws:<id>` |
| Skill 选择 | `/skills` | Inline Keyboard `copy_text` + 分页 `sk:<page>` |
| Command Menu | `/init`（Init Admin） | `setMyCommands` |

## 示例部署缺口

`examples/telegram-agent/cordis.yml` 未加载：

- `@deepseek-ai/dsh-user-questions`
- `@deepseek-ai/dsh-tool-ask-user`
- `@deepseek-ai/dsh-user-approval`
- `@deepseek-ai/dsh-permission-presets`
- `@deepseek-ai/dsh-plan-mode`

因此即使用户通过 Telegram 发消息，agent 调用提问或触发 approval 时无人类响应通道。
