# Prototype: Command Menu as the user sees it

Type: prototype
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

Given the locked command list and the copy from [Grilling: Command Menu descriptions and `/init` replies](04-command-menu-copy.md), does this Command Menu feel right as the Telegram Menu UI a user would tap?

Menu (no `/init`):

- start — start a session
- new — start a fresh session
- clear — reset the current session
- help — show this help

Link a cheap prototype (a plain list matching Telegram's Menu: command + description). Do not implement the bot.

Asset: [command-menu.html](../prototype/command-menu.html) — three Telegram chrome variants, same locked four commands, `?variant=A|B|C`.

## Answer

The locked four-item Command Menu feels right as the Telegram Menu a user would tap. Do not add `/init`. Do not change order or descriptions.

- `start` — start a session
- `new` — start a fresh session
- `clear` — reset the current session
- `help` — show this help

Variants A/B/C were chrome only (menu sheet, slash hints, dense row). The list won, not a particular shell. Prototype: [command-menu.html](../prototype/command-menu.html).
