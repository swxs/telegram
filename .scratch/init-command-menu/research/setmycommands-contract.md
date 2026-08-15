# Telegram `setMyCommands` contract

Primary-source notes for the `/init` Command Menu spec. Locked for this effort: register the **default** Command Menu only (not chat or chat_member scope); each `/init` overwrites; the list is `/start`, `/new`, `/clear`, `/help`, `/init`.

This note records what first-party Telegram pages guarantee. It does not recommend product decisions beyond what the API forces.

## Sources

- [setMyCommands](https://core.telegram.org/bots/api#setmycommands)
- [getMyCommands](https://core.telegram.org/bots/api#getmycommands)
- [deleteMyCommands](https://core.telegram.org/bots/api#deletemycommands)
- [BotCommand](https://core.telegram.org/bots/api#botcommand)
- [BotCommandScope](https://core.telegram.org/bots/api#botcommandscope)
- [BotCommandScopeDefault](https://core.telegram.org/bots/api#botcommandscopedefault)
- [Making requests](https://core.telegram.org/bots/api#making-requests)
- [User](https://core.telegram.org/bots/api#user)
- [Bot API changelog](https://core.telegram.org/bots/api-changelog) (Bot API 4.7, 30 March 2020; Bot API 5.3, 25 June 2021)
- [Commands / Command Scopes / Menu Button / Global Commands / Language Support / Privacy Mode / BotFather](https://core.telegram.org/bots/features#commands)
- [bots.setBotCommands](https://core.telegram.org/method/bots.setBotCommands)
- [bots.getBotCommands](https://core.telegram.org/method/bots.getBotCommands)
- [bots.resetBotCommands](https://core.telegram.org/method/bots.resetBotCommands)
- [BotCommandScope (MTProto)](https://core.telegram.org/type/BotCommandScope)
- [botCommandScopeDefault](https://core.telegram.org/constructor/botCommandScopeDefault)
- [botCommand](https://core.telegram.org/constructor/botCommand)
- [TDLib setCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1set_commands.html)
- [TDLib getCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_commands.html)
- [TDLib deleteCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1delete_commands.html)
- [Telegram blog: Animated Backgrounds (25 June 2021)](https://telegram.org/blog/animated-backgrounds)

## Default-scope overwrite vs merge

`setMyCommands` “change[s] the list of the bot's commands.” The `commands` parameter is “a JSON-serialized list of bot commands **to be set as the list** of the bot's commands.” Success returns `True`. ([setMyCommands](https://core.telegram.org/bots/api#setmycommands))

The same method is scoped: `scope` is optional and “Defaults to BotCommandScopeDefault.” `language_code` is optional. ([setMyCommands](https://core.telegram.org/bots/api#setmycommands))

First-party wording for the same operation is “set,” not merge:

- MTProto `bots.setBotCommands`: “Set bot command list”; parameters are `scope`, `lang_code`, and `commands: Vector<BotCommand>`. ([bots.setBotCommands](https://core.telegram.org/method/bots.setBotCommands))
- TDLib `setCommands`: “**Sets the list** of commands supported by the bot **for the given user scope and language**.” Passing a null scope “change[s] commands in the default bot command scope.” ([setCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1set_commands.html))

`getMyCommands` returns “the **current list** of the bot's commands **for the given scope and user language**.” “If commands aren't set, an empty list is returned.” ([getMyCommands](https://core.telegram.org/bots/api#getmycommands)) TDLib matches: “Returns the list of commands supported by the bot **for the given user scope and language**.” ([getCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_commands.html))

What the API forces:

- A `setMyCommands` call **replaces the entire list stored for that `(scope, language_code)` slot**. It does not merge with the previous commands in that same slot.
- It does **not** document any merge into, or wipe of, other scopes or other `language_code` slots. Those lists stay independently set until changed or deleted.
- `getMyCommands` is an exact-slot read, not the client-resolved menu a particular user would see. An empty result means that slot is unset, not that the user sees no commands (a higher-priority slot may still be set).

`BotCommandScopeDefault` “Represents the default scope of bot commands. Default commands are used if no commands with a narrower scope are specified for the user.” `type` must be `default`. ([BotCommandScopeDefault](https://core.telegram.org/bots/api#botcommandscopedefault)) MTProto: default-scope commands “will be valid in all dialogs.” ([botCommandScopeDefault](https://core.telegram.org/constructor/botCommandScopeDefault))

## Command name and description limits

`BotCommand` fields ([BotCommand](https://core.telegram.org/bots/api#botcommand)):

| Field | Limit / rule |
| --- | --- |
| `command` | 1–32 characters. “Can contain only lowercase English letters, digits and underscores.” |
| `description` | 1–256 characters |
| `is_ephemeral` | Optional. `True` if the command sends an ephemeral message visible only to the sender and the bot. Not required for a normal Command Menu. |

`setMyCommands` accepts “At most 100 commands.” ([setMyCommands](https://core.telegram.org/bots/api#setmycommands))

The Bot API `command` field is the keyword **without** a leading `/`. A `/` is not a lowercase English letter, digit, or underscore, so `/start` is not a valid `command` value; `start` is.

User-facing command text on the features page: “Commands must always start with the `/` symbol and contain up to 32 characters. They can use Latin letters, numbers and underscores, though simple lowercase text is recommended.” Clients highlight `/keyword` in messages, suggest the list after the user types `/`, and can show a menu button. ([Commands](https://core.telegram.org/bots/features#commands))

The five locked names (`start`, `new`, `clear`, `help`, `init`) fit the 1–32 lowercase-letter rule. Each description must be 1–256 characters (copy is a separate spec item).

MTProto rejects invalid values with `400 BOT_COMMAND_INVALID`, `400 BOT_COMMAND_DESCRIPTION_INVALID`, or `400 LANG_CODE_INVALID`. ([bots.setBotCommands](https://core.telegram.org/method/bots.setBotCommands)) Bot API failures return `ok: false` plus a `description` (and an `error_code` whose contents “are subject to change”). ([Making requests](https://core.telegram.org/bots/api#making-requests))

The features page also asks bots to support Global Commands `/start`, `/help`, and (if applicable) `/settings`. `/start` and `/help` are in the locked list; `/settings` is not. Profile “Help” and “Settings” links appear “if you add them in @BotFather.” ([Global Commands](https://core.telegram.org/bots/features#commands))

## `language_code` when commands are set without a language

`setMyCommands.language_code`: “A two-letter ISO 639-1 language code. **If empty, commands will be applied to all users from the given scope, for whose language there are no dedicated commands.**” The parameter is Optional. ([setMyCommands](https://core.telegram.org/bots/api#setmycommands))

TDLib uses the same empty-string rule. ([setCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1set_commands.html))

`getMyCommands.language_code`: “A two-letter ISO 639-1 language code **or an empty string**.” ([getMyCommands](https://core.telegram.org/bots/api#getmycommands))

Omitting the optional parameter is the empty case: the method text defines behavior “If empty,” and the parameter is Optional. That writes the **unlocalized fallback** list for the given scope.

It does **not** write or replace per-language lists. Client resolution uses “the first list of commands which is set.” For a private chat with the bot, default-scope lookup is:

1. `botCommandScopeDefault + language_code`
2. `botCommandScopeDefault`

Narrower scopes are checked first (see private vs group below). ([Determining list of commands](https://core.telegram.org/bots/api#botcommandscope))

So a later `setMyCommands` with default scope and no `language_code` overwrites only the unlocalized default slot. A previously set `default + "en"` (or any other ISO 639-1 code) still wins for users who have that dedicated list.

`User.language_code` is an **IETF language tag** and is Optional (“may be not returned when irrelevant”). ([User](https://core.telegram.org/bots/api#user)) Features: the field “could be empty”; for the general public, fall back to the last recorded tag or English, in that order. “Command lists can also be specified for individual languages.” ([Language Support](https://core.telegram.org/bots/features#commands)) The Bot API command methods themselves take a two-letter ISO 639-1 code, not a full IETF tag.

## Interaction with BotFather

Bot API 4.7 (30 March 2020) added `setMyCommands` “for changing the list of the bot's commands **through the Bot API instead of @BotFather**,” and `getMyCommands` “for getting the current list.” There were no scopes or `language_code` parameters yet. ([Bot API changelog](https://core.telegram.org/bots/api-changelog))

Features still treat BotFather and the API as two ways to provide the same kind of list: suggestions after `/` work once “you need to have provided a list of commands to @BotFather **or via the appropriate API method**.” BotFather `/setcommands` “change[s] the list of commands supported by your bot.” ([Commands](https://core.telegram.org/bots/features#commands), [BotFather commands](https://core.telegram.org/bots/features#commands))

Bot API 5.3 (25 June 2021) added `scope` and `language_code` to `setMyCommands` / `getMyCommands`, added `deleteMyCommands`, and introduced the Menu button. ([Bot API changelog](https://core.telegram.org/bots/api-changelog)) The first-party blog: “a special menu button that lets you browse and send commands”; “commands that change based on a user’s interface language and chat type, as well as special commands that only appear in specific chats or for admins.” ([Animated Backgrounds](https://telegram.org/blog/animated-backgrounds))

What official pages do **not** say after 5.3: they never name `BotCommandScopeDefault` as the exact slot BotFather `/setcommands` writes. What they do say is that `setMyCommands` was introduced as the API replacement for that BotFather list, and that omitting `scope` / `language_code` still targets default scope and the unlocalized fallback.

What the API forces for this effort:

- Calling `setMyCommands` with default scope and empty `language_code` overwrites the unlocalized default list — the same kind of list BotFather `/setcommands` was documented to change.
- A later BotFather `/setcommands` “change[s] the list” again; official pages do not describe a merge with the API-set list.
- BotFather `/setcommands` is not documented as clearing language-specific or narrower-scope lists. Those slots are API (`setMyCommands` / `deleteMyCommands`) concerns.

Features’ Menu Button sentence says the menu holds “all or some of a bot’s commands (which you set via @BotFather).” The same page’s Commands section also allows the API method. The Menu Button itself is the client UI for the command lists; this map’s out-of-scope items already exclude changing the Menu Button into a Web App. ([Menu Button](https://core.telegram.org/bots/features#commands))

## Whether `deleteMyCommands` must be specified

`deleteMyCommands` “delete[s] the list of the bot's commands **for the given scope and user language**. After deletion, higher level commands will be shown to affected users.” `scope` defaults to `BotCommandScopeDefault`. Empty `language_code` uses the same fallback wording as `setMyCommands`. ([deleteMyCommands](https://core.telegram.org/bots/api#deletemycommands))

MTProto: `bots.resetBotCommands` — “Clear bot commands for the specified bot scope and language code.” ([bots.resetBotCommands](https://core.telegram.org/method/bots.resetBotCommands)) TDLib: `deleteCommands` — “Deletes commands supported by the bot for the given user scope and language”; null scope deletes the default-scope list. ([deleteCommands](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1delete_commands.html))

What the API forces:

- **Not required** to register or overwrite a list. Overwrite of a slot is `setMyCommands` with the new full list.
- **The documented way to clear a slot** so that a higher-priority list (or nothing) is shown. Official pages do not document passing an empty `commands` array to `setMyCommands` as a clear.
- Clearing the menu is otherwise out of scope for this map. The `/init` happy path is not forced to mention or call `deleteMyCommands`.
- Deleting only `default` + empty language does not remove language-specific default lists or any narrower scope. Those remain until deleted or replaced in their own slots. After the default unlocalized slot is gone, users fall through the resolution algorithm to the next set list, or to no list if none is set (`getMyCommands` then returns empty for that slot).

## Private-chat vs group differences

Default-scope commands apply in **all dialogs** unless a narrower scope is set. ([botCommandScopeDefault](https://core.telegram.org/constructor/botCommandScopeDefault), [BotCommandScopeDefault](https://core.telegram.org/bots/api#botcommandscopedefault))

Resolution — “the first list of commands which is set is returned” ([Determining list of commands](https://core.telegram.org/bots/api#botcommandscope)):

**Private chat with the bot**

1. `botCommandScopeChat` + `language_code`
2. `botCommandScopeChat`
3. `botCommandScopeAllPrivateChats` + `language_code`
4. `botCommandScopeAllPrivateChats`
5. `botCommandScopeDefault` + `language_code`
6. `botCommandScopeDefault`

**Group and supergroup**

1. `botCommandScopeChatMember` + `language_code`
2. `botCommandScopeChatMember`
3. `botCommandScopeChatAdministrators` + `language_code` (administrators only)
4. `botCommandScopeChatAdministrators` (administrators only)
5. `botCommandScopeChat` + `language_code`
6. `botCommandScopeChat`
7. `botCommandScopeAllChatAdministrators` + `language_code` (administrators only)
8. `botCommandScopeAllChatAdministrators` (administrators only)
9. `botCommandScopeAllGroupChats` + `language_code`
10. `botCommandScopeAllGroupChats`
11. `botCommandScopeDefault` + `language_code`
12. `botCommandScopeDefault`

Implementer surprises that follow from the docs (this map still excludes group-chat product work):

- A default-only `/init` is what private-chat and group users see **only if** no narrower list is set for them. An existing `all_private_chats`, `all_group_chats`, per-chat, or per-member list hides the default list. `/init` as locked does not touch those slots.
- “Bot API updates will not contain any information about the scope of a command sent by the user — in fact, they may contain commands that don’t exist at all in your bot. Your backend should always verify that received commands are valid and that the user was authorized to use them regardless of scope.” ([Command Scopes](https://core.telegram.org/bots/features#commands)) Registering the menu does not authorize the handler.
- Privacy Mode (default in groups): the bot only receives commands explicitly addressed to it (`/command@this_bot`), plus “general commands (e.g. `/start`) if the bot was the last bot to send a message to the group,” and other listed exceptions. All private-chat messages are received regardless. ([Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)) A group can show the menu and still not deliver `/new` to the bot.
- The Menu Button “appears near the message field” “in all bot chats” and, by default, opens the command list. ([Menu Button](https://core.telegram.org/bots/features#commands))

## What official pages do not specify

- A minimum command count for `setMyCommands` (only “at most 100”).
- That an empty `commands` array clears the slot (clearing is `deleteMyCommands` / `bots.resetBotCommands`).
- How quickly clients refresh the menu after a successful `setMyCommands`.
- That BotFather `/setcommands` after 5.3 writes a named `BotCommandScope` (see BotFather section).
- Any private-chat-only restriction on default-scope commands.

## Facts the `/init` spec is forced to respect

For the locked default-only overwrite:

1. Call `setMyCommands` with the full five-command list. Omit `scope` or pass `BotCommandScopeDefault`. Omit `language_code` or pass empty. That replaces the unlocalized default-scope list only.
2. Each `BotCommand.command` is `start` / `new` / `clear` / `help` / `init` (no `/`). Each `description` is 1–256 characters.
3. Success is Bot API `ok: true` / `result: true`. The matching read-back is `getMyCommands` with the same default scope and empty `language_code`.
4. `deleteMyCommands` is not required for that overwrite. It is the documented clear, which this map leaves out of scope.
5. Leftover `language_code`-specific default lists and any narrower scopes still win in the client algorithm. The API does not make default-scope `/init` the menu every user sees.
6. Showing a command in the menu is not authorization and does not change Privacy Mode delivery in groups.
