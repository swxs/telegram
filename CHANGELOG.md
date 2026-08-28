# Changelog

## [0.2.0] - 2026-08-28

Telegram 桥接到 harness 的能力从「纯文本转发」扩到 Workspace 会话、Skill、代理，以及对话期的模型提问与工具授权。

### Added

- `/start` 从 `workspaceRegistry` 选择 Workspace 再建会话；切换 Workspace 会 park 旧会话，`/clear` 在当前绑定下新开。
- `/init`（Init Admin）登记 Telegram Command Menu；`/skills` 分页列出 Skill，`//name` 改写为 `/name` 后转发给 agent。
- Bot API 支持 HTTP/HTTPS 代理（`proxy` 或 `HTTPS_PROXY` / `HTTP_PROXY`），走 HTTP CONNECT，不改进程环境变量。
- Telegram 会话注册 `tele_ask_user`（隐藏全局 `ask_user_question`），用 Inline Keyboard / ForceReply 完成模型提问；并写入会话级 system prompt，提示模型走该工具。
- 工具授权（`approval/request`）投递到 Telegram（Allow once / Reject / Cancel），与 Web 端 race。
- 每个聊天 FIFO 排队：同时只展示一条 pending 交互；有 pending 时普通文本不转发给 agent。

### Changed

- 包名改为 `@swxs/telegram`。
- `inject` 不再包含 `userQuestions`，也不注册 provider，避免与 web `api-gateway` 冲突。计划审核（`exit_plan_mode`）不由本插件处理。
- 加载时强制要求 `agentPresets` 与 `approval`；缺少 bot token 仍 fail loud。
- 去掉 `/new`，只保留 `/clear` 作为会话重置。

### Fixed

- 绑定 Workspace / 创建会话失败时向聊天报错，而不再静默中断。
- 长轮询遇到畸形 `getUpdates` 响应时记录日志并继续，不再打崩 poll loop。

## [0.1.0] - 2026-08-05

从 harness 抽出独立 Cordis 插件：Bot API 长轮询、每聊天 agent 会话、用户白名单、HTML 格式化与 4096 字符分片。
