# telegram

## 项目

读 [CONTEXT.md](CONTEXT.md) 本仓库术语表。

这是一个 Cordis 插件：把已授权的 Telegram 私聊接到 harness agent 会话。模型、工具、会话由外围 `cordis.yml` 提供。

## 目录

- `src/` 插件源码。入口是 `index.ts`（`name` / `inject` / `Config` / `apply`）；会话与命令在 `bridge.ts`；Bot API 在 `client.ts`；消息格式在 `format.ts`；代理在 `proxy.ts`。
- `tests/` 对应各模块的 Vitest。
- `lib/` `tsc` 编译产物。运行时和 `dsh plugin add` 加载的是这里，改完 `src/` 需要重新编译；不要手改 `lib/`。
- `examples/telegram-agent/` 可运行的 `cordis.yml` 组合。
- `scripts/` 构建脚本（需要 `DSH_CHECKOUT` 指向 harness 源码树时用）。
- `docs/` 历史开发记录。
- `CONTEXT.md` 领域用语；`README.md` 安装与配置。

## 历史

动手改功能前，先读 `docs/` 下的文档，了解这项能力是怎么定下来的、做过哪些取舍。
