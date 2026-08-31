# M17-B 设置面板全件恢复 · 原生面实现简报

> 用途：主 agent 照此直接写代码。纯侦察产物，未改动除本文件外的任何文件。
> 事实源：`docs/m17-recon/settings-spec.md` + `src-extras.md` + `docs/m17-ui-parity-plan.md` §四 +
> `preview/webui/src/**`（views/stores/wire/extensions/types）+ `preview/ac-{web-api,agent-admin,tools,
> plugin-core,plugin-registry,agents,timer-core,timer,config,llm,plugin-gates}/src/**` +
> `src/ui/webui/src/settings/schema.ts`（纯函数原样核对）。
>
> 一句话结论：**preview 服务底座基本齐（config/timer/plugin-registry+gates+core/agents/llm），缺的是
> ① 一票薄 RPC 注册行（M17-A 补齐）② SettingsPanel 从"单 Agent 表单"扩成"左导航树 + 多页签" ③
> useSettings 同级状态机。字段直连（不搬 schema 驱动层），多处 src 概念在 preview 无对应——显式缩水。**

---

## A. SettingsPanel 现状 vs 目标差距清单

### A.1 现状（`preview/webui/src/views/SettingsPanel.vue`，536 行）

现有实现是**单一 Agent 管理弹窗**（`<Modal width=860px>`），无导航树、无页签：

- 左侧 = Agent id 列表 + "＋ 新建 Agent" + "新 Agent" 占位（`agentIds` 来自 `agents store`）。
- 右侧 = 一个扁平表单：`id / model / provider / description / maxSteps / virtual / system` + `工具 include/exclude`
  （逗号分隔字符串）+ `hooks`（JSON textarea）。
- 附属区（仅非新建态）：凭据（`setCredential` 只写不读）、AGENT.md 文档（`readDoc/saveDoc`）、
  system-prompt 干跑预览（`systemPrompt`）、生效工具集（`toolDefs`）。
- 保存 = `createAgent` 或 `updateConfig`（局部补丁，`buildPatch` 空串删键）。无 dirty 徽章、无竞态守卫、
  无关闭确认、无定时/插件库/池/全局配置/扩展工具。

**关键差距：无页签、无 AgentListPane/AgentPane 拆分、无 TimerPane、无插件库、无 PoolManager、
无 ExtToolsPane、无全局定时、无 settings-tab slot 渲染。**

### A.2 逐项差距清单（src 面板/页签 → preview 落点 → RPC → 新文件）

| src 面板/页签 | preview 落点 | 需要的 RPC/数据源 | 需要新建的前端文件与组件树 |
|---|---|---|---|
| 左导航树（7 类节点 + 动态 ui-tab） | `views/SettingsPanel.vue` 重写为"树 + selectedNode 分支"壳（保留 Modal 壳） | 已有：`agents/list`；新增：`llm/providers`、`plugin/*`、`config/get`、`timer/list` | `views/SettingsPanel.vue`（重写壳）+ `settings/components/*` |
| `agents` → AgentListPane（池列表 + 新建弹窗） | 新建 `AgentListPane.vue`（列表/搜索/tags/新建/删除） | 已有：`agents/list`、`agents/create`、`agents/delete`；`agents/updated` 事件热刷 | `settings/components/AgentListPane.vue` |
| `agents` → AgentPane（5 内置页签 + 插件页签） | 新建 `AgentPane.vue`（5 页签 + `sortedAgentSettingsTabs` 附加） | 已有：`agents/get-config`、`agents/update-config`、`agents/save-doc/read-doc`、`agents/system-prompt`、`agents/set-credential`、`agents/tool-defs`；新增：`timer/list·save`、`tools/list`、`llm/providers` | `settings/components/AgentPane.vue` |
| `llmPools` → PoolManager(kind=llm) | 新建 `PoolManager.vue` **查看态**（provider/model 路由表只读） | 新增：`llm/providers`（= `ctx.llm.stats()`） | `settings/components/PoolManager.vue` |
| `searchPools` → PoolManager(kind=search) | **缩水**：无搜索池域（见 E）；不建 | 无（web 搜索 = tools，非池） | 不建（或导航树去掉该节点） |
| `extTools` → ExtToolsPane(global) | 新建 `ExtToolsPane.vue`（global/agent 双模式） | 新增：`tools/list`、`plugin/installed`、`plugin/loaded`、`plugin/permissions` | `settings/components/ExtToolsPane.vue` |
| `pluginLibrary` → 插件库四页签 | 新建 `PluginLibraryPane.vue` + `PluginCard/PluginDevCard/StagingReviewModal` | 新增：`plugin/installed·loaded·staging-list·staging-files·staging-file·stage·approve·reject·uninstall·session-register·session-reload·session-unload·permissions` | `settings/components/{PluginLibraryPane,PluginCard,PluginDevCard,StagingReviewModal}.vue` |
| `sys.timer` → 全局定时（面板内联） | 面板内联实现（列表 + 编辑 Modal + builtin 保护） | 新增：`config/get·set`（+ 后端决定全局 schedule 运行时重载，见 F） | 内联在 SettingsPanel（或 `settings/components/GlobalTimerPane.vue`） |
| `ui-tab:<id>`（settings-tab:global） | `sortedSettingsTabs` 渲染（见 F） | 已有：`/api/ui/extensions` + bridge 注册 | 无新文件，SettingsPanel 消费 `slots.ts` |

**新前端文件树（建议落点，全部 `preview/webui/src/settings/` 下）：**

