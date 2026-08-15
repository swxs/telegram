# Grilling: Client seam and getMyCommands assertion

Type: grilling
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

What must the spec require of the Telegram client seam and of tests that prove `/init` registered the default Command Menu?

Facts (from [Research: Telegram setMyCommands contract](01-telegram-setmycommands-contract.md)): `/init` calls `setMyCommands` with the full five-command list, default scope (or omitted), and no `language_code`; success is `ok: true`; the matching read-back is `getMyCommands` on that same slot. `getMyCommands` reads the slot, not the user-resolved menu.

Still open: which methods belong on the client seam, whether tests must round-trip via `getMyCommands`, and how a failed `setMyCommands` is exposed to the bridge.

## Answer

- **Seam:** add `setMyCommands` and `getMyCommands` to `TelegramClientLike`. Neither takes `scope` or `language_code` — both mean the default, unlocalized slot only. `setMyCommands` takes the four `{ command, description }` items (`command` has no `/`) and resolves `true` on success. `getMyCommands` returns that slot's list. `deleteMyCommands` stays off the seam.
- **`/init` path:** call `setMyCommands` only. Do not read back on the success path.
- **Failure:** `setMyCommands` throws like the existing `call()` (transport or non-ok). The bridge catches, logs, and sends `Failed to initialize the command menu.` Do not forward the API `description`.
- **Tests (fake seam, no live Telegram):**
  1. Real `TelegramClient` HTTP tests via fetch mock for both methods (omit `scope` and `language_code` in the body).
  2. Bridge tests: after a successful `/init`, `getMyCommands()` on the fake returns the four locked commands.
