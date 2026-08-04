# @dsh-external/telegram

English | [中文](README.zh.md)

## Install (dshx / Marisa external plugin)

```sh
dshx install telegram <dir|git-url>
```

- Manifest id: `telegram` (dsh.plugin.json); contributes no model-facing tools
  or skills — it is a background service bridging Telegram chats to agent
  sessions.
- **Token required at load**: `apply` fails loudly without a bot token (config
  `token` or the `DSH_TELEGRAM_TOKEN` environment variable); there is no lazy
  start without one.
- **Host prerequisite**: the dsh composition must mount an `agents` service
  (`@deepseek-ai/dsh-agent`); the LLM adapter, sessions, and tools come from
  the surrounding `cordis.yml` (see the
  [`telegram-agent`](examples/telegram-agent/README.md) example).
- Remove: `dshx remove telegram`.

## Overview

The `telegram` plugin bridges Telegram chats to harness agent sessions through the Bot API's long polling, one agent session per chat. The design follows [Hermes](https://github.com/NousResearch/hermes-agent)' telegram platform adapter — per-chat sessions, user allowlist, HTML formatting, 4096-char splitting, and a typing indicator — trimmed to the harness's text-first seams. [`telegram-agent`](examples/telegram-agent/README.md) is the runnable `cordis.yml` application.

## Wiring

`inject: ['agents']`. Each authorized text message creates or reuses one agent per chat (`ctx.agents.create`), forwards the text as a user message via `followup`, and delivers every `assistant/message` text back to the chat as split, HTML-formatted Telegram messages. Commands: `/start` (welcome), `/new` and `/clear` (fresh session, previous agent disposed), `/help`. The LLM adapter, sessions, and tools come from the surrounding `cordis.yml`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `token` | `''` | Bot token from @BotFather; an empty value falls back to `DSH_TELEGRAM_TOKEN` |
| `allowedUserIds` | `[]` | Telegram user ids allowed to talk to the bot; an empty list denies everyone |
| `allowAllUsers` | `false` | Allow any user (development only) |
| `provider` | `deepseek-official` | LLM provider id passed to each created agent |
| `model` | `deepseek-v4-flash` | Model id passed to each created agent |
| `maxMessageLength` | `4096` | Per-chunk Telegram message length limit |
| `pollingTimeoutSec` | `30` | Long-polling timeout in seconds |

A missing token fails loudly at load. With no allowlist configured the bot denies every user (fails closed). `TelegramConfig` also accepts runtime-only `client` and `sleep` seams for tests; production uses global `fetch` and real timers. All errors are logged through `ctx.logger` with the bot token redacted.

## Delivery semantics

- Assistant text is converted with a conservative Markdown subset (fenced code → `<pre>`, inline code → `<code>`, `**bold**` → `<b>`, everything else HTML-escaped) and split at `maxMessageLength`, preferring newline, ideographic-period, and period-space breaks.
- A Telegram rejection of the HTML body (malformed entities after splitting) falls back to plain text for that chunk.
- `turn/start` sends the `typing` chat action; deliveries are fire-and-forget with per-chunk logging.
- A single long-polling loop serves all chats; empty batches sleep a 50 ms cadence floor so an instant-empty transport cannot hot-loop the event loop.

## Model Experience

### Telegram user message

#### What the model sees

For each incoming chat message, the model receives the message text verbatim as one user message in that chat's session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`. Commands (`/start`, `/new`, `/clear`, `/help`) never reach the model.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The polling frames, chat bookkeeping, and delivery calls add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Text messages only** — photos, documents, voice, stickers, and captions are ignored.
- **Private chats only** — group mentions and forum topics are not handled.
- **One message per assistant output** — intermediate tool progress is not streamed as separate editable Telegram messages.
- **Long polling only** — no webhook mode, so the host must be able to reach Telegram's API outbound.
- **No retry beyond the plain-text fallback** — a failed delivery is logged and dropped; Hermes-style send retries and delivery ledgers are deferred.