```
settings/
  types.ts                    # FieldMeta / PoolEntry / PoolData / AgentConfigViews / TimerEntry / PluginMeta
  schema.ts                   # 纯函数（见 E，按需精选）
  useSettings.ts              # 状态机 composable（见 G）
  components/
    AgentListPane.vue
    AgentPane.vue
    TimerPane.vue
    PoolManager.vue           # 查看态
    ExtToolsPane.vue          # global/agent 双模式
    PluginLibraryPane.vue
    PluginCard.vue
    PluginDevCard.vue
    StagingReviewModal.vue
    NsFieldList.vue           # 命名空间配置（若做；preview 无 ns schema，可省）
    SettingField.vue          # 字段原子（仅若需 ratio/密码等控件；否则直用 input）
    ConfirmDialog.vue         # 基于 @/ui Modal 的 ask() 命令式确认（全设置域复用）
```

**导航树节点集合**（preview 收敛后）：`agents` / `llmPools`（查看态）/ `extTools` / `pluginLibrary` /
`sys.timer` + 动态 `ui-tab:*`。`searchPools` 显式缩水删除。

---

## B. 字段直连表单设计（AgentPane 五页签）

> 选形（plan §四 决策 1/2/3）：**schema 驱动 → 字段直连**（AgentConfig 已知字段 + `agents/tool-defs` 白名单），
> **effective 双视图 → 单视图**（`agents/get-config` 单视图，dirty = 表单 vs 拉取值比对），
> **双文档合并 → 双端点**（`save-doc/read-doc` + `system-prompt` 干跑）。
>
> AgentConfig 实际键（`ac-agents/src/service.ts` L15-60）：
> `id / model? / virtual? / provider? / system? / tools?（string[] | {include?,exclude?}）/ llmParams? / maxSteps? / description? / hooks?`。
> **llmParams 白名单 = `LLM_SAMPLING_KEYS`**（L84-95）：`temperature / max_tokens / top_p / response_format / stop /
> reasoning_effort / thinking / logprobs / top_logprobs / tool_choice`（共 10 键，`filterLlmParams` 已过滤）。

### B.1 基本信息（info）

| src 字段 | AgentConfig 键 / preview 落点 | 输入控件 | RPC 读写路径 | 缩水/替代 |
|---|---|---|---|---|
| 头像 avatar | ❌ 无对应 | — | — | **缩水**：无头像域（plan B 档：头像延后）。列表/表单用 emoji 占位 |
| 昵称 name | ❌ 无 `name` 字段 | — | — | **缩水**：preview 只有 `id`，无显示名。表单直接展示/编辑 `id`（新建态可输入） |
| Agent ID | `id`（只读展示，mono） | 只读文本 | `agents/get-config`（新建态 = 输入框 + 白名单校验） | 新建 Agent 已有（`createAgent` 走 ac-agent-admin 白名单） |
| 能力标签 tags | ❌ 无 `tags` 字段 | — | — | **替代**：能力门禁 = `ToolDefinition.requires` + `AgentConfig.hooks['security'].capabilities`（ac-tools contract L25-32）。若装 ac-security，标签编辑落到 `hooks['security'].capabilities: string[]`（JSON 或 chips）；否则不建 |
| SYSTEM.md | `system`（人设基础块）+ `system-prompt` 干跑预览 | textarea（mono）+ "预览装配结果"按钮 | 读 `get-config`；写 `update-config({system})`；预览 `agents/system-prompt` | src"覆盖 builtin 装配"语义 = 基础块，preview 无 builtin 装配层，`system` 即基础块 |
| AGENT.md | `agents/save-doc('AGENT.md')` + `read-doc` | 开关 + textarea | `readDoc/saveDoc`（空=删） | 与现状一致，保留 |

### B.2 模型（llm）

> src 的"模型池选择 + 生效摘要四级来源推导 + 模型列表代理读取按钮"三件在 preview **无池层 → 缩水**。
> 模型页收敛为：`model/provider` 直选 + `llmParams` 分组字段 + 凭据只写口。分组沿用 src 三组（无 schema，硬编码）：

| src 分组/字段 | AgentConfig 键 | 输入控件 | RPC 读写路径 | 缩水/替代 |
|---|---|---|---|---|
| 模型池选择 | ❌ 无池引用（`llm.$ref`） | — | — | **缩水**：preview 模型路由在 yml（出厂态），Agent 直写 model/provider，无池快照拷贝 |
| 生效摘要条（四级来源） | ❌ 无 | — | — | **缩水**：无 effective 视图，无来源推导 |
| provider | `provider` | 下拉（选项来自 `llm/providers` 的 `providers[].name`） | `update-config({provider})` | 选项数据源新增 `llm/providers` |
| model | `model` | 文本框（placeholder 路由缺省） | `update-config({model})` | — |
| 模型列表代理（"读取"按钮） | ❌ 无 models 列表 RPC | — | — | **缩水**：plan B 档 `agents/models` 按需随批；M17-B 不建 |
| base_url / api_key | api_key → `agents/set-credential`；base_url ❌ | password（apiKey 只写不回显） | `setCredential(agentId, provider, value)` | **替代**：api_key 走凭据域（更安全）；base_url 无 Agent 级字段（adapter 在 yml） |
| 推理 reasoning_effort / thinking | `llmParams.reasoning_effort` / `.thinking` | text / select | `update-config({llmParams})` | 键名与 src 一致（白名单内） |
| 采样 temperature / top_p | `llmParams.temperature` / `.top_p` | number（0–1 步进） | 同上 | — |
| 边界 max_tokens / stop / response_format | `llmParams.*` | number / text / select(json_object|text) | 同上 | — |
| 隐藏 logprobs / top_logprobs / tool_choice | `llmParams.*` | 折叠区（默认不显示） | 同上 | 白名单含此三键，但默认 auto 可不显示 |

