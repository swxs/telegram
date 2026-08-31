# Changelog

## [0.3.1] - 2026-08-31

修复本地构建与 `dsh web` 加载时缺少 `dsh-llm` 运行时依赖的问题。

### Fixed

- `scripts/build.sh` 链接 `@deepseek-ai/dsh-timeout`（`dsh-llm` 的 peer 依赖），避免插件加载时报 `Cannot find package '@deepseek-ai/dsh-timeout'`。

## [0.3.0] - 2026-08-28

对话期交互：模型提问与工具授权走 Telegram，并与 web 同载共存。

### Added

- Telegram 会话注册 `tele_ask_user`（隐藏全局 `ask_user_question`），用 Inline Keyboard / ForceReply 完成模型提问；并写入会话级 system prompt，提示模型走该工具。
- 工具授权（`approval/request`）投递到 Telegram（Allow once / Reject / Cancel），与 Web 端 race。
- 每个聊天 FIFO 排队：同时只展示一条 pending 交互；有 pending 时普通文本不转发给 agent。

### Fixed

- 绑定 Workspace / 创建会话失败时向聊天报错，而不再静默中断。

## [0.2.0] - 2026-08-18

Command Menu、Workspace / Skill 选择，以及 Bot API 代理。

### Added

- `/init`（Init Admin）登记 Telegram Command Menu。
- `/start` 从 `workspaceRegistry` 选择 Workspace 再建会话；切换 Workspace 会 park 旧会话，`/clear` 在当前绑定下新开。
- `/skills` 分页列出 Skill，`//name` 改写为 `/name` 后转发给 agent。
- Bot API 支持 HTTP/HTTPS 代理（`proxy` 或 `HTTPS_PROXY` / `HTTP_PROXY`），走 HTTP CONNECT，不改进程环境变量。

### Changed

- 去掉 `/new`，只保留 `/clear` 作为会话重置。
- 加载时强制要求 `agentPresets`。

### Fixed

- 长轮询遇到畸形 `getUpdates` 响应时记录日志并继续，不再打崩 poll loop。

## [0.1.0] - 2026-08-05

从 harness 抽出独立 Cordis 插件：Bot API 长轮询、每聊天 agent 会话、用户白名单、HTML 格式化与 4096 字符分片。
