# telegram

把已授权的 Telegram 私聊接到 harness agent 会话。

## 安装

```sh
dsh plugin --profile web add <dir|git-url>
dsh --profile web --dump-config | grep telegram
```

需要 bot token：写在配置 `token`，或环境变量 `DSH_TELEGRAM_TOKEN`。缺少 token 时插件加载失败。

安装后重启目标 profile 的 DSH 进程（组合层变更不参与 HMR）。

## 卸载

```sh
dsh plugin --profile web remove @swxs/telegram
```

卸载后同样需要重启 DSH 进程。

## 配置

| 键                 | 默认                | 含义                                                                                                                                   |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `token`            | `''`                | @BotFather 创建的 bot token；为空时回退到 `DSH_TELEGRAM_TOKEN`                                                                         |
| `allowedUserIds`   | `[]`                | 允许与 bot 对话的 Telegram 用户 id；空列表拒绝所有人                                                                                   |
| `allowAllUsers`    | `false`             | 允许任意用户（仅开发用）                                                                                                               |
| `initAdminUserIds` | `[]`                | 允许发送 `/init` 初始化菜单的管理用户 id                                                                                               |
| `proxy`            | `''`                | Bot API 的 HTTP/HTTPS 代理（例如 `http://localhost:15236`）。为空时回退 `HTTPS_PROXY` / `HTTP_PROXY`。只代理 Telegram 请求，不影响 LLM |
| `provider`         | `deepseek-official` | 传给每个创建 agent 的 LLM provider id                                                                                                  |
| `model`            | `deepseek-v4-flash` | 传给每个创建 agent 的模型 id                                                                                                           |
| `preset`           | 组合默认预设        | 每个新建 agent 加入的 agent 预设 id                                                                                                    |

未配置白名单时 bot 拒绝所有用户

## 菜单与指令

输入框旁的 **Command Menu** 列出本 bot 的 Slash Command 快捷入口。菜单不会在安装时自动出现，需要 **Init Admin** 在聊天里发送 `/init`，把默认菜单登记（或覆盖）到 bot。`/init` 本身不进 Command Menu，也不出现在 `/help`。

用户可见的 Slash Command：

| 命令      | 作用                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `/start`  | 列出 Workspace，用 Inline Keyboard 选择后为该聊天建立会话                                               |
| `/clear`  | 在当前已绑定的 Workspace 下新开会话                                                                     |
| `/skills` | 列出当前 Workspace 已加载的 Skill；点选复制 `//name `，粘贴后可改再发, 也可以手动使用 `//name` 指定技能 |
| `/help`   | 显示上述命令                                                                                            |

以 `/` 开头、由本插件处理的消息不会转发给 agent。其它未知 `/` 命令同样不会到达模型。

`/start` 选定 Workspace 后，该聊天的会话都在这个 Workspace 下; `/clear` 只重置当前绑定下的会话，不换 Workspace。

`/skills` 显示目前 Workspace 所有已安装的 Skill 名。用户发送以 `//` 开头的消息时，插件把前导 `//` 改成 `/` 再作为 Skill 调用转发给 agent。

## 模型提问

模型需要确认、选择或补信息时，会在该聊天里调用 `tele_ask_user`，而不是 `ask_user_question`。

- 有选项：Inline Keyboard。单选点一项即提交；多选可点多项，再提交。
- 需要自己写答案：ForceReply，直接回复那条提问。

同一聊天同时只展示一条未完成的提问。有提问未完成时，普通文本不会转发给 agent，先答完（或按提示回复）再继续。

## 工具授权

agent 要执行需授权的工具时，聊天里会出现 Inline Keyboard：**Allow once** / **Reject** / **Cancel**。

与模型提问一样，每个聊天同时只展示一条未完成的交互；有授权未完成时，普通文本不会转发给 agent。
