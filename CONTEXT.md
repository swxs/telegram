# Telegram Bridge

The Telegram bridge relays authorized chats to harness agent sessions. This glossary names the chat-facing concepts the bridge owns.

## Language

**Slash Command**:
A user message that starts with `/` and is handled by the bridge; it is not forwarded to the agent. User-facing commands are `/start`, `/new`, `/clear`, and `/help`. `/init` is an Init Admin command; it is not listed in `/help` or the Command Menu.
_Avoid_: bot action, shortcut, menu item

**Command Menu**:
The Telegram chat UI next to the message input that lists this bot's slash-command shortcuts.
_Avoid_: 左下角菜单, Reply Keyboard, Menu Button, 自定义键盘, Chat Menu Button

**/init**:
The Slash Command that registers or overwrites the bot's default Command Menu, then confirms to the caller. Only an Init Admin may invoke it.
_Avoid_: setup, bootstrap, register-commands

**Init Admin**:
An authorized Telegram user who is also on the Init Admin list. Authorization is the existing allowlist or allow-all; the Init Admin list is a second gate. An empty list means nobody can `/init`.
_Avoid_: operator, owner, superuser, admin (unqualified)
