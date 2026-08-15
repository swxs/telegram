# Research: Telegram setMyCommands contract

Type: research
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

What does the Telegram Bot API guarantee for `setMyCommands` (and related `getMyCommands` / `deleteMyCommands`) so the `/init` spec can be precise?

Locked for this effort: register the **default** Command Menu only (not chat or chat_member scope); each `/init` overwrites; the list is `/start`, `/new`, `/clear`, `/help`, `/init`.

The spec needs primary-source facts on:

- Default-scope overwrite vs merge
- Command name and description limits
- `language_code` behavior when we set commands without a language
- Interaction with commands set in BotFather
- Whether `deleteMyCommands` must be specified (clearing the menu is otherwise out of scope)
- Any private-chat vs group difference that would surprise an implementer

## Answer

`setMyCommands` **replaces** the entire command list for one `(scope, language_code)` slot (default scope + empty language if omitted) — it does not merge that slot, and it does not touch other scopes or per-language lists. Names are 1–32 lowercase `[a-z0-9_]`, no leading `/`; descriptions 1–256; at most 100 commands. `deleteMyCommands` is the documented clear, not required to overwrite. BotFather `/setcommands` is the same unlocalized default list `setMyCommands` was added to change. Default scope applies in all dialogs unless a narrower list exists; `getMyCommands` reads the exact slot (empty if unset), not the user-resolved menu.

Findings: [setmycommands-contract.md](../research/setmycommands-contract.md)

Now ticketable (do not open here): client seam + tests for `setMyCommands` / `getMyCommands` on that default empty-language slot; whether the spec should warn that leftover language-specific or narrower-scope lists still win (API fact, product whether to mention). The spec is not forced to mention `deleteMyCommands` or BotFather for the `/init` happy path; BotFather is the same default slot, so `/init` overwrites it and a later `/setcommands` would overwrite `/init`.
