# Wayfinder Map: Telegram 侧 DSH 对话期交互

Type: wayfinder:map

## Destination

一份可交付的《DSH 对话期交互 → Telegram Bot 组件映射规范》：覆盖所有会导致 agent 回合阻塞、需人类输入的 DSH 服务端交互；明确每种交互在 Telegram 侧应使用的 Bot API 组件、callback 命名约定与 Cordis 接线点（provider / answerer），供后续实现。

## Notes

- 仓库：`dsh-telegram`；现有桥接逻辑见 `src/bridge.ts`、`src/client.ts`、`CONTEXT.md`
- 上游交互定义在 `deepseek-harness/packages/interaction/`（本仓库无 node_modules，需对照 harness 文档或 checkout）
- 会话内 `handleSessionEvent` 目前仅处理 `turn/start` 与 `assistant/message`
- 示例 `examples/telegram-agent/cordis.yml` 未加载 user-questions / user-approval 等 interaction 包
- Telegram 侧已用组件：Inline Keyboard（`callback_data`、`copy_text`）、Command Menu；明确避免 Reply Keyboard（见 CONTEXT.md）

## Decisions so far

<!-- 每关闭一张 ticket 追加一行 -->

## Not yet specified

- 同一聊天多条 pending 交互（question + approval 并发）的排队 / 覆盖策略
- 实现形态：扩展现有 `TelegramBridge` vs 独立 `@deepseek-ai/dsh-telegram-interaction` 插件
- v1 是否包含：权限预设切换 UI、Harness 内 slash 命令转发、工具进度流式展示
- 计划审核（plan-review intent）长 markdown 的分片与按钮布局细节
- 示例 cordis.yml 应加载哪些 interaction 包及默认 approval policy
- 交互超时 / 用户取消后的 Telegram 消息状态（edit 去掉按钮 vs 追加说明）

## Out of scope

- Webhook 模式（README 明确仅 long polling）
- 媒体消息入站（照片、文档、语音——README 已知限制）
- 群聊 @ 提及与 topics
