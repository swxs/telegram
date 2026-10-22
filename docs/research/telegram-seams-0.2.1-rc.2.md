# 0.2.1-rc.2 上 telegram 的加载接缝

对照 `d:\codehouse\deepseek-harness` 的 tag `dsh-v0.2.1-rc.2`（`687f282e8625c6b8d11ff58211a90524be2e4317`，该检出的 `HEAD` 与 tag 相同）和本仓库插件源码。用语按 `CONTEXT.md`：Slash Command、Workspace、Skill。模型提问是 `tele_ask_user`。工具授权是 `approval/request` 投到 Telegram 的 Allow once / Reject / Cancel。私聊会话是每个已授权私聊上的 agent 会话。

分类只有两类：必须改，插件才能加载；或者不改就会丢掉上面一项现有能力。能力都要留着。

## 必须改才能加载

### peer 范围把插件挡在预检外

`package.json` 的 `peerDependencies` 写的是 `@deepseek-ai/dsh-agent` `^0.1.0-rc.6`、`@deepseek-ai/dsh-llm` `^0.0.1-rc.1`、`@deepseek-ai/dsh-session` `^0.0.1-rc.1`。清单里没有 `engines.dsh`。tag 上这三个包的 `version` 都是 `0.2.1-rc.2`（`packages/core/agent/package.json`、`packages/llm/llm/package.json`、`packages/core/session/package.json`）。运行时版本来自 `packages/boot/app-boot/package.json` 的 `0.2.1-rc.2`，`getDshRuntimeVersion()` 读的就是这份清单（`packages/boot/app-boot/src/plugin-compatibility.ts`）。

