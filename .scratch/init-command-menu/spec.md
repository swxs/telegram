# `/init` Command Menu

Handoff spec for [Map: `/init` Command Menu spec](map.md). Decisions live in the closed tickets; this file is what to implement. Terms: `CONTEXT.md`.

An **Init Admin** sends `/init`. The bridge registers or overwrites the bot's default **Command Menu** as the four Slash Commands below. The plugin does not register the menu on startup. `/init` is not in the menu and not in `/help`.

## Behavior

Authorization is unchanged: `allowedUserIds` / `allowAllUsers` first. Unauthorized users still get `Access denied.` and never reach command handling.

Then:

| Caller | `/init` |
| --- | --- |
| Init Admin (authorized **and** in `initAdminUserIds`) | Call `setMyCommands` with the locked list. On success, send `Initialized the command menu.` On throw, log and send `Failed to initialize the command menu.` |
| Authorized, not an Init Admin | Existing unknown-command reply: `Unknown command /init. Send /help for commands.` |
| Unauthorized | `Access denied.` (unchanged) |

`/help` stays one text for everyone and **omits** `/init`. Do not add an admin-only line. Init Admins type `/init`; they do not discover it from `/help` or the Command Menu.

`/init` does not start or rotate a session. Repeat calls overwrite the same slot.

Do not register the Command Menu in `start()` / `apply`.

## Command Menu

Order and copy are locked. `BotCommand.command` has no leading `/`.

| `command` | `description` |
| --- | --- |
| `start` | start a session |
| `new` | start a fresh session |
| `clear` | reset the current session |
| `help` | show this help |

Do not add `init`. Do not change order or descriptions. Prototype: [command-menu.html](prototype/command-menu.html).

`/help` body stays the existing four lines (no `/init` line).

## `setMyCommands` contract

Call `setMyCommands` with that full four-command list. Omit `scope` (default) and omit `language_code` (unlocalized fallback). That **replaces** the default, unlocalized slot only — it does not merge.

Success is Bot API `ok: true` / `result: true`. The client seam throws on transport failure or non-ok, same as existing `call()`.

`deleteMyCommands` is not part of `/init`. Do not clear the menu.

**Leftovers:** language-specific default lists (`default + "en"`, etc.) and any narrower scope still win in Telegram's client resolution over the slot `/init` writes. `/init` does not detect or delete them. Do not copy the full resolution table here; see [Research: Telegram setMyCommands contract](issues/01-telegram-setmycommands-contract.md) and [setmycommands-contract.md](research/setmycommands-contract.md). Do not mention leftovers in the README.

A later BotFather `/setcommands` overwrites the same unlocalized default slot `/init` wrote.

## Config

| Key | Schema | Default |
| --- | --- | --- |
| `initAdminUserIds` | number array | `[]` |

Omitting the key is an empty list: nobody can `/init`; other Slash Commands are unchanged.

**Gate:** existing authorization, then membership in `initAdminUserIds`. When `allowAllUsers` is true, an Init Admin need not also appear in `allowedUserIds`.

**Load:** do not fail or warn if an id is missing from `allowedUserIds`. Runtime only.

**Operator docs:** add one README config-table row for `initAdminUserIds` stating that an empty list means nobody can `/init`. No environment-variable contract.

## Client seam

Add to `TelegramClientLike` (and the real `TelegramClient`):

- `setMyCommands(commands: { command: string; description: string }[]): Promise<boolean>`
- `getMyCommands(): Promise<{ command: string; description: string }[]>`

Neither takes `scope` or `language_code`. Both mean the default, unlocalized slot. `setMyCommands` resolves `true` on success. `getMyCommands` returns that slot (empty if unset). `deleteMyCommands` stays off the seam.

`/init` calls `setMyCommands` only. Do not read back on the success path.

## Tests

No live Telegram.

1. **`TelegramClient` HTTP** (fetch mock): `setMyCommands` and `getMyCommands` post to the matching methods; request body omits `scope` and `language_code`; `setMyCommands` sends the four commands; token redaction unchanged.
2. **Bridge:** after a successful Init Admin `/init`, `getMyCommands()` on the fake returns the four locked commands, and the chat received `Initialized the command menu.` Cover: empty `initAdminUserIds` → unknown-command; authorized non-admin → unknown-command; `setMyCommands` throw → `Failed to initialize the command menu.` plus a log, no API `description` in the chat; `/help` still omits `/init`; plugin start does not call `setMyCommands`.

## Out of scope

Startup registration; Reply Keyboard / Chat Menu Button / Web App; per-chat or per-user scopes; group/topic/non-text work; Chinese product copy; first-wins `/init`; clearing leftover lists.

## Decisions

- [Research: Telegram setMyCommands contract](issues/01-telegram-setmycommands-contract.md)
- [Grilling: Init Admin config shape](issues/02-init-admin-config-shape.md)
- [Grilling: Non-admin `/init` and `/help` visibility](issues/03-non-admin-init-and-help.md)
- [Grilling: Command Menu descriptions and `/init` replies](issues/04-command-menu-copy.md)
- [Prototype: Command Menu as the user sees it](issues/05-command-menu-prototype.md)
- [Grilling: Leftover language and narrower-scope lists](issues/06-leftover-language-and-scope-lists.md)
- [Grilling: Client seam and getMyCommands assertion](issues/07-client-seam-and-getmycommands.md)
