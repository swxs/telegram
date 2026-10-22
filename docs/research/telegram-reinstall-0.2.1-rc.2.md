# 0.2.1-rc.2：把本地目录插件装回已升级的 web profile

只读来源是 `d:\codehouse\deepseek-harness` 的 tag `dsh-v0.2.1-rc.2`（`687f282e86`）里的 CLI 与 loader，加上本仓库里被安装的那份清单和 bundle patch。下面的路径，未加仓库前缀的都属于 harness 那一版。

web profile 目录是 `$DSH_HOME/profiles/web`。`$DSH_HOME` 优先，否则是 `~/.dsh`（`packages/util/home-paths/src/index.ts` 的 `resolveDshHome` / `DSH_HOME_DIR_NAME`；`packages/boot/app-boot/src/profile.ts` 的 `resolveProfileDir`）。已经升过级的 profile 自带 `package.json` 时，`dsh plugin` 不会重做初始化，也不会改写已有的 `cordis.patch.yml`（`packages/boot/plugin-manager/src/operations.ts` 的 `runPluginCommand` 只在缺少 `package.json` 时调用 `initProfile`；`initProfile` 对已存在的文件直接跳过）。

## 安装顺序

插件目录是本仓库检出（`package.json` 的 `name` 为 `@swxs/telegram`，`version` 为 `0.3.1`，并声明 `dsh.bundle.patch`）。在这一版 CLI 上按下面的顺序做。