`evaluatePluginCompatibility` 在没有 `engines.dsh` 时，要求每个 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` peer 都满足 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（同文件 `satisfies`、`unmetRequirements`）。检出里 app-boot 依赖的 semver 7.8.5 把这两段范围展开成 `>=0.1.0-rc.6 <0.2.0-0` 和 `>=0.0.1-rc.1 <0.0.2-0`。`0.2.1-rc.2` 落在两段外面，三条 peer 都未满足。

未满足且没有逐版本豁免时：

- 组合行在 `prepareProfileEntries` 里被标 `disabled`（`packages/boot/app-boot/src/compatibility-preflight.ts` 的 `deny`）。
- 作为 bundle 装进 profile 时，`loadProfileDirectory` 把这份清单判失败后放进 `skippedBundles`，`cordis.patch.yml` 不会进组合（`packages/boot/app-boot/src/profile.ts`）。

所以插件的 `apply` 不会跑。这是加载期，必须改 peer 范围（或改成一份能通过同一道门的 `engines.dsh`）插件才会挂上。私聊会话、Slash Command、Workspace、Skill、模型提问、工具授权都要留在挂上之后的插件里。

`@deepseek-ai/cordis` `^4.0.1` 对上 `vendor/cordis` 的 `4.0.5`（范围 `>=4.0.1 <5.0.0-0`）。`@deepseek-ai/schemastery` `^3.18.1` 对上 `vendor/schemastery` 的 `3.18.5`（范围 `>=3.18.1 <4.0.0-0`）。这两个名字不是 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，预检循环会跳过它们。它们不是断点。

### `scripts/build.sh` 和示例组合里的 agent spine 已经不在树上

`scripts/build.sh` 的 `link_pkg` 在目标目录不存在时直接退出，排在 `tsc` 之前。其中一行是：

`link_pkg @deepseek-ai/dsh-agent-spine-demo packages/examples/agent-spine-demo`

tag 上没有 `packages/examples`。全树 `package.json` 里也没有 `@deepseek-ai/dsh-agent-spine-demo`。官方编译脚本对不上这个检出。

同一名字出现在 `examples/telegram-agent/cordis.yml` 的 `agent-spine` 行。`Loader` 导入失败只记日志并返回，不拖垮其它行（`vendor/loader/src/config/entry.ts` 的 `_init`）。这一行自己起不来，示例组合里就没有人注册 `AgentRegistry`（服务名 `agents`，`packages/core/agent/src/index.ts` 的 `super(ctx, 'agents')`），也没有 `AgentFactory`。插件 `inject` 含 `agents`（`src/index.ts`）。示例组合里这一行不改，插件 fiber 等不到依赖，私聊会话创建不了。tag 上具体的循环实现是 `@deepseek-ai/dsh-agent-loop`（`packages/core/agent-loop`），它自己的 `static inject` 还依赖已经存在的 `agents`。

### 示例组合里另外四行包名也不在 tag 上

`examples/telegram-agent/cordis.yml` 里这些 `name` 在 tag 的 `package.json` 中没有同名包。导入失败时 Loader 同样只跳过该行：

| 示例里的 name | tag 上同职责的现包 |
| --- | --- |
| `@cordisjs/plugin-logger-console` | `@deepseek-ai/cordis-plugin-logger-console`（`vendor/logger-console/package.json`） |
| `@deepseek-ai/dsh-subagent-spawn` | 没有这个名字。现有的是 `@deepseek-ai/dsh-subagent-spawn-in-process`（`packages/subagent/subagent-spawn-in-process/package.json`） |
| `@deepseek-ai/dsh-fs-policy` | 没有这个名字。文件系统策略包现名是 `@deepseek-ai/dsh-fs-observation-policy`（`packages/fs/fs-observation-policy/package.json`） |
| `@deepseek-ai/dsh-compact-basic` | 没有这个名字。现名是 `@deepseek-ai/dsh-compaction-basic`（`packages/compaction/compaction-basic/package.json`） |

这四行不在插件 `inject` 里，跳过它们不会让 `apply` 停住，也不直接拆掉六项能力。示例文件里这四行要自己加载，名字必须改。上表只说明 tag 上现在叫什么，没有核对配置字段是否还能原样套用。

## 不改就会丢掉工具授权

`TelegramBridge.findUnclaimedApprovalId` 读 `req.agent.session.events`（`src/bridge.ts`），再在数组里倒序找尚未 `approval/decided` 的 `approval/asked`。tag 上的 `Session`（`packages/core/session/src/index.ts`）没有 `events` 属性。日志在私有 `log` 里。对外还在的同步读法是 `eventAt(seq)` 和 `snapshotEvents()`，两处注释都标了 `@deprecated`，方法本身仍在类上。

对着这份 `Session` 类型编译，`src/bridge.ts` 这一行过不了 tsc。已经编进 `lib/` 的旧代码在加载期仍能 `apply` 并开始轮询；一旦 `approval/request` 进来，`events` 是 `undefined`，读 `.length` 会抛。`ApprovalService.decide` 把瀑布监听器的同步抛出收进拒绝分支，结果收成 `'unavailable'`（`packages/interaction/user-approval/src/index.ts`）。Telegram 上不会出现 Allow once / Reject / Cancel。工具授权因此丢掉。修的时候要继续从会话日志认出 `approval/asked` 的 `id`，授权能力留着。

`approval` 服务名、`approval/request` 的 `(req, next)` 瀑布、以及 `approval/asked` / `approval/decided` 的 `id`、`toolName`、`callId`、`outcome` 词汇，在 tag 上仍是这些符号（`packages/interaction/user-approval/src/index.ts` 的 `super(ctx, 'approval')`，`packages/interaction/user-approval/src/types.ts` 的 `SessionEventMap` 与 `Events['approval/request']`）。断的是会话日志的读取口，不是这套事件名。

## 仍对齐，这些能力还在原接缝上

下面这些在 tag 上和插件源码对得上。留着它们，对应能力就还在。

- **inject 服务名。** `src/index.ts` 的 `inject = ['agents', 'agentPresets', 'approval']`。`agents` 见上。`agentPresets` 是 `packages/preset/agent-preset-registry/src/index.ts` 的 `super(ctx, 'agentPresets')`，`resolve(id?)` 返回带 `id` 的 `AgentPreset`，`mount(ctx, id?)` 仍在。`approval` 见上。`apply` 里 `ctx.get('agentPresets')` 与 `ctx.get('approval')` 的缺席检查仍然打在这两个名字上。
- **`Agent` / `AgentHandle` / `followup`。** `AgentHandle` 仍是 `{ agent, dispose() }`（`packages/core/agent/src/index.ts`）。`AgentRegistry.create(options)` 仍接收 `sessionId`、`meta.cwd`、`meta.agentPreset`、`agentOptions.provider` / `model`、`setup`（同文件 `CreateAgentOptions` 与 `create`）。`followup(message: UserMessage)` 仍在 `packages/core/agent/src/runtime-types.ts` 对 `Agent` 的增补上。`src/bridge.ts` 的 `ctx.agents.create(...)` 和 `handle.agent.followup(...)` 还是这个形状。私聊会话的创建和用户消息入口还在。
- **`createUserMessage`。** `packages/llm/llm/src/index.ts` 有 `export * from './message.ts'`。`createUserMessage` 收 `NewUserMessage`（去掉 `id` 和 `role`）。`MessageSourceMap.user` 仍是 `{ kind: 'user' }`。`TextBlock` 仍是 `{ type: 'text', text: string }`（`packages/llm/llm/src/types.ts`）。插件三处 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })` 仍合法。Slash Command 里把 `//name` 改写成 `/name` 再 `followup` 的路径也还在这条消息接缝上。
- **`Session` / `SessionEvent` / `session/event`。** `session/event` 仍是 `(session, event)`（`packages/core/session/src/index.ts` 的 `Events`）。`SessionEventMap` 仍有 `turn/start` 和 `assistant/message`，后者的 `data.message` 是 `AssistantMessage`，`content` 里仍有 `type: 'text'` 的块。`src/bridge.ts` 的 `handleSessionEvent` 用这两类事件做输入状态和助手正文。未带 scope 标签的监听器仍接收发到子 scope 的事件（`packages/core/scope/src/index.ts` 的 `scopeTarget`：`scopeOf(ctx)` 为 `undefined` 时过滤器返回真）。插件挂在组合根上时，助手正文仍能送回私聊。
- **Workspace。** 服务名 `workspaceRegistry`（`packages/workspace/workspace/src/index.ts` 的 `super(ctx, 'workspaceRegistry')`）。`list(): Workspace[]` 与 `get(id)` 仍是同步的。`Workspace` 仍有 `id`、`path`、`title`，`attachSession(sessionId)` 仍在 `packages/workspace/workspace/src/entity.ts`。插件的 `WorkspaceRegistryLike` 用的就是这四样。`/start` 选 Workspace、绑定、把会话挂上账本的路径还在。
- **Skill。** 服务名 `skills`（`packages/skill/skill/src/index.ts` 的 `super(ctx, 'skills')`）。`list(options)` 仍接受 `cwd` 与 `scope`（`SkillViewOptions`）。`SkillSummary` 仍有 `name` 和 `invocation.userInvocable`。`ScopeKey` 是 `object`；agent 循环用 `createScope(loopCtx, this)` 把 Agent 实例本身当作 scope key（`packages/core/agent-loop/src/agent.ts`）。插件 `listSkillNames` 传的 `scope: agent` 仍是这个 key。`/skills` 和 `//name` 这条 Skill 能力还在。
- **模型提问。** `tele_ask_user` 走 `tools.register` 和 `systemPrompt.section`，不走 `userQuestions`。`ToolRuntime.register` 仍要求 `output.schema` 加 `output.render`（`packages/core/tools/src/index.ts`），`src/tele-ask-user.ts` 的定义带了这两项。`execute(args, exec)` 的 `exec.agent` 与 `exec.signal` 仍在 `ToolRunContext` 上。`SystemPrompt.section({ name, order, text })` 仍在 `packages/core/system-prompt/src/index.ts`。`tools.restrict` 对未知全局工具名会抛（同文件 `restrict`）；`composeAgent` 把这次 `restrict({ deny: ['ask_user_question'] })` 包在 try/catch 里，然后照常 `register`。模型提问不在断点里。
- **Cordis 插件导出形状。** `Plugin.Base` 仍是 `name`、`Config`、`inject`、`apply`（`vendor/cordis/src/registry.ts`）。`inject` 数组仍被 `Inject.resolve` 收成服务名映射。`Loader.unwrapExports` 在没有 `default` 时保留命名空间（`vendor/loader/src/index.ts`）。`src/index.ts` 导出 `name`、`inject`、`Config`、`apply`，没有 default。`tests/plugin-shape.spec.ts` 守的就是这个形状。
- **`cordis.patch.yml`。** 顶层仍是 patch 数组，`insert` 追加行（`packages/boot/app-boot/src/index.ts` 的 `loadOptionalPatches`；`packages/boot/app-boot/src/config-schema/document.ts` 对 `insert` 的说明）。插件文件是 `- insert:` 加 `id: telegram`、`name: '@swxs/telegram'`。`package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`，`loadProfileDirectory` 仍读 `bundle.patch`。这份补丁形状没有断。
- **`scripts/build.sh` 的其余链接。** 下列目标目录都在，且目录内 `package.json` 的 `name` 与 `link_pkg` 的包名一致：`vendor/cordis`、`vendor/cosmokit`、`vendor/schemastery`、`packages/core/agent`、`packages/util/brand`、`packages/llm/llm`、`packages/util/timeout`、`packages/core/scope`、`packages/core/session`、`vendor/loader`（`@deepseek-ai/cordis-plugin-loader`）。该检出的 `node_modules/@types`、`node_modules/@vitest`、`node_modules/vitest`、`node_modules/.bin/tsc` 也在。唯一缺的链接是上面的 `agent-spine-demo`。