> **llmParams 读写注意**：`llmParams` 是 `Record<string, unknown>`。前端表单应做"整对象编辑 + 空值删键"
> （与 `buildPatch` 同款：`patch.llmParams = {...filtered}`；全空则删键）。保存前**不要**把非白名单键写进去
> （`filterLlmParams` 服务端会丢，但前端先过滤更稳）。

### B.3 定时任务（timer）→ 内嵌 TimerPane（见 C）

### B.4 安全（sec）

| src 字段 | AgentConfig 键 | 输入控件 | RPC 读写路径 | 缩水/替代 |
|---|---|---|---|---|
| 路径穿透白名单 allowedPaths | ❌ 无 `allowedPaths` 字段 | — | — | **缩水**：per-Agent 路径白名单不在 AgentConfig（沙箱路径配置在 `ac-sandbox-core`，非 per-Agent）。本页签可省，或只读展示沙箱当前策略 |

### B.5 扩展与工具（ext）

> src 三字段统一模型 `presets / tools{include,exclude} / hooks{Record<kind,string[]>}` + legacy 迁移。
> **preview 扩展模型结构性不同**：`hooks[具名]`（per-扩展配置，非有序 hook kind 清单）+ `tools{include,exclude}`，
> **无 presets、无 7 种 hook kind、无 legacy 契约**。legacy 迁移横幅整段删除。

| src 字段 | AgentConfig 键 | 输入控件 | RPC 读写路径 | 缩水/替代 |
|---|---|---|---|---|
| presets（插件启用集） | ❌ 无 `presets` 字段 | — | — | **缩水**：preview 插件启用 = 全局安装态（registry），无 per-Agent preset 清单。per-Agent 行为走 `hooks[具名]` |
| tools include/exclude | `tools: {include?, exclude?}` | 逗号分隔输入框（或工具目录勾选，见 ExtToolsPane agent 模式） | `update-config({tools})` | 与现状 `toolsInclude/toolsExclude` 一致 |
| hooks（Record<kind,string[]>） | `hooks: Record<pluginName, unknown>` | JSON textarea（现状）或按已装扩展生成具名小节 | `update-config({hooks})` | **替代**：键 = 扩展插件名（persona/memory/security…），值 = 该插件自定形状；无 7-kind 目录、无排序 |

> **ExtToolsPane agent 模式**（plan §四"扩展与工具"）收敛为：
> ① 工具区 = `tools/list`（全量目录，带 `requires`） + `agents/tool-defs`（生效集）→ include/exclude 开关；
> ② 扩展区 = 已装插件清单（`plugin/installed`）+ 每插件 `hooks[具名]` 配置（JSON 或 NsFieldList，无 ns schema 时 JSON 兜底）；
> ③ 无 hook kind 导航、无拖拽排序、无 automatic 徽章。

---

## C. TimerPane 5 模式 → ac-timer-core TimerEntry 映射

> `ac-timer-core/src/index.ts` L17-45 的 `TimerEntry` 是权威形状（与 src `settings/types.ts` 的 TimerEntry 有**差异**）。

### C.1 TimerEntry 字段对照

| src TimerEntry 字段 | preview TimerEntry 字段 | 差异/备注 |
|---|---|---|
| `id` | `id` | 前端生成 `timer-<ts>-<rand>` |
| `enabled` | `enabled` | 同 |
| `mode`（time/delay/random/workday/holiday） | `mode`（同 5 值） | 同 |
| `time?` | `time?`（HH:mm / YYYY-MM-DDTHH:mm / 周日 12:00） | 同；preview 额外支持指定日期 `YYYY-MM-DDTHH:mm` 与周几格式 |
| `delay?` | `delay?` | 同（`parseInterval` 支持 30s/5m/2h30m） |
| `delayMin?`/`delayMax?` | `delayMin?`/`delayMax?` | 同（缺省 30s/5m） |
| `repeatCount?` | `repeatCount?` | 同（0/缺省 = 永久） |
| `hint` | `hint`（必填） | 同；`renderHint` 支持 `{{now}}/{{time}}/{{date}}/{time}` |
| `target?` | `target?` | 同（逗号分隔；Agent 级缺省 = 所属 agent） |
| `source?` | `source?` | 同（诊断） |
| `maxSteps?` | ❌ **无** | **缩水**：per-entry maxSteps 不进信封（`AgentConfig.maxSteps` 统一管辖，ac-timer service L18-19） |
| — | `task?`（'archive-all'\|'backup-all'） | **preview 新增**：机制任务不过 LLM（规约 3）。**Agent 级条目可表达机制任务，src 无此字段** |

### C.2 5 模式字段（编辑弹窗逐模式）

| 模式 | 专属字段（TimerEntry 键） | 控件 |
|---|---|---|
| `delay` 延时 | `delay`（间隔串） | text（如 `1h`） |
| `random` 随机 | `delayMin` ~ `delayMax` | text ×2（缺省 `30s`/`5m`） |
| `time` 定时（每天/指定/周几） | `time` | date + time 两个 input 合成 `YYYY-MM-DD HH:mm`（可空=每天 `HH:mm`）；或直接 text |
| `workday` 法定工作日 | `time`（仅时间） | time input |
| `holiday` 法定节假日 | `time`（仅时间） | time input |

公共字段：`repeatCount`（number，0=永久）、`hint`（textarea）、`target`（text，逗号分隔，默认 `user`）、`enabled`、`id`。
新建默认：`mode='delay'`、`delay='1h'`、`repeatCount=1`、`target='user'`。

**校验**（src 原样）：mode=time/workday/holiday → `time` 非空；否则 `delay`（或 random 的 min/max）非空；`hint` 必填。
提示文案："时间/间隔和提示内容不能为空"。