1. 先放行这一对精确版本。当前清单没有 `engines.dsh`，于是预检拿每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 `peerDependencies` 去和**正在运行的 dsh 版本**比，而不是和那个 peer 包自己的版本比（`packages/boot/app-boot/src/plugin-compatibility.ts` 的 `unmetRequirements` / `evaluatePluginCompatibility`，比较是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`）。运行时版本来自 `@deepseek-ai/dsh-app-boot` 的 `package.json`，这一版是 `0.2.1-rc.2`。本仓库三个 peer 都落在这个比较里：

   - `@deepseek-ai/dsh-agent`: `^0.1.0-rc.6`
   - `@deepseek-ai/dsh-llm`: `^0.0.1-rc.1`
   - `@deepseek-ai/dsh-session`: `^0.0.1-rc.1`

   `^0.1.0` 的上界是 `<0.2.0`，`^0.0.1` 的上界是 `<0.0.2`。用 harness 自带的 semver 7.8.4 对 `0.2.1-rc.2` 做同款 `satisfies`，三条都是 false。`@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` 不是 `dsh` 前缀，不参加这次比较。

   `add` 会在调用 pnpm 之前读本地 `package.json` 做这次预检；不满足且没有豁免时，退出码 1，诊断是 `nothing was installed`（`operations.ts` 的 `namedSpecs` / `namedSpecManifest` / `rejected`）。豁免写在 profile 的 `compatibility.json`，键是精确的 `包名@版本`，值是精确的 dsh 版本（`packages/boot/app-boot/src/profile-compatibility.ts` 的 `setProfileVersionExemption`）。授予时 `--dsh-version` 必须等于这次进程读到的运行时，并且要带 `--accept-risk`。

   ```text
   dsh plugin --profile web allow-version @swxs/telegram@0.3.1 --dsh-version 0.2.1-rc.2 --accept-risk
   ```

   `--profile` 放在子命令参数前面。`plugin` 把 `--profile` 之后的剩余参数原样交给后面的逻辑（`apps/cli/src/args.ts` 的 `plugin` 命令；`apps/cli/src/plugin.ts` 的 `versionCommand`）。

2. 把目录装进 web profile。路径用绝对路径，或从当前工作目录出发的 `./`、`../`（可带 `file:` / `link:` 前缀）。只有后者会被锚到调用者的 cwd；不带点的名字会当成注册表 spec（`operations.ts` 的 `anchorPathSpec`；预检里的 `parseInstallSpec` 要求本地路径在锚定之后是绝对路径，`packages/boot/plugin-manager/src/install-spec.ts`）。

   ```text
   dsh plugin --profile web add <插件目录的绝对路径>
   ```

   成功之后，`dependencies` 里出现包名 `@swxs/telegram`，`dsh.profile.bundles` 在原列表末尾追加同一个名字。web 模板的初始列表是 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（`profile.ts` 的 `PROFILE_TEMPLATES.web`）。安装自带的这两层不是 profile 的 dependency，reconcile 会留下它们。

   如果这个包名**已经**在 `dependencies` 里、但不在 `bundles` 里，同一次 `add` 不会把它补进 `bundles`：reconcile 只追加「这次 pnpm 之前还不在 `dependencies` 里」的名字。先卸再装：

   ```text
   dsh plugin --profile web remove @swxs/telegram
   dsh plugin --profile web add <插件目录的绝对路径>
   ```

3. 把用户配置写进 profile 自己的 `cordis.patch.yml`（见下一节），目标 id 是 `telegram`。然后重新启动 `dsh --profile web`。loader 按 `dsh.profile.bundles` 的顺序叠 bundle patch，再叠这份用户层（`profile.ts` 的 `loadProfileDirectory`；`packages/boot/app-boot/src/profile-context.ts` 的 `readProfilePatches`）。

`dsh plugin --profile web install` 是另一条命令，见下节。它不负责把一个还不在清单里的本地目录加回来。

## `dsh plugin add` 与 `dsh plugin install`

两条命令走同一个入口：`dsh plugin --profile <name> <pnpm 参数>` 把参数转给 profile 目录里的 pnpm（`apps/cli/src/plugin.ts` 的 `runPlugin` → `runPluginCommand` → `runProfilePnpm`）。DSH 自己只解析 `allow-version`、`revoke-version`、`version-exemptions`；其余参数是 pnpm 的。

DSH 在 pnpm 前后多做的事：

- `add`、`install`、`i` 被看成会点名安装包的命令（`operations.ts` 的 `INSTALL_COMMANDS`）。点名的 spec 在 pnpm 之前做兼容性预检。`add <目录>` 有一个路径 spec，所以会读那个目录的 `package.json`。`install` 后面没有包名时，预检名单是空的。
- pnpm 以 0 退出、并且没有被空闲超时杀掉之后，`reconcile` 读 profile 的 `package.json`。它只看 `dependencies` 的键，不看 `devDependencies` / `optionalDependencies`（后两者只参加兼容性扫描里的 `directDependencies`）。
- 新出现的 dependency：有 `dsh.bundle` 就解析它的 patch 文件（`loadOverlayPatches`），再把包名追加到 `dsh.profile.bundles`。没有 `dsh.bundle` 就在 stderr 警告 `installed as a plain dependency, not a profile layer`，不成为一层。patch 读失败会抛出，此时 `saveManifest` 还没执行，`bundles` 不会被写上，但 pnpm 已经改过 `dependencies`。
- 从 `dependencies` 里消失、并且这次之前确实是 dependency 的名字，会从 `bundles` 里拿掉。从来不是 dependency 的名字（模板里的 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）留在列表里。
- 启动时若某个已列入 `bundles` 的包在安装锚点和 profile 两边都解析不到，错误文本让你跑 `dsh plugin --profile <profile 名> install`（`profile.ts` 的 `resolveBundleDir`）。那是把**已经写在清单里**的依赖装回 `node_modules`。

因此：

- `dsh plugin add <目录>`：pnpm 把该包记进 `dependencies` 并安装；包名是新 dependency 且声明了 `dsh.bundle` 时，DSH 把它追加为 profile 层。
- `dsh plugin install`：pnpm 按现有 `package.json` / lockfile 安装。它不制造新的 dependency 键，所以也不会为「本来就在 `dependencies` 里」的包补上 `bundles`。

web 这一版的 `normalizeShippedProfile` 只改写 headless 的退役元组，不改 web。`dropRetiredBundles` 只删 `@deepseek-ai/dsh-experimental-schedule-bundle`。启动 web 不会把用户后加的 bundle 清回模板。

## `dependencies` 和 `dsh.profile.bundles` 怎么动

`package.json` 的 `dependencies` 由 pnpm 写。DSH 在成功之后读它。本地目录插件的键是该目录 `package.json` 的 `name`，也就是 `@swxs/telegram`。spec 字符串（`file:` 还是别的形式）是 pnpm 记下来的，DSH 不改写它。

`dsh.profile.bundles` 由 `reconcile` 写回同一份 `package.json`（`saveManifest`，2 空格 JSON）。一次成功的 `add` 之后，列表是：

1. 原来的项里，仍然是 dependency 且装出来的包带 `dsh.bundle` 的，以及从来不是 dependency 的模板层；
2. 这次新出现在 `dependencies` 里、带 `dsh.bundle`、且列表中还没有的包名，按出现顺序追加在末尾。

本仓库的清单满足「会成为一层」：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。解析顺序是安装锚点优先，然后才是 profile 目录（`resolveBundleDir`）。`@swxs/telegram` 不在 dsh 安装里，所以落在 profile 的 `node_modules`。profile 的 pnpm 设置是 hoisted linker（`initProfile` 写入的 `pnpm-workspace.yaml`）。

`dsh plugin add -D` 会把包放进 `devDependencies`。`reconcile` 不读这个字段，所以不会把它追加进 `bundles`。

## 用户配置写在哪一层

四把键是插件行的 `config`：`proxy`、`token`、`allowedUserIds`、`initAdminUserIds`。它们写在 **profile 的 `cordis.patch.yml`**，也就是 `$DSH_HOME/profiles/web/cordis.patch.yml`。

层的顺序（`profile.ts` 文件头；`readProfilePatches`）：

1. `dsh.profile.bundles` 里每个 bundle 自己的 patch，按列表顺序。web 上先是 `@deepseek-ai/dsh-base`，再是 `@deepseek-ai/dsh-web-app`，然后才是后加的 `@swxs/telegram`。
2. profile 的 `cordis.patch.yml`（`PROFILE_PATCH_FILENAME`）。
3. harness home 根上的 `cordis.patch.yml`（每个 profile 都会吃到）。
4. 启动时的 `--patch` 覆盖。
5. 遥测硬关闭补丁（仅当需要时）。

bundle patch 是包里的文件。本仓库这份只插入一行，不带 config（`cordis.patch.yml`）：

```yaml
- insert:
    - id: telegram
      name: '@swxs/telegram'
