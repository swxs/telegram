# Map: `/init` Command Menu spec

## Destination

Reached: [spec.md](spec.md) — an Init Admin sends `/init`, and the bot registers or overwrites its default Command Menu as `/start`, `/new`, `/clear`, `/help` (English, aligned with `/help`; `/init` is not in the menu). The plugin does not register the menu on startup.

## Notes

- Domain: Telegram bridge. Read `CONTEXT.md` before every session; keep grilling and domain-modeling in play; use research for Bot API facts.
- Planning is done. The handoff artifact is [spec.md](spec.md). Do not implement `/init` unless a later session is asked to.
- Tracker: local markdown under `.scratch/init-command-menu/`. Refer to the map and tickets by title, not by number alone.
- Locked in charting (detail lives in this session, not in tickets): Command Menu via `setMyCommands`; `/init` overwrites the bot-default menu then confirms; init-only (no startup registration); copy is English and aligned with `/help`. Menu entries were refined to four commands (no `/init`) in [Grilling: Command Menu descriptions and `/init` replies](issues/04-command-menu-copy.md). Init Admin config was refined in [Grilling: Init Admin config shape](issues/02-init-admin-config-shape.md).

## Decisions so far

- [Grilling: Init Admin config shape](issues/02-init-admin-config-shape.md) — `initAdminUserIds` defaults to `[]`; authorize first, then check the list; README row only, no env contract.

- [Research: Telegram setMyCommands contract](issues/01-telegram-setmycommands-contract.md) — Default-scope `setMyCommands` replaces that slot (no merge); omit `language_code` for the unlocalized fallback; `deleteMyCommands` is only for clear.
- [Grilling: Non-admin `/init` and `/help` visibility](issues/03-non-admin-init-and-help.md) — Non-admin `/init` reuses unknown-command; `/help` omits `/init` for everyone.
- [Grilling: Command Menu descriptions and `/init` replies](issues/04-command-menu-copy.md) — Menu is start/new/clear/help with `/help` descriptions; `/init` is not in the menu; success/fail: Initialized / Failed to initialize the command menu.
- [Prototype: Command Menu as the user sees it](issues/05-command-menu-prototype.md) — Four-item menu feels right; `/init` stays off the menu. Prototype: [command-menu.html](prototype/command-menu.html).
- [Grilling: Leftover language and narrower-scope lists](issues/06-leftover-language-and-scope-lists.md) — Spec warns beside the `setMyCommands` contract; `/init` does not clear leftovers; not in README.
- [Grilling: Client seam and getMyCommands assertion](issues/07-client-seam-and-getmycommands.md) — Seam gets narrow `setMyCommands` + `getMyCommands`; `/init` only sets; tests read back the four commands on the fake.

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

- Implementing `/init` or shipping the Command Menu — this map ends at the spec.
- Registering the Command Menu on plugin startup.
- Reply Keyboard, Chat Menu Button, and Web App menus.
- Per-chat or per-user Command Menu scopes.
- Group chats, topics, and non-text messages (existing bridge limits).
- Chinese product copy.
- First-wins / non-overwriting `/init`.