**调度摘要**：直接用 `describeEntry(entry)`（`ac-timer-core` 导出）渲染列表项摘要（`每天 HH:mm`/`工作日 …`/
`节假日 …`/`随机 30s~5m`/`每隔 1h`）。**前端不必重复实现，可把 `ac-timer-core` 纯函数按需打包进 webui**（或复制 describeEntry）。

### C.3 数据源 RPC（新增，M17-A 薄行）

| RPC 名 | 参数 | 返回 | 服务方法 |
|---|---|---|---|
| `timer/list` | `{ agentId? }`（缺省 = 全 owner 视图） | `{ entries: TimerEntry[] }` 或 `{ list: Array<{owner, entries}> }` | `ctx.timers.entries(agentId)` / `ctx.timers.list()` |
| `timer/save` | `{ agentId, entries: TimerEntry[] }` | `{ saved: true }` | `ctx.timers.save(agentId, entries)` |
| `timer/trigger` | `{ agentId, entryId }` | `{ triggered: boolean }` | `ctx.timers.triggerNow(agentId, entryId)` |

> 建议前端镜像方法（加到 `wire/rpc-methods.ts`）：`timerList(agentId?) / timerSave(agentId, entries) / timerTrigger(agentId, entryId)`。

---

## D. 插件库四页签 + StagingReviewModal

> 数据面已全在 `ac-plugin-registry/src/service.ts` + `ac-plugin-core/{manifest,store,contracts}.ts`。前端需要的
> RPC 全部是 M17-A 薄行（`web.registerRpc` 直通服务方法）。**无市场页签**（plan C 档缩水：market/source.ts 未平移）。

### D.1 四页签结构与数据源

| 页签 | 数据源 RPC | 卡片/交互 |
|---|---|---|
| ① 已安装（N） | `plugin/installed` → `InstalledPluginRecord[]` | PluginCard：name/version/source 徽章/描述/owner/安装时间/`provides.tools`（N 工具）/权限徽章三态/卸载（ConfirmDialog → `plugin/uninstall`） |
| ② 待审暂存（N） | `plugin/staging-list` → `PluginStagingRecord[]` | 卡片：name/version/owner/hash(8 位截断)/createdAt/`requiredGrants` 徽章；"审查文件与授予"→ StagingReviewModal；"拒绝"→ `plugin/reject` |
| ③ 会话级（session） | `plugin/loaded`（过滤 `sessionOnly:true`）→ LoadedPluginSummary[] | 卡片：name/version/agentId(owner)/权限/卸载（`plugin/session-unload`）/重载（`plugin/session-reload`）；顶部注册表单（dir 路径 + grants → `plugin/session-register`） |
| ④ 开发目录（dev） | **无 dev-dir 枚举 RPC** | **缩水**：src 的 `catalog.plugins source==='dev'`（扫描 `<workspace>/plugins/<agentId>/<name>/`）无对应面。首期 dev 页签 = 会话级清单 + "注册会话"表单（手工填 dir/owner/grants），不做目录扫描 |

> src 的"市场"页签（search/cached/stage/install）**不建**（C 档缩水）。src 的四页签"已安装/待审/开发/市场"收敛为
> **已安装/待审/会话/（开发目录=缩水为会话注册表单）**。

### D.2 前端需要的 RPC 名与载荷形状建议

| RPC 名 | 参数 | 返回 | 对应服务方法 | 序列化注意 |
|---|---|---|---|---|
| `plugin/installed` | `{}` | `{ installed: InstalledPluginRecord[] }` | `listInstalled()` | 全部 JSON 安全 |
| `plugin/loaded` | `{}` | `{ loaded: Array<{name; manifest; dir; entry; allowedPermissions; agentId?; sessionOnly; watch; loadedAt}> }` | `listLoaded()` | **必须剥掉 `uiDisposer`（函数）与 fiber/module/watcher**；`listLoaded` 已剥 fiber/module/watcher，但 `uiDisposer` 仍需显式剔除 |
| `plugin/staging-list` | `{}` | `{ staging: PluginStagingRecord[] }` | `listStaging()` | JSON 安全 |
| `plugin/staging-files` | `{ id }` | `{ id, files: StagingFileInfo[] }` | `listStagingFiles(id)` | — |
| `plugin/staging-file` | `{ id, path }` | `StagingFileContent`（`{path, content}`） | `readStagingFile(id, path)` | 服务端已做路径守卫 + 1MiB 上限 |
| `plugin/stage` | `{ dir, owner?, source? }` | `{ record: PluginStagingRecord }` | `stage(dir, owner, source)` | owner 缺省 'host' |
| `plugin/approve` | `{ id, grants? }` | `{ result: ApproveResult, load: PluginLoadOutcome }` | `approve(id, grants)` | grants = 额外权限数组（`grantPermissions` 内并默认 fs/network） |
| `plugin/reject` | `{ id }` | `{ id, removedDir? }` | `rejectStaging(id)` | — |
| `plugin/uninstall` | `{ name }` | `{ name, backupDir? }` | `uninstall(name)` | 卸载前 ConfirmDialog 提示 backup 目录 |
| `plugin/session-register` | `{ dir, owner, grants?, watch? }` | `PluginLoadOutcome` | `load({dir, agentId:owner, sessionOnly:true, allowedPermissions, watch})` | — |
| `plugin/session-reload` | `{ name }` | `PluginLoadOutcome` | `reload(name)` | — |
| `plugin/session-unload` | `{ name }` | `{ unloaded: boolean }` | `unload(name)` | — |
| `plugin/permissions` | `{}` | `{ known: PluginPermission[], defaultGranted: PluginPermission[], executionExplicitRequired: PluginPermission[], reviewExplicitRequired: PluginPermission[], hostContractsVersion: string }` | 直取 `ac-plugin-core` 常量 | `KNOWN_PERMISSIONS`/`DEFAULT_GRANTED_PERMISSIONS`/`EXECUTION_EXPLICIT_REQUIRED`/`REVIEW_EXPLICIT_REQUIRED`/`HOST_CONTRACTS_VERSION` |

