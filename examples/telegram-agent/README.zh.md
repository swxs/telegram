# telegram-agent

[English](README.md) | 中文

Telegram Bot API 编码 agent 组合：给 bot 发消息，harness agent 回复，每个聊天一个会话。桥接设计参照 [Hermes](https://github.com/NousResearch/hermes-agent) 的 telegram 平台适配器——每聊天会话、用户白名单、HTML 格式化、4096 字符分片、typing 指示——裁剪为仅文本消息。

telegram 一行挂载的是本仓库的构建产物（相对本配置的 `../../lib/index.js`）。要在 DeepSeek Harness checkout 里运行桥接，请先用 `dsh plugin --profile web add <dir|git-url>` 安装插件，并把该行指向挂载后的入口。

模型可见工具：

- `bash`（仅前台）
- `read`、`write`、`edit`
- `subagent`（一个前台进程内 spawn provider）
- `todo_write`

组合还加载了 JSONL 会话持久化与自动上下文压缩。

## 运行时环境变量

| 变量 | 用途 |
|---|---|
| `DSH_TELEGRAM_TOKEN` | @BotFather 创建的 bot token（必填） |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | 允许与 bot 对话的 Telegram 用户 id（逗号分隔） |
| `DSH_TELEGRAM_ALLOW_ALL_USERS` | `true` 时允许任意用户（仅开发用） |
| `DEEPSEEK_API_KEY` | 传给 OpenAI 兼容端点的凭据 |
| `DEEPSEEK_BASE_URL` | `dsh-llm-deepseek` 使用的主机端点 |
| `DSH_CWD` | bash 与文件工具的 agent 工作目录 |
| `DSH_SESSION_ROOT` | JSONL 轨迹目录 |
| `DSH_SYSTEM_PROMPT` | 部署提供的编码 persona |

未配置白名单时 bot 拒绝所有用户（fail closed）。命令：`/start`、`/clear`（重置会话）、`/help`。

## 运行

需要一个提供 `@deepseek-ai/*` 组合包的 DeepSeek Harness checkout（这些行从 checkout 的 node_modules 解析；`dsh` 在 PATH 上）。

```bash
cd examples/telegram-agent
DSH_TELEGRAM_TOKEN=<token> DSH_TELEGRAM_ALLOW_ALL_USERS=true \
  DEEPSEEK_API_KEY=<key> dsh --config cordis.yml
```

## 已知限制与待办

- 仅文本消息：照片、文档、语音、贴纸会被忽略。
- 仅私聊：群聊 @ 提及与话题（topics）未处理。
- 每条回复一条消息：工具中间进度不会作为独立消息流式发送。
- 仅长轮询：无 webhook 模式，进程需可出站访问 Telegram 服务器。
