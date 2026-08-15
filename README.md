# telegram

## 安装（DSH profile bundle）

```sh
# 从本仓库 checkout 安装到 profile（web / headless 等），bundle 声明自动加入组合层
dsh plugin --profile web add <dir|git-url>
# 验证
dsh --profile web --dump-config | grep telegram
```

- 插入行 id：`telegram`（cordis.patch.yml）；不声明模型面工具或技能——它是把 Telegram 聊天桥接到 agent 会话的后台服务插件。
- **加载即需要 token**：缺少 bot token（配置 `token` 或环境变量 `DSH_TELEGRAM_TOKEN`）时 `apply` 直接报错；没有 token 不会惰性启动。
- **宿主前置条件**：dsh 组合必须挂载 `agents` 与 `agentPresets`（`@deepseek-ai/dsh-agent` 及部署预设服务）；LLM 适配器、会话来自外围 `cordis.yml`（见 [`telegram-agent`](examples/telegram-agent/README.zh.md) 示例）。缺少 `agentPresets` 时插件加载失败。
- 卸载：`dsh plugin --profile web remove telegram`。
- 安装后需重启目标 profile 的 DSH 进程（组合层变更不参与 HMR 热更新）。

## 概述

`telegram` 插件通过 Bot API 长轮询把 Telegram 聊天桥接到 harness agent 会话，每个聊天一个 agent 会话。设计参照 [Hermes](https://github.com/NousResearch/hermes-agent) 的 telegram 平台适配器——每聊天会话、用户白名单、HTML 格式化、4096 字符分片、typing 指示——裁剪为 harness 的纯文本接缝。[`telegram-agent`](examples/telegram-agent/README.zh.md) 是可运行的 `cordis.yml` 应用。

## 接线

`inject: ['agents', 'agentPresets']`。`/start` 列出 `workspaceRegistry` 中的 Workspace，用户用 Inline Keyboard 选择后，才为该聊天创建 agent（`ctx.agents.create`，`meta.cwd` 为所选 Workspace 的 path）并 `attachSession`。之后每条已授权文本消息复用该聊天的 agent，经 `followup` 以用户消息转发文本，并把每条 `assistant/message` 文本作为分片的 HTML 格式 Telegram 消息送回聊天。创建 agent 时会 `agentPresets.mount()` 当前部署预设（web profile 默认为 `standard`），否则会话是零工具的。`workspaceRegistry` 可选：缺失或列表为空时 `/start` 提示没有可选 Workspace，不建会话。`attachSession` 失败会告知用户，会话仍可用。命令：`/start`（选择 Workspace 并开始会话）、`/clear`（在已绑定 Workspace 下新开会话，旧 agent 释放）、`/skills`（列出当前 Workspace 已加载的 Skill 名；点选复制 `//name `，粘贴后可改再发）、`/help`。绑定只活在内存里，进程重启后需再 `/start`。LLM 适配器、会话来自外围 `cordis.yml`。缺少 `agentPresets` 时加载即失败。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `token` | `''` | @BotFather 创建的 bot token；为空时回退到 `DSH_TELEGRAM_TOKEN` |
| `allowedUserIds` | `[]` | 允许与 bot 对话的 Telegram 用户 id；空列表拒绝所有人 |
| `allowAllUsers` | `false` | 允许任意用户（仅开发用） |
| `provider` | `deepseek-official` | 传给每个创建 agent 的 LLM provider id |
| `model` | `deepseek-v4-flash` | 传给每个创建 agent 的模型 id |
| `maxMessageLength` | `4096` | 每条 Telegram 消息的长度上限 |
| `pollingTimeoutSec` | `30` | 长轮询超时（秒） |
| `cwd` | （未使用） | 保留字段，避免旧 profile 加载失败；运行时忽略。会话工作目录来自用户在 `/start` 选中的 Workspace |
| `preset` | 组合默认预设 | 每个新建 agent 加入的 agent 预设 id；未设时走 `agentPresets.resolve()` 的默认 |
| `initAdminUserIds` | `[]` | 允许发送 `/init` 登记 Command Menu 的 Telegram 用户 id；空列表则谁都不能 `/init` |

缺少 token 时加载即报错（fail loud）。缺少 `agentPresets` 服务时同样加载失败——零工具 agent 看起来像在聊，实际不能干活。未配置白名单时 bot 拒绝所有用户（fail closed）。`workspaceRegistry` 缺失不会阻止插件加载，但用户无法选择 Workspace、也就不会建会话。`TelegramConfig` 还接受仅运行时使用的 `client` 与 `sleep` 接缝供测试使用；生产环境使用全局 `fetch` 与真实定时器。所有错误经 `ctx.logger` 记录且 bot token 被脱敏。

## 投递语义

- assistant 文本按保守的 Markdown 子集转换（围栏代码 → `<pre>`、行内代码 → `<code>`、`**粗体**` → `<b>`，其余 HTML 转义），并按 `maxMessageLength` 分片，优先在换行、中文句号、句点+空格处断行。
- Telegram 拒绝 HTML 正文（分片后实体不完整）时，该片回退为纯文本发送。
- `turn/start` 发送 `typing` 聊天动作；投递为 fire-and-forget，逐片记录日志。
- 单条长轮询循环服务所有聊天；空批次休眠 50ms 节奏下限，避免即时空传输让事件循环空转。

## 模型体验

### Telegram 用户消息

#### 模型看到什么

每条入站聊天消息，模型在该聊天会话中收到逐字的一条用户消息。本包不添加系统提示词或工具 schema；它们来自外围 `cordis.yml` 的插件。命令（`/start`、`/clear`、`/skills`、`/help`、`/init`）和 Workspace 选择回调查询不会到达模型。以 `//` 开头的 Skill 调用会改写成 `/` 后作为用户消息转发。其它未知 `/` 命令不会到达模型。

#### Token 影响

数据相关的用户消息 token 进入保留的会话历史，后续回合会重发，直到其它包压缩它们。轮询帧、聊天簿记与投递调用不增加模型上下文 token。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与待办

- **仅文本消息**——照片、文档、语音、贴纸与 caption 被忽略。
- **仅私聊**——群聊 @ 提及与话题（topics）未处理。
- **每条 assistant 输出一条消息**——工具中间进度不会作为独立可编辑 Telegram 消息流式发送。
- **仅长轮询**——无 webhook 模式，主机需可出站访问 Telegram API。
- **除纯文本回退外无重试**——投递失败记录日志后丢弃；Hermes 风格的发送重试与投递账本留待后续。