### D.3 权限词汇表渲染（KNOWN_PERMISSIONS）

`KNOWN_PERMISSIONS = ['fs', 'network', 'process', 'shell', 'ui']`（`ac-plugin-core/src/manifest.ts` L85）。
默认授予 = `['fs','network']`；执行期强制显式 = `['process','shell']`；人审强制 = `['process','shell','ui']`。

前端权限徽章**三态**判定（用 `plugin/permissions` 词汇表 + 插件实际 `allowedPermissions`）：
- **default**（默认授予）：权限 ∈ `defaultGranted` 且插件 manifest 声明了它 → 绿/灰"默认授予"。
- **granted**（已显式授予）：权限 ∈ 插件 `allowedPermissions` 且 ∉ defaultGranted → "已授予"。
- **required**（需授予/未授予）：`manifest.permissions` 中 ∉ `allowedPermissions` 且 ∈ `reviewExplicitRequired` →
  "声明但未授予：…（重启后可能加载失败）"警告行。

### D.4 StagingReviewModal（760 宽人审弹窗）

结构（src §2.6 原样，数据源换 RPC）：
1. 概览：`manifest.name/version`、`owner`、`sourceDir`、`hash`（复制按钮，`navigator.clipboard`）、`createdAt`。
2. 授予勾选区：`requiredGrants` 逐项勾选；`fs/network` 不出现（默认授予）；`ui` 特注"⚠ UI 代码将在浏览器会话上下文执行"；
   `process`/`shell` 注"高危：可执行任意进程/命令"；无额外授予时显示"无需额外授予"。
3. 文件树 + 内容预览：`plugin/staging-files {id}`（自动打开首个文件）+ `plugin/staging-file {id, path}`（pre/code 只读）。
   **请求序号守卫**：快速切文件/切记录丢弃晚到响应（`stagingSeq` 计数）。
4. Footer：关闭 / **拒绝并删除暂存**（`plugin/reject`）/ **批准安装**（`plugin/approve {id, grants}`；requiredGrants 未勾齐禁用 + "请先勾选授予：…"）。
5. 完成 → 父级 flash + `emit('refresh')`；approved 自动跳已安装页签。

### D.5 插件域 WS 事件（已存在，前端订阅刷新）

`plugin/installed` / `plugin/reloaded` / `plugin/catalog-changed` 三事件已在 `wire/events.ts` 目录（L281-283），
ac-plugin-registry 已 emit。前端 `PluginLibraryPane` 订阅 `plugin/catalog-changed`（刷新列表，带 `catalogSeq` 竞态守卫——
见 G）。src 的 `agent.assembly.changed` 在 preview 无对应（无装配视图），不建。

---

## E. PoolManager 查看态 + ExtToolsPane + "设为默认"纯函数搬运

### E.1 PoolManager（查看态）

- **llm 池 = `llm/providers` RPC（新增）**：`{ providers: LlmProviderStats[] }`（`ctx.llm.stats()`，
  `ac-llm/src/service.ts` L100-107：`{name, models, instantiated, description?}`）。渲染为只读路由表（provider 名 →
  model 清单 → 是否已实例化 → 描述）。
- **搜索池 = 缩水删除**：preview 无 search-provider 域（web 搜索是 tools：`ac-web-search-core` 的 tavily/serpapi/brave/
  deepseek/duckduckgo 注册为 tools）。src 的 searchProviders 池 CRUD 无对应。
- **无编辑弹窗**（C 档：模型路由表住 yml 出厂态，运行期池编辑不建 src 式 CRUD）。"设为默认/首条自动默认/ratio 清理"
  逻辑**不触发**（无池编辑入口）。

### E.2 ExtToolsPane（global/agent 双模式）

| 区域 | global 模式 | agent 模式 | 数据源 |
|---|---|---|---|
| 插件区 | 纯目录（installed+loaded），无开关，顶部提示"启用/停用在各 Agent 面板" | 已装插件清单 + 每插件 `hooks[具名]` 配置编辑（无 presets 开关） | `plugin/installed` + `plugin/loaded` |
| 钩子区 | **不建**（preview 无 7-kind hook 目录） | **不建** | — |
| 工具区 | 全量工具目录（含 `requires` chips） | include/exclude 开关（写 `tools`）+ requires 门禁提示 | `tools/list`（全量）+ `agents/tool-defs`（生效集） |

**工具三态开关**（agent 模式，src §2.5 收敛版）：
- `默认`：requires 门禁通过 + 不在 exclude + 非显式 include。
- `显式`：∈ `tools.include`。
- `已停用`：∈ `tools.exclude`。
- 开关写 `tools.include/exclude` 单一意图（exclude 优先）；requires 不满足时禁用（`ToolDefinition.requires` 来自 `tools/list`）。

**新增 RPC**：
| RPC 名 | 参数 | 返回 | 服务方法 |
|---|---|---|---|
| `tools/list` | `{}` | `{ tools: Array<{name, description?, parameters?, requires?}> }` | `ctx.tools.list().map(t => ({name, description, parameters, requires}))`（注意：现有 `agents/tool-defs` 只回 description/parameters，**需补 `requires`**） |
| `llm/providers` | `{}` | `{ providers: LlmProviderStats[] }` | `ctx.llm.stats()` |

### E.3 "设为默认"纯函数搬运清单（条件性）

