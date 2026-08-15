# Grilling: Non-admin `/init` and `/help` visibility

Type: grilling
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

When an authorized user who is not an Init Admin sends `/init`, what do they see? And does `/help` list `/init` — if so, does it say the command is admin-only?

## Answer

- **Non-admin `/init`:** reuse the existing unknown-command reply (`Unknown command /init. Send /help for commands.`). Do not add an Init Admin denial, `Access denied.`, or silence.
- **`/help`:** one text for everyone; omit `/init`. Init Admins discover `/init` from the Command Menu or operator docs, not from `/help`.
- **Command Menu:** ~~still lists `/init` (charting lock unchanged). A non-admin who taps it gets the unknown-command reply.~~ **Superseded** by [Grilling: Command Menu descriptions and `/init` replies](04-command-menu-copy.md): `/init` is not in the menu. Non-admin `/init` is still the unknown-command reply if they type it.

[Grilling: Command Menu descriptions and `/init` replies](04-command-menu-copy.md) should not invent a separate non-admin `/init` message.
