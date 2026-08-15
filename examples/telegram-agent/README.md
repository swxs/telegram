# telegram-agent

English | [中文](README.zh.md)

The Telegram Bot API coding-agent composition: message the bot and a harness agent replies, with one session per chat. The bridge design follows [Hermes](https://github.com/NousResearch/hermes-agent)' telegram platform adapter — per-chat sessions, user allowlist, HTML formatting, 4096-char splitting, and a typing indicator — trimmed to text messages only.

The telegram row mounts this repository's build output (`../../lib/index.js` relative to this config). To run the bridge from a DeepSeek Harness checkout instead, install the plugin there first with `dsh plugin --profile web add <dir|git-url>` and point the row at the mounted entry.

The model-facing tools are:

- `bash`, foreground only
- `read`, `write`, and `edit`
- `subagent`, using one foreground in-process spawn provider
- `todo_write`

The surrounding composition also loads JSONL session persistence and automatic context compaction.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DSH_TELEGRAM_TOKEN` | Bot token from @BotFather (required) |
| `DSH_TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user ids allowed to talk to the bot |
| `DSH_TELEGRAM_ALLOW_ALL_USERS` | `true` allows any user (development only) |
| `DEEPSEEK_API_KEY` | Credential passed to the OpenAI-compatible host endpoint |
| `DEEPSEEK_BASE_URL` | Host endpoint used by `dsh-llm-deepseek` |
| `DSH_CWD` | Agent workspace for bash and filesystem tools |
| `DSH_SESSION_ROOT` | JSONL trajectory directory |
| `DSH_SYSTEM_PROMPT` | Deployment-provided coding persona |

With no allowlist configured the bot denies every user (fails closed). Commands: `/start`, `/clear` (reset the session), `/help`.

## Running

Requires a DeepSeek Harness checkout providing the `@deepseek-ai/*` composition packages (their rows resolve from the checkout's node_modules; `dsh` on PATH).

```bash
cd examples/telegram-agent
DSH_TELEGRAM_TOKEN=<token> DSH_TELEGRAM_ALLOW_ALL_USERS=true \
  DEEPSEEK_API_KEY=<key> dsh --config cordis.yml
```

## Known Limitations and Deferred Work

- Text messages only: photos, documents, voice, and stickers are ignored.
- Private chats only: group mentions and forum topics are not handled.
- One in-flight assistant message per reply: intermediate tool progress is not streamed as separate messages.
- Long-polling only: no webhook mode, so the process must stay reachable from Telegram's servers in the polling direction (outbound).