`src/ui/webui/src/settings/schema.ts` 中三个函数（已原样核对，L101-230）：
`sanitizeGlobalConfig` / `applySearchPoolDefault` / `applyLlmPoolDefault`（+ 内部 `collectKeepOverrides` / `defaultPoolEntryName`）。

**结论：这三个函数 + `search-pool-default.test.ts` / `llm-pool-default.test.ts` 两个测试，在 preview 当前形态下
【条件性搬运——默认不搬】**。理由：它们的唯一用途是让"config.json 内联的池表（llmProviders/searchProviders）与全局
引用（llm / tool.web_search 的 $ref）保持同步"。而 preview：
- 模型路由住 yml（出厂态），**不在 config.json 内联池表**；
- 无 search-provider 池域；
- `$ref` 折叠/池引用语义是 src GET 展开回写 bug 的对策，preview 无此 GET 展开行为。

**仅在主 agent 决定把"模型池内联进 config.json + 全局 llm 引用"作为新特性引入时**才搬：
- 落点：`preview/webui/src/settings/schema.ts`（与 `toFields/filterFields/isNonDefault` 同文件，纯函数零依赖）；
- 测试：`preview/webui/tests/search-pool-default.test.ts` + `llm-pool-default.test.ts`（src 原样搬，断言遮蔽剥离/
  中性字段保留/$ref 指向默认/悬空清理）。
- `sanitizeGlobalConfig` 中"掩码 api_key 清理"半边对 preview 无意义（api_key 走凭据域不回显）；`$ref` 折叠半边同样无意义。

**建议**：M17-B **不搬这三个函数**；在简报里标注"若未来引入 config 内联池则同搬"。`toFields/filterFields/
isNonDefault/parseNum/formatRatio` 这些 schema 归一化纯函数也**不搬**（字段直连决策），除非主 agent 决定保留
NsFieldList 的 JSON 兜底编辑（那也只搬 `isNonDefault` 一处）。

---

## F. 全局定时（sys.timer）+ builtin 保护 + settings-tab slot 渲染口

### F.1 全局定时现状与缺口（关键：preview 是"半成品"）

- **Agent 级条目**：完整（`ac-timer` `entries()/save()/triggerNow()` + `agentStore entry 'timer'` 持久化）。
- **全局条目**：`ac-timer` 只在**构造期**从 `TimerRowOptions.entries`（`GlobalScheduleEntry[]`）合成到
  `GLOBAL('__global__')` owner（`service.ts` L112、L137-150），**无运行时保存/重载 API**。
- **`GlobalScheduleEntry` 形状**（`ac-timer-core` L48-52）：`{ time, hint?, targets? }` ——
  **无 `builtin`、无 `task`**。

因此 src `sys.timer` 页签的完整恢复需要 4 项缺口（2 项前端、2 项后端 M17-A）：

| 缺口 | 说明 | 归属 |
|---|---|---|
| ① 全局配置读写 RPC | `config/get`（`ctx.config.all()`）+ `config/set`（`ctx.config.merge/set`） | M17-A 薄行 |
| ② config.json 定时键形状 | 决定用 src 兼容 `timer.tasks`（`{time,hint?,targets?,builtin?}`）还是 preview `timer.entries`（GlobalScheduleEntry）。**若要机制任务 + builtin 保护，须扩 GlobalScheduleEntry 加 `task?` + `builtin?`** | M17-A/契约决策 |
| ③ 全局 schedule 运行时重载 | `TimersService.globalSchedule` 构造期固定，config/set 写盘后不生效。需让 `reload()` 从 `ctx.config` 重读全局条目，或加 `timer/reload` RPC / 提示"重启生效" | M17-A |
| ④ builtin 保护语义 | src：`isProtectedTask = 系统任务 && builtin===true` → 删除禁用 + 类型下拉锁定。preview GlobalScheduleEntry 无 `builtin` 字段 → **前端用"任务类型 + 约定"替代**（见 F.2） | 前端 |

### F.2 builtin 保护（preview 替代语义）

preview 机制任务 = `TimerEntry.task = 'archive-all' | 'backup-all'`（规约 3）。**但全局条目合成不映射 task**，且
`GlobalScheduleEntry` 无 builtin 字段。M17-B 前端落点（在无后端改动前提下的保守方案）：

- **前端保护约定**：以"hint 精确匹配机制任务标签"判定受保护项（`hint === '__archive_all__'` 或
  `hint === '__backup_all__'` 的全局条目，或后端若补 `task` 字段则按 `task` 判定）。受保护项：删除禁用 +
  类型下拉锁定（只可改时间/目标）。用户新建的系统任务不受保护。
- **更优方案（推荐给主 agent）**：M17-A 顺手给 `GlobalScheduleEntry` 加 `task?: 'archive-all'|'backup-all'` +
  `builtin?: boolean`，并把 `TimersService.reload()` 的全局合成映射带上这两个字段（L141-148 处补
  `task: t.task`、`builtin: t.builtin`）。前端就按真字段判定，与 src 语义对齐。

### F.3 settings-tab slot 渲染口现状与补齐点

`preview/webui/src/extensions/slots.ts` **已完备**：
- `settingsTabs / agentSettingsTabs` ref + `sortedSettingsTabs / sortedAgentSettingsTabs` computed；
- `registerSettingsTab / registerAgentSettingsTab`（同 id 替换、order 升序）；
- `resolveTabProps(tab, base)`（props 对象或 `(base)=>props` 工厂，与 base 合并）。
- bridge 侧已注入 `UiExtensionContext.registerSettingsTab / registerAgentSettingsTab`（`extensions/types.ts` L37-38），
  host.ts 已加载插件并调用 `install(bridge)`。

