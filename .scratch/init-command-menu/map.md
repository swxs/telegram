# Map: `/init` Command Menu spec

## Destination

A handoff-ready spec: an Init Admin sends `/init`, and the bot registers or overwrites its default Command Menu as `/start`, `/new`, `/clear`, `/help`, `/init` (English, aligned with `/help`). The plugin does not register the menu on startup. The spec states config, copy, and failure semantics so someone else can implement.

## Notes

- Domain: Telegram bridge. Read `CONTEXT.md` before every session; keep grilling and domain-modeling in play; use research for Bot API facts.
- Planning only. Do not implement `/init` or `setMyCommands` on this map.
- Tracker: local markdown under `.scratch/init-command-menu/`. Refer to the map and tickets by title, not by number alone.
- Locked in charting (detail lives in this session, not in tickets): Command Menu via `setMyCommands`; `/init` overwrites the bot-default menu then confirms; init-only (no startup registration); menu entries are the five Slash Commands above; Init Admin list is a dedicated subset of the allowlist and fail-closes when empty; copy is English and aligned with `/help`.

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [Research: Telegram setMyCommands contract](issues/01-telegram-setmycommands-contract.md) — Default-scope `setMyCommands` replaces that slot (no merge); omit `language_code` for the unlocalized fallback; `deleteMyCommands` is only for clear.

## Not yet specified

- Client seam and test expectations for calling `setMyCommands` (default scope, no `language_code`) and asserting via `getMyCommands` on that same slot.

## Out of scope

- Implementing `/init` or shipping the Command Menu — this map ends at the spec.
- Registering the Command Menu on plugin startup.
- Reply Keyboard, Chat Menu Button, and Web App menus.
- Per-chat or per-user Command Menu scopes.
- Group chats, topics, and non-text messages (existing bridge limits).
- Chinese product copy.
- First-wins / non-overwriting `/init`.
