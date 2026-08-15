# Grilling: Command Menu descriptions and `/init` replies

Type: grilling
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

What is the exact English `description` for `/start`, `/new`, `/clear`, `/help`, and `/init` in the Command Menu, and the exact `/init` success and API-failure replies?

Locked: English, aligned with `/help`. Current `/help` lines are: start a session; start a fresh session; reset the current session; show this help.

API constraints from [Research: Telegram setMyCommands contract](01-telegram-setmycommands-contract.md): `BotCommand.command` is the keyword without `/` (`start`, not `/start`); each `description` is 1–256 characters; omit `language_code` so this is the unlocalized fallback list.

Non-admin `/init` copy is already locked in [Grilling: Non-admin `/init` and `/help` visibility](03-non-admin-init-and-help.md): reuse the existing unknown-command reply. This ticket covers menu descriptions plus Init Admin success and API-failure replies only.

## Answer

- **Command Menu entries:** `/start`, `/new`, `/clear`, `/help` only. `/init` is not in the menu and has no menu description. This supersedes the charting lock that listed five commands, and the “menu still lists `/init`” clause in [Grilling: Non-admin `/init` and `/help` visibility](03-non-admin-init-and-help.md).
- **Descriptions** (aligned with `/help`; `command` field has no `/`):
  - `start` — start a session
  - `new` — start a fresh session
  - `clear` — reset the current session
  - `help` — show this help
- **Init Admin success:** `Initialized the command menu.`
- **Init Admin API failure:** `Failed to initialize the command menu.` Do not append the Telegram API `description`. Still log the failure.