```

`insert` 没有自己的 `id` 时，行追加到根列表（`vendor/include/src/index.ts` 的 `applyEntryPatches`）。随后的用户层用这个 entry id 覆盖字段。非 insert 补丁整字段替换；`config` 是整对象替换，不会深合并（同一函数；`packages/bundle/base/cordis.patch.yml` 开头也写了「整份 config 替换」）。`name` 若写上且和现有行不一致，这条补丁被跳过并警告 `name mismatch`。id 对不上任何已索引的行时，警告 `patch: entry %C not found` 并跳过（`applyEntryPatches`；`packages/boot/app-boot/src/index.ts` 的 `parsePatchList` 说明：缺目标是单条警告，整份文件解析失败才会抛）。

profile 层写成：

```yaml
- id: telegram
  config:
    proxy: ""
    token: ""
    allowedUserIds: []
    initAdminUserIds: []
```

值按部署填写。`token` 留空时插件会再读 `DSH_TELEGRAM_TOKEN`（本仓库 `src/index.ts` 的 `apply`）；那是插件行为，不是 loader 的一层。密钥放在 profile 这份文件里：`dsh plugin add` 不改写已存在的用户 patch，重装包也不会把它换掉。bundle 的 `cordis.patch.yml` 列在包的 `files` 里，每次启动都从安装出来的包重新读取；把 `token` 写进去会跟着包走，也会在下一次用户层整份替换 `config` 时被盖掉。

home 根上的 `cordis.patch.yml` 同样能写 `id: telegram`，但它叠在 profile 层之后，而且对所有 profile 生效。这四个键要只给 web 用，就写在 `profiles/web/cordis.patch.yml`。

## `examples/telegram-agent/cordis.yml` 的 id

这份文件是一份独立的 entry 列表，不是 patch。web profile 的 loader 不读它。loader 索引的 id 来自各 bundle patch 里的 `id`：`applyEntryPatches` 用 `entry.id` 建表，`EntryTree.store` 也按这个 id 存（`vendor/include/src/index.ts`；`vendor/loader/src/config/tree.ts`）。Cordis 的服务名是另一套字符串：`Service` 构造函数的名字，或插件的 `name` 导出。`inject` 找的是服务名，不是 entry id。

web 模板只挂 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`（`PROFILE_TEMPLATES.web`）。下表是例子里的 `id`，以及这一版 bundle patch 里 loader 实际索引到的 entry id。例子里的相对路径 `../../lib/index.js` 只在「被 insert、且 name 是相对路径」时会被锚成 file URL（`anchorInsertedPluginNames`）。bundle patch 用的是包名 `@swxs/telegram`，由 profile 的 `node_modules` 解析。

