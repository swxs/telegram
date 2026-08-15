# Grilling: Leftover language and narrower-scope lists

Type: grilling
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

Should the spec warn that leftover language-specific default lists or narrower scopes still win over the default Command Menu `/init` writes?

Facts (from [Research: Telegram setMyCommands contract](01-telegram-setmycommands-contract.md)): a default-scope, no-`language_code` `setMyCommands` replaces only that slot. A previously set `default + "en"` (or any narrower scope) still wins in Telegram's client resolution. Clearing those slots is out of scope. This ticket is only whether implementers must be told.

## Answer

The spec must include a short implementer note beside the `setMyCommands` contract: leftover language-specific default lists and narrower scopes still win over the slot `/init` writes; `/init` does not detect or delete them. Do not copy the full client resolution table (it lives in the research note). Do not mention this in the README.