**唯一缺口：`views/SettingsPanel.vue` 不消费这两个 registry**。补齐点：
1. 全局页签：导航树动态节点 `ui-tab:<id>` → `<component :is="tab.component" v-bind="resolveTabProps(tab, baseGlobal)">`，
   `baseGlobal = { globalConfig }`（src 还注入 nsSchemas/pools，preview 缩水为 globalConfig）。
2. Agent 页签：AgentPane 页签条末尾附加 `sortedAgentSettingsTabs` → 同上，
   `baseAgent = { agentId, config, ... }`（src 注入 raw/effective/emit，preview 单视图 = `config`）。
3. 未知页签兜底文案"未知页签"（插件刚卸载场合）。
4. **注意**：当前 `SettingsPanel.vue` 的 Modal `:visible="true"` 且由 `ui.settingsVisible` 控制，重写后需保留
   `ui.openSettings(agentId)` 定位语义（`ui.settingsAgentTarget`）与 `closeSettings()`。

---

## G. 前端状态模型（useSettings → preview composable 设计）

> src `useSettings`（22.7K，非单例）→ preview 收敛为 `preview/webui/src/settings/useSettings.ts`（非单例，
> SettingsPanel 持有一份）。**核心保留项：快照式 dirty + 竞态守卫（loadSeq/catalogSeq）+ 身份快照保存**——这些是
> 旧轨踩坑沉淀，平移时保留。**裁剪项**：effective 双视图、assembly 三字段同步、legacy 迁移、ns 命名空间 helper。

### G.1 state/ref 清单

```
// ---- 元数据块（loadMeta，Promise.allSettled 聚合） ----
llmProviders   = ref<LlmProviderStats[] | null>      // llm/providers（替代 llmSchemas/searchSchemas）
toolsCatalog   = ref<ToolDefFull[] | null>            // tools/list（含 requires；替代 nsSchemas）
pluginInstalled= ref<InstalledPluginRecord[]>([])     // plugin/installed
pluginLoaded   = ref<LoadedPluginSummary[]>([])       // plugin/loaded（sessionOnly 过滤出会话页签）
pluginStaging  = ref<PluginStagingRecord[]>([])       // plugin/staging-list
pluginPermissions = ref<PermissionsView | null>(null) // plugin/permissions
metaError      = ref('')                             // 聚合诊断（N/6 项失败）

// ---- 全局配置块 ----
globalConfig   = ref<Record<string,unknown>>({})     // config/get
globalSaved    = ref('')                             // sanitize 快照字符串
globalDirty    = computed(() => globalSaved !== '' && snapshot(globalConfig) !== globalSaved)
// snapshot = JSON.stringify(stripEmpty(globalConfig))  （api/client.ts 已有 stripEmpty；sanitize 掩码清理可省）

// ---- 当前 Agent 块（单视图 + 文档 + 定时） ----
agentId        = ref('')
agentRaw       = ref<AgentConfig | null>(null)       // agents/get-config（单视图）
agentSaved     = ref('')                             // 拉取值 JSON 快照
agentDirty     = computed(() => JSON.stringify(projectedPatch()) !== agentSaved)
sysContent/agentContent = ref<string|null>(null)     // readDoc('SYSTEM.md'?)/'AGENT.md'（src 双文档，preview 至少 AGENT.md）
agentTimers    = ref<TimerEntry[]>([])               // timer/list
agentTimersSaved = ref('')
timersDirty    = computed(() => JSON.stringify(agentTimers) !== agentTimersSaved)
agentLoadSeq   = ref(0)                              // 竞态守卫：config/timer 两段各自 seq 检查

// ---- 插件域（刷新守卫） ----
catalogSeq     = ref(0)                              // 插件库刷新竞态守卫
```

### G.2 dirty 判定

- **单视图退化**：无 effective，`agentDirty = 表单投射出的 config（fetch 值 + 本地覆盖）!= agentSaved`。
  实现建议：表单直接编辑 `agentRaw` 的**浅拷贝**，保存时用 `update-config` 传差异 patch（现状 `buildPatch` 语义，
  `ac-agent-admin` 服务端 `computeDiff` 回 `changed[]`）；`agentDirty` 用"patch 非空"或"投射 JSON != saved"判定。
- **空对象防御**：`saveGlobal` 前若 `globalConfig` 为空对象 → 拒绝写盘（"全局配置为空，已取消保存"）。
- **saveTimers 丢失更新守卫**（src §3.3 保留）：服务端回显仅在本地未继续编辑时应用（`agentTimers` 当前 JSON === 发送快照）。

### G.3 竞态守卫（保留三项）

1. `agentLoadSeq`：`selectAgent` 时 `++`；`loadAgent` 的 config/timer 两段异步各自捕获 seq，返回时 `seq !== agentLoadSeq` 则丢弃。
2. `catalogSeq`：`loadPluginCatalog` 并发守卫——WS `plugin/catalog-changed` 风暴连发时只接受最新一次调用发起的响应。
3. `resetAgent`（面板关闭）：`agentLoadSeq++` 作废在途响应 + 清空 agent 块（防"已放弃编辑复活"——面板常驻挂载，同 id 不重载）。

### G.4 保存顺序（saveAll）

> src 顺序：assembly PUT → config POST → refreshAssembly → timers。preview **无 assembly**，收敛为：

```
saveAll():
  1. agent 配置   → agents/update-config(agentId, patch)      （isNew → agents/create）
  2. 文档         → agents/save-doc(agentId, 'AGENT.md', ...) （若 sysContent 也映射，再加 'SYSTEM.md'）
  3. 定时         → timer/save(agentId, agentTimers)          （仅 timersDirty）
  4. 全局配置     → config/set(globalConfig)                  （仅 globalDirty）
  5. agents.refresh()（热刷）+ 按上下文 flash "已保存 · 下次运行生效"（3.5s 自动消失）
```