| 例子中的 id | 例子中的 name | 这一版 web 组合里的 entry id | 服务名（inject 用的） |
| --- | --- | --- | --- |
| `logger-console` | `@cordisjs/plugin-logger-console` | base / web-app 的 patch 没有这个 id | — |
| `user-questions` | `@deepseek-ai/dsh-user-questions` | `user-questions`（`packages/bundle/base/cordis.patch.yml`） | 行 id 与包对应 |
| `tool-ask-user` | `@deepseek-ai/dsh-tool-ask-user` | `tool-ask-user`，在 preset 的 `config.plugins` 里（`packages/bundle/web-app/presets/standard.patch.yml`、`ptc.patch.yml`、`cordis.patch.yml`），不是 host 根上的一行 | 插件 `name` 导出为 `tool-ask-user` |
| `user-approval` | `@deepseek-ai/dsh-user-approval` | `approval` | `approval`（`packages/interaction/user-approval/src/index.ts` 的 `super(ctx, 'approval')`） |
| `plan-mode` | `@deepseek-ai/dsh-plan-mode` | `plan-mode`。web-app 把 host 这一行 `disabled: true`，standard preset 的 group 里另有同 id | — |
| `telegram` | `../../lib/index.js` | `telegram` | 插件 `name` 导出为 `telegram`。模块名用 `@swxs/telegram` |
| `llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek` | `llm-deepseek` | 这一行的包是 `@deepseek-ai/dsh-llm-deepseek-api-key`（base `cordis.patch.yml`） |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | `subprocess` | 与例子相同 |
| `bash` | `@deepseek-ai/dsh-bash-local` | 没有 `bash`。host 上是 `bash-sandbox` 与 `tool-bash`（Windows 上执行器行是 `pwsh-sandbox`）。web-app 把 host 的 `tool-bash` 关掉，preset 里再挂 `tool-bash` | 执行器注册的服务名是 `shell`（`packages/shell/shell/src/index.ts` 的 `super(ctx, 'shell')`）。`dsh-bash-local` 是 `ShellExecutor` 的子类，不是 web 根上的那一行 |
| `agent-spine` | `@deepseek-ai/dsh-agent-spine-demo` | `agent` | `agents`（`packages/core/agent/src/index.ts` 的 `super(ctx, 'agents')`）。包是 `@deepseek-ai/dsh-agent`。这一版的 `package.json` `"name"` 里没有 `dsh-agent-spine-demo` |
| `sessions` | `@deepseek-ai/dsh-session-persistence-jsonl` | 会话服务的行是 `session`（包 `@deepseek-ai/dsh-session`）。持久化行是 `session-persistence-jsonl` | `sessions` 由 `SessionStore` 注册（`packages/core/session/src/index.ts` 的 `super(ctx, 'sessions')`），对应 entry `session` |
| `session-checkpoints` | `@deepseek-ai/dsh-session-checkpoint-policy` | `session-checkpoint-policy` | 插件 `name` 导出为 `session-checkpoint-policy` |
| `subagent` | `@deepseek-ai/dsh-subagent` | `subagent` | `subagents`（`packages/subagent/subagent/src/index.ts` 的 `super(ctx, 'subagents')`） |
| `subagent-spawn` | `@deepseek-ai/dsh-subagent-spawn` | `subagent-spawn-in-process` | 插件 `name` 导出为 `subagent-spawn-in-process`。包是 `@deepseek-ai/dsh-subagent-spawn-in-process`。没有名为 `@deepseek-ai/dsh-subagent-spawn` 的包 |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | `tool-subagent`。web-app 关掉 host 行，preset 的 `plugins` 里再挂 | 插件 `name` 导出为 `tool-subagent` |
| `tool-todo` | `@deepseek-ai/dsh-tool-todo` | `tool-todo`。同样是 host 行被 web-app 关掉，preset 里再挂 | — |
| `fs-local` | `@deepseek-ai/dsh-fs-local` | `fs-sandbox` | `fs`（`packages/fs/fs/src/index.ts` 的 `super(ctx, 'fs')`）。web 根上挂的是 `@deepseek-ai/dsh-fs-sandbox`，它继承 `LocalFileSystem` |
| `fs-policy` | `@deepseek-ai/dsh-fs-policy` | `fs-observation-policy` | 插件 `name` 导出为 `fs-observation-policy`。包是 `@deepseek-ai/dsh-fs-observation-policy`。没有名为 `@deepseek-ai/dsh-fs-policy` 的包 |
| `tool-fs` | `@deepseek-ai/dsh-tool-fs` | `tool-fs`。host 行被 web-app 关掉，preset 里再挂 | 插件 `name` 导出为 `tool-fs` |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | `token-meter`。web-app 的注释写明 meter 留在 host | — |
| `compact-basic` | `@deepseek-ai/dsh-compact-basic` | `compaction-basic` | 包是 `@deepseek-ai/dsh-compaction-basic`。web-app 关掉 host 行，preset 的 compaction group 里再挂同 id。没有名为 `@deepseek-ai/dsh-compact-basic` 的包 |

telegram 插件的 `inject` 是 `agents`、`agentPresets`、`approval`（本仓库 `src/index.ts`）。web profile 上这三项已经由现有行提供，不需要把例子里的行再插一遍：

- `agents` ← entry `agent`（`@deepseek-ai/dsh-agent`）
- `agentPresets` ← entry `agent-preset-registry`（`@deepseek-ai/dsh-agent-preset-registry`，`packages/bundle/web-app/cordis.patch.yml` 末尾的 insert；`packages/preset/agent-preset-registry/src/index.ts` 的 `super(ctx, 'agentPresets')`）。例子里没有这一行。
- `approval` ← entry `approval`，不是 `user-approval`

往 profile 的 `cordis.patch.yml` 里写配置时，id 用上表这一版的 entry id。写成例子里的 `user-approval`、`agent-spine`、`sessions`、`bash`、`fs-local`、`compact-basic` 时，根树上没有这个 id，loader 跳过该条并警告。