> 凭据（`setCredential`）与文档（`saveDoc`）是独立即时保存按钮，不进 saveAll（与现状一致）。"重启后端"按钮
> 依赖 M17-A `system/restart` RPC（ac-restart 机制已就绪），M17-B 可先留占位（禁用 + tooltip"待 system/restart RPC"）。

---

## H. 验收清单（每步命令 + 手测路径）

| 步骤 | 命令 | 手测路径 |
|---|---|---|
| 1. 前端类型检查 | `pnpm --filter ac-webui-app typecheck` | 无 |
| 2. 前端单测 | `pnpm exec vitest run preview/webui/tests` | 新增测试：`settings-schema`（若搬纯函数）、`timerEntry` 映射、`pool-default`（条件性） |
| 3. 后端类型（M17-A RPC 改动后） | `pnpm preview:typecheck` | 无 |
| 4. 后端单测（M17-A RPC 改动后） | `pnpm preview:test` | 新增 ac-web-api RPC 测试（timer/config/plugin/llm-providers/tools） |
| 5. 冒烟 | `pnpm preview:smoke` | 无 |
| 6. 真连手测 | `pnpm preview:boot`（后端）+ `pnpm preview:webui`（前端 dev，port 3831） | 见下 |

**手测路径（逐功能）**：
1. **AgentPane 五页签**：打开设置 → 选 Agent → 切 5 页签，改基本信息（system/description/virtual/maxSteps）→
   保存 → 看 `agents/updated` 热刷 + "变更键"提示；模型页改 `llmParams.temperature` → 保存 → `get-config` 回读验证。
2. **TimerPane**：定时页签新增 `delay=1h, repeat=1` 条目 → 独立"保存定时配置" → `timer/list` 回读；改 `time=08:30` →
   校验（hint 必填）；`enabled` 开关列表内 toggle。
3. **插件库四页签**：已安装页签卸载一个插件（ConfirmDialog）→ `plugin/uninstall` → 列表刷新；`plugin/stage` 一个目录 →
   待审页签出现 → StagingReviewModal 看文件树/内容/勾选 grants → `plugin/approve` → 自动跳已安装。
4. **ExtToolsPane**：global 模式看工具目录（`tools/list` 含 requires chips）；agent 模式 include/exclude 一个工具 →
   保存 → `agents/tool-defs` 生效集变化。
5. **PoolManager 查看态**：llmPools 节点看 provider/model 路由表（只读）。
6. **全局定时**：sys.timer 节点看 config.json timer.tasks 列表（若 config RPC 就绪）；改时间 → 保存 → `config/changed`
   事件触发前端刷新。
7. **settings-tab 渲染口**：装一个带 `settings-tab:global` 的 UI 插件 → 设置面板出现动态页签 → 渲染插件组件。
8. **关闭确认**：有 dirty 时关闭面板 → "放弃未保存的更改"确认（ConfirmDialog）。

---

## 附：前端镜像 RPC 方法面（`wire/rpc-methods.ts` 新增，供主 agent 直接加）

```
// —— M17-A 后端就绪后，RpcMethods 类新增（result 形状手抄自 ac-web-api/ac-agent-admin 薄行） ——
configGet(): Promise<{ config: Record<string, unknown> }>                    // 'config/get'
configSet(config: Record<string, unknown>): Promise<{ saved: boolean }>      // 'config/set'
llmProviders(): Promise<{ providers: LlmProviderStatsWire[] }>               // 'llm/providers'
toolsList(): Promise<{ tools: ToolDefFullWire[] }>                           // 'tools/list'
timerList(agentId?: string): Promise<{ entries: TimerEntryWire[] }>          // 'timer/list'
timerSave(agentId: string, entries: unknown[]): Promise<{ saved: boolean }>  // 'timer/save'
timerTrigger(agentId: string, entryId: string): Promise<{ triggered: boolean }> // 'timer/trigger'
pluginInstalled(): Promise<{ installed: InstalledPluginRecord[] }>           // 'plugin/installed'
pluginLoaded(): Promise<{ loaded: LoadedPluginSummary[] }>                   // 'plugin/loaded'
pluginStagingList(): Promise<{ staging: PluginStagingRecord[] }>             // 'plugin/staging-list'
pluginStagingFiles(id): Promise<{ id, files }>                               // 'plugin/staging-files'
pluginStagingFile(id, path): Promise<{ path, content }>                      // 'plugin/staging-file'
pluginStage(params): Promise<{ record }>                                     // 'plugin/stage'
pluginApprove(id, grants?): Promise<{ result, load }>                        // 'plugin/approve'
pluginReject(id): Promise<{ id, removedDir? }>                               // 'plugin/reject'
pluginUninstall(name): Promise<{ name, backupDir? }>                         // 'plugin/uninstall'
pluginSessionRegister(params): Promise<PluginLoadOutcome>                    // 'plugin/session-register'
pluginSessionReload(name): Promise<PluginLoadOutcome>                        // 'plugin/session-reload'
pluginSessionUnload(name): Promise<{ unloaded: boolean }>                    // 'plugin/session-unload'
pluginPermissions(): Promise<PermissionsView>                                // 'plugin/permissions'
```

（`TimerEntryWire` / `InstalledPluginRecord` / `PluginStagingRecord` / `StagingFileInfo` / `StagingFileContent` /
`PluginPermission` / `PluginLoadOutcome` / `ApproveResult` 形状手抄自 `ac-timer-core` / `ac-plugin-core`——前端自包含原则。）
