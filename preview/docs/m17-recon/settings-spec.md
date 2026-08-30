# M17 Recon —— 旧轨 UI 设置域（src/ui/webui/src/settings/）功能规格

> 分析对象：`AgentChat/src/ui/webui/src/settings/`（旧轨 WebUI 最重的功能域）。
> 方法：纯读源码，逐文件、字段级核对。所有行号/接口名以当前 checkout 为准。
> 用途：为 preview 原生前端恢复该域提供精确功能清单与后端面差距对照（见 §5）。

---

## §1 SettingsPanel 左侧导航树完整结构

`SettingsPanel.vue` 是统一设置弹窗（82vw×82vh 模态，替代旧 GlobalSettings + AgentSettings）。
设计原则写在文件头注释：**"数据：schema 驱动；展示 effective、编辑 raw"**。

左侧树当前形态（`tree` computed，L65-80）——**全部为根叶子节点（type:'leaf'），无 category 分组**：

| # | 节点 id | 标签 | 右侧渲染（selectedNode 分支） |
|---|---------|------|------------------------------|
| 1 | `agents` | Agent 设置 | 有 `editingAgent` → `AgentPane`（Agent 配置表单）；否则 `AgentListPane`（Agent 池列表） |
| 2 | `llmPools` | 模型管理 | `PoolManager kind="llm"`（`pools=llmProviders`、`schemas=llmSchemas`） |
| 3 | `searchPools` | 搜索引擎 | `PoolManager kind="search"`（`pools=searchProviders`、`schemas=searchSchemas`） |
| 4 | `extTools` | 扩展与工具 | `ExtToolsPane mode="global"`（插件/钩子/工具只读目录 + 命名空间默认配置） |
| 5 | `pluginLibrary` | 插件库 | `PluginLibraryPane`（已安装/待审/开发/市场 四页签） |
| 6 | `sys.timer` | 定时任务 | 面板内联实现（全局 timer.tasks 列表 + 编辑 Modal，含 builtin 保护） |
| 7+ | `ui-tab:<id>`（动态） | 插件自定义 | `<component :is>` 渲染 `settings-tab:global` slot 注册的插件全局设置页签（`sortedSettingsTabs`，props 注入 globalConfig/nsSchemas/pools） |

**残留/休眠分支**（准确起见）：
- 模板中保留 `selectedNode.startsWith('ns.')` → `NsFieldList` 分支（L439-445）与 `schemaLabel()`（含 'tool.bash'/'agent.session' 等中文映射），但当前 `tree` 不再生成任何 `ns.*` 节点——命名空间配置已收进 ExtToolsPane 的钩子/工具弹窗。该分支是休眠路径。
- `expanded`/category 相关样式与状态仍在，但无 category 节点消费。

**面板级壳能力**：
- 打开时（watch visible）→ `loadMeta()` + `loadGlobal()`；带 `initialAgentId` 则直接跳 `agents` 节点并 `openAgentEditor(agentId)`（聊天页/侧边栏入口定位）。
- 关闭时 → `editingAgent=''` + `settings.resetAgent()`（防"已放弃编辑复活"——面板常驻挂载，同 id 不重载）。
- Header：当前节点标题、`● 未保存` dirty 徽章（`globalDirty || agentDirty || assemblyNeedsSave`）。
- Footer：错误/成功/提示文案、**重启后端**按钮（确认弹窗 → WS `system.restart`；30s 兜底复位 restarting，防事件丢失永久卡死）、关闭（dirty 时确认"放弃未保存的更改"）、**保存配置**（saveAll：先 global 后 agent，成功后按上下文提示"已保存 · 下次运行生效"——Agent/全局分别提示，3.5s 自动消失）。
- 组件卸载 → `settings.disposePluginWs()`（撤销插件域 WS 订阅，防重开面板重复刷新）。

---

## §2 面板组件：功能清单 + 数据源 + 关键交互

### 2.1 AgentListPane（Agent 池列表）

**用户可见能力**：
- Agent 卡片列表：头像（`a.avatar ?? /api/agents/:id/avatar`，组件生命周期内固定 `?t=` 缓存破坏戳）、名称、ID、`虚拟` 徽章（virtual Agent 如 user，无配置文件仅作路由端点）、tags 徽章（内置 tag 配色 + hover 说明：base/agent=基础能力、admin=系统管理工具、dev=开发工具、conductor=子代理编排）。
- 搜索框：按名称 / ID / 标签 过滤（大小写不敏感）。
- 点击条目 / "编辑"按钮 → 进入 AgentPane。
- "+ 添加 Agent" → 创建弹窗：名称（必填）、ID（留空自动生成，字母/数字/连字符/下划线）、模型 Provider（可选，留空继承全局；选项来自 llmSchemas keys）、模型名称（选了 provider 才显示，默认值取该 provider schema 的 model 字段 default）。
- "删除" → ConfirmDialog（danger，"将删除该 Agent 的所有配置、会话历史和凭据"）→ 确认后删除。

**数据源**：`fetchAgents()` = `GET /api/agents`（core/api/endpoints/agents.ts）；创建/删除经 SettingsPanel → `useSettings.createAgent/removeAgent` = `POST /api/agents` / `DELETE /api/agents/:id`，成功后 `loadMeta()` 刷新。

**关键交互**：创建成功且指定了 id → 自动 `openAgentEditor(id)` 直达编辑器。删除当前正在编辑的 Agent → 退回列表。

### 2.2 AgentPane（Agent 配置巨型表单，5 内置页签 + 插件页签）

**顶部导航条**：返回 Agent 列表、Agent 名（raw.name 回退 effective.name 回退 id）+ ID（mono）、上一个/下一个 Agent 快速切换（按 agents 列表序，禁用态带 title 提示目标名）。

**页签条**：`基本信息 / 模型 / 定时任务 / 安全 / 扩展与工具`（5 内置）+ `sortedAgentSettingsTabs`（`settings-tab:agent` slot 的插件页签，附加在内置之后）。切 Agent 时 tab 重置为 `info` 并重置模型页本地派生状态（selectedLlmPool/llmModelOptions/llmModelsError——防 A 的池/模型列表串台到 B）。

#### 2.2.1 基本信息（info）

| 字段/区块 | 编辑目标 | 说明 |
|-----------|---------|------|
| 头像 | `POST /api/agents/:id/avatar`（FormData file）/ `DELETE .../avatar` | 点击上传（png/jpeg/webp/svg，≤2MB）；本地 blob 预览（换图 revoke 旧 blob URL 防泄漏）；上传中遮罩；hover 显示移除 ×；`GET .../avatar?t=Date.now()` 缓存破坏；文件 input 选后复位（同文件二次可选） |
| 昵称 name | `raw.name` | 输入框，placeholder 回退 effective.name |
| Agent ID | 只读展示 `effective.agent_id ?? agentId` | mono |
| 能力标签 tags | `raw.tags` | 固定徽章 base（隐式基础层，始终启用不可移除）/admin/dev/conductor + assembly.tools.catalog 中工具 `requires` 出现过的其他标签排后；点击开关；自定义领域标签输入（回车添加，展示为可删 chips）；旧标签 `agent` 读取时归一化为 `base` |
| SYSTEM.md | `sysEnabled` + `sysContent`（useSettings 状态） | "覆盖 builtin.build-system-prompt 装配的系统提示词"；勾选启用后出现 textarea（11 行 mono） |
| AGENT.md | `agentEnabled` + `agentContent` | "定义 Agent 的角色、行为和能力边界"；同上开关 + textarea |

#### 2.2.2 模型（llm）

数据源：`llmSchemas[provider]`（`GET /api/plugins/llm-schemas`）经 `toFields`/`filterFields` 归一化；展示值 `getLLM(key)` = raw.llm 覆盖优先、回退 effective.llm（全局/池合并结果）。

渲染为扁平 section 序列（`llmSections`）：

1. **模型池选择**（section type 'pool'）：下拉 = "默认（继承全局）" + `pools.llmProviders` 各条目（`名称 · model`）。选中池 → `applyLlmPool`：写 `raw.llm = { $ref: 池名, ...池条目非 $ 字段默认值 }`（= 切池即拷贝池快照，再逐字段改）；选"默认" → 删除 `raw.llm`（继承全局）。
   - 下方常显**当前生效摘要条**：`model/provider + 来源`，来源判定优先级：本 Agent 显式配置（raw.llm 有非 $ref 非空字段）→ `模型池 · $ref` → 全局配置 → `全局默认 · 池名`（无显式配置时从 default:true 池或首池推导）。
2. **基础字段**（llmBasic）：schema 中不属于三个分组的可见字段——即 provider、model、base_url、api_key、其余 schema 自定义连接字段（随 provider schema 变化，非硬编码）。
3. **分组标题 + 分组字段**（LLM_GROUPS，顺序渲染）：
   - 推理：`reasoning_effort`、`thinking`
   - 采样：`temperature`、`top_p`
   - 边界：`max_tokens`、`stop`、`response_format`
4. **隐藏字段**：`logprobs`、`top_logprobs`、`tool_choice`（HIDDEN_LLM_KEYS，注释：工具默认 auto 无需配置）。

每字段行交互：
- 字段名右侧**来源徽章**：`本 Agent`（isLlmOverridden = key in raw.llm 且非 undefined）或 `继承`；覆盖行左侧 3px 主色边条高亮。
- `model` 字段专属：**"读取"按钮** → `GET /api/agents/models?base=&provider=&ref=`（后端代理，从凭据库附认证避免浏览器跨域 401；OpenAI 兼容 `/models`、Ollama `/api/tags`）；base_url 解析优先级 = raw/effective 覆盖 → 池 $ref → 全局默认池 → schema 默认；结果填充模型下拉（`llmModelOptions`）。失败显示错误行。
- 覆盖字段显示**恢复继承按钮**（↺）：从 raw.llm 删除该 key；删完只剩 $ref 时收敛为 `{$ref}`，全空时整个删除 `raw.llm`。

#### 2.2.3 定时任务（timer）

内嵌 `TimerPane`（见 2.3）。数据 = `agentTimers`（useSettings），保存按钮 → `settings.saveTimers()`（独立保存端点，不等底部"保存配置"）。

#### 2.2.4 安全（sec）

| 字段 | 目标 | 说明 |
|------|------|------|
| 路径穿透白名单 allowedPaths | `raw.allowedPaths` | "允许 Agent 的工具访问工作区之外的路径。每行一个路径，留空则仅允许工作区内"；本地 draft 保留用户原样输入（含空行），输入时同步 trim 后数组进 raw；显示"已配置 N 个白名单路径" |

（security-check 钩子弹窗对此只做只读概览，见 2.5。）

#### 2.2.5 扩展与工具（ext）

装配声明三字段统一模型（`decl` computed + `patchDecl`）：
- 新契约：直接读写 `raw.presets`（string[]）、`raw.tools`（{include,exclude}）、`raw.hooks`（Record<kind,string[]>）。
- **旧契约 legacy**（`assembly.legacy.hasPlugins === true`）：decl 改从 AssemblyView 派生且**只读**（`onDecl=undefined`、`readonly=true`），顶部黄色横幅"当前为旧契约配置（plugins 声明），本次只读展示；点击「保存配置」后自动迁移为 presets/tools/hooks 新契约"；assemblyError 且无 assembly 时红色错误横幅。
- 停用插件时前端同步修剪该插件拥有的钩子/工具意图条目（与后端 saveAssembly 的 owner 修剪一致）。

传给 `ExtToolsPane mode="agent"`，另传：tags、allowedPaths、globalConfig（命名空间配置弹窗编辑对象）、nsSchemas。

#### 2.2.6 插件页签（settings-tab:agent）

`<component :is>` + `resolveTabProps`（注入 agentId/raw/effective/emit）。未知页签兜底文案"未知页签"（插件页签刚被卸载的场合）。

**AgentPane 数据源汇总**：config 双视图 `GET /api/agents/:id/config`（raw/effective/sysContent/agentContent）；timer `GET/POST /api/agents/:id/timer`；assembly `GET /api/plugins/assembly/:id`；模型列表 `GET /api/agents/models`；头像 `GET/POST/DELETE /api/agents/:id/avatar`；schema/池来自 useSettings 元数据。

### 2.3 TimerPane（Agent 定时任务，5 模式）

**列表项**：调度摘要（scheduleText）+ hint + 重复次数（0/缺省=永久，否则"N次"）；enabled 开关（列表内直接 toggle）；编辑/删除按钮；禁用项摘要与 hint 划线置灰。头部有**独立"保存定时配置"按钮**（saving 态禁用）与"+ 添加定时任务"。

**编辑弹窗字段**（TimerEntry）：

| 模式 | 专属字段 |
|------|---------|
| `delay` 延时（间隔触发） | `delay`（如 1h，支持 30s/5m/2h30m） |
| `random` 随机（范围触发） | `delayMin` ~ `delayMax`（缺省 30s/5m） |
| `time` 定时（每天） | `time`：日期（date input，可空=每天）+ 时间（time input）合成 `YYYY-MM-DD HH:mm` 或 `HH:mm` |
| `workday` 法定工作日 | `time`（仅时间部分） |
| `holiday` 法定节假日 | `time`（仅时间部分） |

公共字段：`repeatCount`（number，0=永久）、`hint`（textarea，触发时发给 Agent 的指令）、`target`（逗号分隔目标，默认 user）、`enabled`、`id`（前端生成 `timer-<ts>-<rand>`）。新建默认：mode=delay、delay=1h、repeatCount=1、target=user。

**校验**：mode=time 时要求 time 非空，否则要求 delay 非空；hint 必填——否则"时间/间隔和提示内容不能为空"。

**builtin 保护在全局定时页而非此组件**（见 2.8）：Agent 级条目无 builtin 概念。

**数据源**：`GET/POST /api/agents/:id/timer`（{entries}）。

### 2.4 PoolManager（模型池 / 搜索池 CRUD，kind 切换复用）

**列表**：条目名（default 条目 ★ 前缀 + 主色边框）、`provider / model` 摘要；动作：**设为默认**（仅非 default 条目显示）/ 编辑 / 删除。空态"暂无条目"。`$` 前缀内部键隐藏（v-show + 过滤）。

**编辑弹窗**（新建/编辑共用）：
- 名称（必填校验"请输入名称"；**重命名 = 删除旧 key 写新 key**）。
- Provider 类型下拉（选项 = schemas keys 动态生成，无硬编码；llm 缺省 deepseek、search 缺省 tavily）。**切换 provider：保留名称，其余字段重置为新 provider 的 schema 默认值**（applyDefaults）。
- 其余字段 = 当前 provider 的 schema 字段全量（SettingField 渲染）。

**保存前清理**：
- 空字符串/undefined 字段删除（v-model.number 空值回 "" 会导致 API 400）。
- ratio 字段 default 未定义且值==min → 视为"使用 API 默认"，不保存。
- **首条目自动设默认**：池中无条目（或仅剩自身）时 `default:true` 并清其他条目 default。

**关键联动**（SettingsPanel `onLlmPoolsUpdate`/`onSearchPoolsUpdate`）：池更新 → 同步 `pools.value` + **直接写入 `globalConfig.llmProviders`/`searchProviders`**（池数据内联在全局配置里）+ `applyLlmPoolDefault/applySearchPoolDefault`（schema.ts）——把全局 `llm`/`tool.web_search` 引用确定性地指向 default:true 条目，防"GET 展开回写的显式对象静默遮蔽池默认"（设为默认不生效 bug）。保存走底部"保存配置"（saveGlobal）。

**数据源**：`GET /api/config/pools`（loadMeta）；写盘 `POST /api/config`（saveGlobal，池内联在 config）。

### 2.5 ExtToolsPane（扩展与工具，global/agent 双模式复用）

**左右布局**。左侧导航：插件（计数）/ 7 种 hook kind（runStart=请求前、stepStart=步骤开始、toolExecutionStart=工具执行前、toolExecutionEnd=工具执行后、stepEnd=步骤结束、runEnd=响应后、fallback=兜底）/ 工具（计数）。

**插件区**：
- 列表按 name 字典序；搜索框（ID/显示名/描述）。每行：label、ID 徽章、source 徽章（builtin=内置/installed=已安装/dev=开发中/session=会话级）、version、**权限徽章三态**（default=默认授予[fs/network]、granted=已显式授予、required=需显式授予/未授予——判定用 `GET /api/plugins/permissions` 词汇表 + 契约内建兜底）、描述、"声明但未授予：…（重启后可能加载失败）"警告行。
- agent 模式：开关写 `decl.presets`（启用插件=写入 config.presets，顺序无意义）；停用时同步修剪其钩子/工具意图条目；未启用置灰。global 模式：纯目录无开关，顶部提示"启用/停用在各 Agent 面板"。

**钩子区（每 kind）**：
- agent 模式清单构成：`config.hooks[kind]` 清单顺序（顺序即执行顺序）→ 未列出的 automatic 钩子（按推荐 order）→ 未启用钩子（按推荐 order）。automatic 徽章 = 基础设施钩子自动进入每个 run **不可停用**（toggle 禁用；但拖入启用区可写进清单固定位置）。
- **开关 = 加入/移出启用清单**（清单即启用集）；开启时按推荐顺序锚点插入（插到第一个推荐序在它之后的已启用钩子前，不打乱既有相对顺序）；推荐序来自 HookInfo.order（RECOMMENDED_HOOK_ORDER 表内位置）。
- **拖拽排序**：仅启用区可拖（draggable=可编辑且启用），落点限定启用区；未列入清单的 automatic 拖入 = 写进 config.hooks 对应位置。
- **"按推荐顺序排序"按钮**：一键重排当前启用清单（只排序不改开关）。
- 钩子所属插件未启用（ownerEnabled=false）→ 开关禁用，title"所属插件未启用"；无主钩子始终可用。
- 行点击 → **详情弹窗**：描述、状态（含提供者 owner）、`configNs` 有值 → 内嵌 NsFieldList 编辑该命名空间配置（schema 按钩子 `fields` 过滤——"按字段级归属精确显示"，缺省=命名空间全部字段）；`security=true`（如 security-check）→ 只读路径白名单概览（来自 agent allowedPaths，指引"白名单在「安全」页签编辑"）；否则"此能力无额外配置项"。
- global 模式：推荐序全量目录，行点击看默认配置（NsFieldList，**弹窗配置一律写全局 config**）。

**工具区**：
- 列表按 name 字典序 + 搜索；每行：label、ID 徽章、"配置"徽章（有 ns 且 nsSchemas[ns] 存在）、描述、**requires 标签 chips**（on=已具备主色/miss=缺少灰——hasTag 判定：base + tags，旧 'agent' 归一化为 base）。
- **三态状态徽章**（toolStatus）：`默认`（auto=随插件默认启用，requires 门禁通过 / 本地重开时按标签推演）、`显式`（explicit=tools.include）、`已停用`（off=tools.exclude 或未开启）。
- 开关写 `tools.include/exclude` 单一意图（exclude 优先）：开启=移出 exclude，requires 为空的工具（无默认启用）必须写 include；关闭=移出 include + 加入 exclude。**标签不足或所属插件未启用时开关禁用**（title 说明原因）；requires 不满足时点击无效果（guard）。
- 行点击 → 工具配置弹窗：描述、状态 + requires chips、有 ns → NsFieldList 编辑命名空间配置（写全局）。
- global 模式：纯目录 + 命名空间默认值调整，无开关。

**数据源**：agent 模式 hooks/tools 目录取自 `assembly.hooks.catalog` / `assembly.tools.*`（`GET /api/plugins/assembly/:id`）；global 模式取自 `GET /api/plugins/catalog`（单真相源：plugins/hooks/tools 三目录）；权限 `GET /api/plugins/permissions`；命名空间 schema `GET /api/plugins/schemas`。

### 2.6 PluginLibraryPane + PluginCard / PluginDevCard / StagingReviewModal（插件库）

**PluginLibraryPane 四页签**：已安装（N）/ 待审暂存（N）/ 开发目录（N）/ 市场 + 刷新按钮。所有动作成功后 `emit('refresh')`（父级 loadPluginCatalog；WS `plugin.catalog.changed` 还会再触发一次）。错误/成功条带显示。

**① 已安装**（PluginCard 列表）：
- 卡片：名称、version、source 徽章、描述、owner / 安装时间 / "提供 N 工具 / M 钩子"（provides）、权限徽章三态（同 2.5，用 permissions 词汇表）、"声明但未授予…（重启后可能加载失败）"。
- 卸载（busy 态"处理中…"）→ ConfirmDialog（说明"目录移动到 <workspace>/plugins/.backup/<name>-<version>-<ts>；Agent 配置中的 presets 引用会保留（未注册插件烘焙时自动跳过）"）→ `POST /api/plugins/library/:name/uninstall`。

**② 待审暂存**（staging 列表）：
- 卡片：name/version/owner/hash（8 位截断，title 全文）/ 创建时间；"需宿主授予"权限 code 徽章（requiredGrants）。
- "审查文件与授予" → StagingReviewModal；"拒绝"（直接，ConfirmDialog）→ `POST /api/plugins/library/reject`。

**③ 市场**：
- 搜索栏：关键词回车/按钮 → `GET /api/plugins/market/search?q=`（GitHub topic:agentchat-plugin 聚合，构造零网络——切换到市场页只读本地缓存 `GET /api/plugins/market/cached`，离线可看）；"缓存"按钮；`stale=true` 时黄条"在线源不可达，以下为本地缓存索引"。
- 条目卡片：manifest 名/version/repo/stars/更新日期/描述/权限（高危=fs/network 之外高亮）；已安装标记 ✓ + 卸载按钮，否则"安装"→ `POST /api/plugins/market/install {spec}`；**报错含"未授予的权限"时自动回落人审流**：`POST /api/plugins/market/stage` → 跳待审页签。
- 卸载走同 ① 端点。

**④ 开发目录**（PluginDevCard 列表，dev = catalog.plugins 中 source==='dev'）：
- 扫描范围提示：`<workspace>/plugins/<agentId>/<name>/`（仅一层 manifest.json）。
- 卡片：名称/version/开发中徽章/（已加载）会话已加载徽章/描述/owner/提供 N 工具 M 钩子/**dir 路径**（mono 块）/权限 chips（无声明则"无额外权限声明"）。
- **注册会话**：声明的权限含高危（≠fs/network）→ 弹 **grants 勾选 Modal**（fs/network 勾选态禁用"默认授予"；高危逐项勾选，ui 特注"⚠ UI 代码将在浏览器会话上下文中执行"；未勾齐时主按钮禁用并提示缺哪项）→ `POST /api/plugins/session/register {dir, owner, grants, watch:true}`；成功提示"已加载为会话级插件（loaded/replaced），并已加入 owner Agent 的 presets 自动生效"。
- **卸载会话**：ConfirmDialog（"从当前进程卸载（源码目录保留；重启后自动失效）"）→ `POST /api/plugins/session/:name/unload`；提示"已从 owner Agent presets 移除"。
- **发布（stage）**：`POST /api/plugins/library/stage {dir, owner}` → 成功跳待审页签。
- 会话重载端点 `POST /api/plugins/session/:name/reload` 在 api.ts 提供（此面板未直接放按钮）。

**StagingReviewModal（人审弹窗，760 宽）**：
- 概览：插件名/version/owner/源目录/哈希（复制按钮，剪贴板）/创建时间。
- **授予勾选区**：requiredGrants 逐项（fs/network 不出现——默认授予；`ui` 特注浏览器执行警告；`process`/`shell` 注"高危：可执行任意进程/命令"）；无额外授予时显示"无需额外授予"。
- **文件树 + 内容预览**：`GET /api/plugins/staging/:id/tree`（path+size 列表，自动打开首个文件）+ `GET /api/plugins/staging/:id/file?path=`（只读内容 pre/code）。**请求序号守卫**：快速切文件/切记录时丢弃晚到响应（防"标题 A 正文 B"）。
- Footer：关闭 / **拒绝并删除暂存**（`POST /api/plugins/library/reject`）/ **批准安装**（`POST /api/plugins/library/approve {id, grants}`；requiredGrants 未勾齐时禁用 + "请先勾选授予：…"）。
- 完成 → done(approved/rejected) → 父级 flash + refresh；approved 时自动跳已安装页签。

**ConfirmDialog**（通用件）：基于 ui/Modal 的 Promise 化确认弹窗（`ask({title,message,confirmLabel,danger}) → Promise<boolean>`），替代原生 confirm；danger=true 主按钮红色。全设置域复用（关面板/重启/删 Agent/卸载/拒绝）。

**数据源汇总**：`GET /api/plugins/library`（installed+staging）、`GET /api/plugins/session`（会话级清单）、`GET /api/plugins/catalog`（dev 卡数据）、`GET /api/plugins/permissions`。

### 2.7 SettingField / NsFieldList（schema 驱动表单原子）

**SettingField**（7 种控件，FieldMeta.type 分派）：checkbox（displayValue!==false，未设置视为 true）/ select（options；displayValue 回退 default 回退首项）/ number（parseNum，非数字回退原值）/ ratio（range 滑条，min/max/step 缺省 0/1/0.01；formatRatio：display='percent' 显示百分比）/ file（文本框 + "…"按钮 → `POST /api/browse/file {accept,title}` 原生文件选择对话框，mcpFile 有专用标题）/ password（按住眼睛显示，autocomplete=new-password）/ text 兜底。展示值统一 `modelValue ?? field.default`。

**NsFieldList**：命名空间 schema 表单。有 schema → 字段列表（SettingField），内置搜索（label/key 过滤）+ showWhen 条件可见性 + 非默认值高亮（isNonDefault：左侧色条）+ **恢复默认按钮**（resetVal=f.default）。无 schema → **JSON 兜底编辑**（openJson 序列化命名空间对象 → textarea → 应用/取消；非法 JSON 静默不应用）。读写直接改传入的 config 对象（nsKey 空时操作顶层）。

### 2.8 全局定时任务（SettingsPanel 内联，sys.timer 节点）

模型 = `globalConfig.timer.tasks`（`{time, hint?, targets?, builtin?}`，time/hint/targets——**与 Agent 级 TimerEntry 不同模型**）：

- 列表：时间（mono）+ hint（系统任务显示专用 label + "系统"徽章）+ 目标（过滤 `*` 后 join，空=→ 全部）+ 编辑/删除。
- **系统机制任务**（SPECIAL_HINTS）：`__archive_all__`=全局归档（"批量归档所有活跃 1:1 会话（深夜执行，不走 LLM）"）、`__backup_all__`=数据备份（"自动打包备份全部数据（每周一次，不走 LLM）"）——纯机制执行不走 LLM。
- **builtin 保护**：`isProtectedTask` = 系统任务且 `builtin===true`（config 预置）→ **删除按钮禁用**（title"内置系统任务不可删除"）+ removeTask 双保险 return；**类型下拉锁定**（gTaskBuiltin 时 select 禁用，只可改时间与目标）。用户新建的系统任务不受保护（可删/可改回自定义）。
- 编辑弹窗：时间（HH:mm 正则 `^\d{2}:\d{2}$` 校验，错则"时间格式需为 HH:mm（如 08:30）"）、任务类型（自定义报时 / 全局归档（系统）/ 数据备份（系统））、自定义时 hint textarea（留空=默认报时文本；占位符 `{{now}}/{{time}}/{{date}}`）、系统任务时机制说明 + "hint 固定为 <code>，…"提示、目标 Agent（textarea 每行一个，支持逗号/中文逗号分隔，留空=全部）。
- 保存进 `globalConfig.timer.tasks`（ensureTimer 兜底建 timer 结构），随底部"保存配置"写盘（`POST /api/config`）。

---

## §3 useSettings 状态模型

一次 `useSettings()` 调用返回一个**非单例的组合体**（SettingsPanel 持有一份）。核心设计：**展示用 effective（后端解析合并），编辑用 raw（差异），dirty 基于"保存时快照字符串"比对，保存统一走 settings/api.ts**。

### 3.1 元数据块（loadMeta，5 并发 + 失败聚合）

| 状态 | 来源 | 用途 |
|------|------|------|
| `llmSchemas: Record<provider, any[]>` | `GET /api/plugins/llm-schemas` | 模型页字段、PoolManager(llm)、新建 Agent provider 下拉 |
| `searchSchemas` | `GET /api/plugins/search-schemas` | PoolManager(search) |
| `nsSchemas: Record<完整ns键, any[]>` | `GET /api/plugins/schemas`（兼容旧 `{extensions,tools}` 结构 → 补 `tool.*` 键） | ExtToolsPane 钩子/工具弹窗、NsFieldList、插件全局页签 props |
| `pools: PoolData` | `GET /api/config/pools` | 池管理、Agent 模型池下拉、生效摘要推导 |
| `agents: AgentBrief[]` | `GET /api/agents`（fetchAgents） | Agent 列表、上/下切换 |

Promise.allSettled：单项失败不阻塞；有 rejected 时 `error = "部分元数据加载失败（N/5 项）：…"`（聚合诊断，防"空 UI 无报错"）。

### 3.2 全局配置块

- `globalConfig`（`GET /api/config` 的 config）、`globalSaved`（加载/保存时写的 sanitize 快照）。
- `globalDirty = globalSaved!=='' && snapshot(globalConfig)!==globalSaved`；`snapshot` = `JSON.stringify(sanitizeGlobalConfig(raw))`。
- `saveGlobal`：**空对象防御**（HMR 重置等 → "全局配置为空，已取消保存"拒绝写盘）；写盘前 `sanitizeGlobalConfig`（llm `$ref` 折叠防 GET 展开对象回写冻结池引用 + 掩码 api_key `••••••••` 清理：llm、llmProviders 各条、searchProviders 的 tavily/serpapi/brave/deepseek 键）。
- 命名空间 helper：`nsValue/nsSetValue`（nsKey 空=顶层）。

### 3.3 当前 Agent 块（双视图 + 提示词 + 定时）

- `agentId / agentRaw / agentEffective`（`GET /api/agents/:id/config` → AgentConfigViews{raw,effective,sysContent,agentContent}）；`applyAgentViews` 里 `normalizeLegacyTags`（旧标签 agent→base，仅内存归一化，写盘由后端保存）；sysEnabled/agentEnabled 由内容非空推导。
- `sysContent/sysEnabled/agentContent/agentEnabled` 四态（SYSTEM.md / AGENT.md 开关+内容）。
- `agentTimers`（`GET /api/agents/:id/timer`）+ `agentTimersSaved`。
- `agentSaved`（agentStateKey 快照 = config + sys/agent 四态的 JSON）；`agentDirty = cfgDirty || timersDirty`。
- **loadAgent 竞态守卫**：`agentLoadSeq` 请求序号，快速切换 Agent 时丢弃晚到响应（config/timer/assembly 三段各自 seq 检查）。
- **saveAgent 身份快照**：进入即固定 targetId 与数据快照（rawSnapshot/sysSnap/agentSnap/timersSnapshot + timersDirtyOnEntry）；保存中切 Agent 时不再回写他人状态（"A 的配置写给 B"数据损坏级串台防御）。流程：① 有 assembly 且装配 dirty（或 legacy）→ `PUT /api/plugins/assembly/:id`（legacy 迁移发空 patch 由后端归一化；成功后从 raw 删除旧 plugins 声明并同步新契约三字段）；② 其余配置 `POST /api/agents/:id/config`（有 assembly 时从 config 剥离 presets/tools/hooks/disabledTools/disabledHooks/plugins 防双写）；③ `refreshAssembly`（tags 等影响工具烘焙，刷新 tools.enabled 一致性）；④ timers dirty → saveTimersFor。
- **saveTimersFor 丢失更新守卫**：服务端回显仅在"本地未继续编辑"（agentTimers 当前 JSON === 发送快照）时应用；切走则成功不回写。
- `resetAgent`：面板关闭调用，`agentLoadSeq++` 作废在途响应 + 全部状态清空。

### 3.4 插件域五块状态（P2/P3 拆分）

| 状态 | 来源 | 消费方 |
|------|------|--------|
| `agentAssembly: AssemblyView|null` | `GET /api/plugins/assembly/:id` | AgentPane ext 页（hooks/tools 目录 + enabled 快照 + legacy 标记） |
| `agentAssemblySaved / agentAssemblyDirty / agentAssemblyError` | 指纹比对（assemblyOf(raw) 的 presets/tools/hooks+legacy JSON） | assemblyNeedsSave、旧契约迁移横幅 |
| `pluginCatalog: PluginCatalog|null` | `GET /api/plugins/catalog` | ExtToolsPane(global)、AgentPane 插件组目录、PluginLibraryPane dev 页 |
| `pluginLibrary: PluginLibrary|null` | `GET /api/plugins/library` | PluginLibraryPane 已安装/待审页 |
| `pluginPermissions: PluginPermissionsView|null` | `GET /api/plugins/permissions` | 权限徽章三态、grants 勾选 |
| `sessionPlugins: PluginInfo[]` | `GET /api/plugins/session` | dev 卡"会话已加载"态 |

**装配联动细节**：
- `assemblyOf(raw)`：兼容归一化——旧 `disabledTools` 并入 tools.exclude、`disabledHooks` 从 hooks 清单剔除、`legacy = Array.isArray(raw.plugins)`。
- `loadAssembly`：新契约下把 presets/tools/hooks 同步进 raw（旧 legacy 只展示不落 raw），并**前移 agentSaved**（syncRawFromAssembly 重算基线——装配字段同步不算用户编辑）。
- `refreshAssembly`（WS 触发）：本地有未保存装配编辑时**只更新视图、不前移 agentAssemblySaved**（否则热重载事件把未保存编辑基线化，dirty 失效编辑静默丢失）；无编辑时同步 raw + 基线。
- `agentAssemblyDirty`：legacy=true 恒 false（由保存流程强制迁移）。

**loadPluginCatalog 并发守卫**：`catalogSeq` 序号——WS 事件风暴（install/reload 连发）时多个在途 Promise.allSettled 乱序返回，只接受最新一次调用发起的响应（防旧响应把新目录回退）。

**WS 订阅**（组件 mount 时 init 幂等 + 注册 onMessage，SettingsPanel 卸载 dispose）：
- `agent.assembly.changed`（data.agentId === 当前）→ refreshAssembly。
- `plugin.catalog.changed` / `plugin.reload` → loadPluginCatalog + 当前 Agent refreshAssembly（目录变化改变工具/钩子烘焙）。

### 3.5 其余动作

- `restartBackend`：WS `system.restart`（restarting 状态由调用方管理：SettingsPanel 30s 兜底复位）。
- `createAgent/removeAgent`：成功后 loadMeta 刷新。
- 导出面：全部状态 ref + computed dirty + 动作 + `nsValue/setNsValue/disposePluginWs`。

---

## §4 settings/schema.ts 与 types.ts 类型面清单

### types.ts（本地定义）

| 导出 | 一句话 |
|------|--------|
| `FieldMeta` | 归一化字段元数据：key/label/description/type(7 种)/options/min/max/step/display('number'\|'percent')/default/sensitive/accept/showWhen |
| `PoolEntry` | 池条目：provider?/model?/default? + 任意字段（[k:string]:any） |
| `PoolData` | `{ llmProviders, searchProviders }` 两张池表 |
| `AgentConfigViews` | Agent 配置双视图：agent_id + raw（差异编辑底稿）+ effective（全局+Agent 合并展示）+ sysContent/agentContent |
| `TimerEntry` | Agent 定时条目（与后端对齐）：id/enabled/mode(time\|delay\|random\|workday\|holiday)/time?/delay?/delayMin?/delayMax?/repeatCount?/hint/target?/source?/maxSteps? |
| `PluginMeta` | 钩子/工具元数据（旧格式，弹窗用）：name/label/description/type/kind/enabled?/configNs?/fields?/security? |

（另 re-export `@agentchat/protocol` 的 19 个契约类型：PluginPermission、PluginSource、HookKind、PluginProvides、PluginInfo、HookInfo、AgentToolInfo、AssemblyView、AssemblyUpdate、StagingRecord、PluginCatalog、PluginLibrary、PluginPermissionsView、StagingFileInfo、StagingFileContent、MarketEntry、MarketSearchResult、UISlotId、UIExtensionDescriptor、UISlotInfo。形状见 src/sdk/protocol/src/index.ts L149-318。）

### schema.ts（函数面）

| 导出 | 一句话 |
|------|--------|
| `toFields(raw)` | 两种后端 schema 格式（数组 [{name,…}] / 对象 {fieldKey:{…}}）统一归一化为 FieldMeta[]（跳过 `_label`/`$comment`） |
| `isVisible(field, nsConfig)` | showWhen 条件可见性判定（同级配置全等） |
| `filterFields(fields, nsConfig, query)` | showWhen + 搜索关键字（label/key）双重过滤 |
| `isNonDefault(val, def)` | 非默认判定（高亮/恢复按钮显隐；def 缺失时非空即非默认） |
| `parseNum(val)` | 数字解析，非数字回退原值 |
| `formatRatio(val, display)` | ratio 显示：'percent' → 百分比取整，否则原值 |
| `sanitizeGlobalConfig(raw)` | 写盘归一化：llm `$ref` 折叠（防 GET 展开回写；显式内嵌对象保留）+ 掩码 api_key 清理（llm/llmProviders/searchProviders 各键） |
| `applySearchPoolDefault(pools, globalConfig)` | 搜索池"设为默认"确定性同步：全局 tool.web_search 指向 default:true 条目；悬空引用清理；遮蔽字段剥离 + 用户调优保留 |
| `applyLlmPoolDefault(pools, globalConfig)` | 模型池同构同步：全局 llm 指向默认条目（字符串旧格式引用视同 $ref） |

（池同步核心：`collectKeepOverrides` 保留规则——遮蔽字段剥离、默认条目自带字段不保留、与旧条目同值视为展开残留丢弃、其余用户调优保留。）

---

## §5 结论：preview 恢复设置域的后端面对照

preview 现状：`ac-web-api`（读侧 WS RPC 19 方法）+ `ac-agent-admin`（写侧 8 方法）+ `preview/webui` 前端仅有极简 Agent 管理面（`views/SettingsPanel.vue`：建档/补丁表单/凭据/AGENT.md 文档编辑/system-prompt dry-run/生效工具集，写后 `agents/updated` 事件热刷新）。传输形态是 **WS RPC（`domain/action` 命名）而非旧轨 HTTP REST**。

按功能聚类对照（✅=preview 已有对应面；⚠️=部分/近邻；❌=缺口）：

| 功能簇 | 旧轨后端面 | preview 对应 | 判定 |
|--------|-----------|-------------|------|
| Agent 列表 | `GET /api/agents` | `agents/list`（ac-web-api） | ✅ |
| Agent 创建/删除 | `POST/DELETE /api/agents(/:id)` | `agents/create`、`agents/delete`（ac-agent-admin；白名单+凭据剥离+reassign） | ✅ |
| Agent 配置双视图 raw/effective | `GET /api/agents/:id/config` | `agents/get-config`（store 优先回退注册表，**单视图**——effective 合并解析未见） | ⚠️ 差 effective 视图与 sysContent/agentContent 双文档语义（`agents/read-doc` 可读单文档） |
| Agent 配置保存（config+两文档） | `POST /api/agents/:id/config` | `agents/update-config`（deepMerge+computeDiff）+ `agents/save-doc`（空=删） | ⚠️ 契约拆两路；语义可覆盖 |
| SYSTEM.md/AGENT.md | 同上 config 端点 | `agents/save-doc/read-doc` + `agents/system-prompt`（装配 waterfall 干跑预览）+ ac-persona（AGENT.md/persona 注入 loop/before-run） | ✅（形状不同：文档名参数化） |
| 头像 | `GET/POST/DELETE /api/agents/:id/avatar` | 未见（ac-agent-admin 无；file.upload 注释为低优延后） | ❌ |
| 模型列表代理 | `GET /api/agents/models?base&provider&ref` | ac-llm（路由行）/ac-llm-openai 等为出站调用；**对前端的 models 列表 RPC 未见** | ❌ |
| Agent 级凭据 | 随 config（api_key 字段） | `agents/set-credential`（只写不读，空=删）+ ac-credentials 服务 | ✅（更安全：不回显） |
| 全局配置读/写 | `GET/POST /api/config`（含 sanitize 契约） | ac-config ConfigService（all/set/merge/delete/reload 服务在，**无 webServer 路由/RPC 行**） | ⚠️ 服务有、表面缺 |
| 池（llm/search）读 | `GET /api/config/pools` | 池数据模型在 ac-config（全局配置内联）；无专用读口 | ❌（需薄 RPC） |
| llm/search/ns schemas | `GET /api/plugins/llm-schemas`、`/search-schemas`、`/schemas` | 未见 schema 元数据出口（ac-agents 有 `resolveToolNames`/`filterLlmParams`/LLM_SAMPLING_KEYS 纯函数） | ❌（schema 驱动表单的前置） |
| 装配视图 GET/PUT（presets/tools/hooks、legacy 迁移、热重载+WS） | `GET/PUT /api/plugins/assembly/:id` | ac-plugin-registry（PluginRegistryService + register_plugin/unregister_plugin 工具）+ ac-agents resolveToolNames（工具生效集，`agents/tool-defs` 可读）；**装配视图 RPC 未见** | ⚠️ 目录/门禁基础在，AssemblyView 出入口缺 |
| 插件目录（单真相源） | `GET /api/plugins/catalog` | ac-plugin-registry 服务可枚举（loadInstalled）；无 catalog RPC | ⚠️ |
| 插件库（installed+staging） | `GET /api/plugins/library` | ac-plugin-core store.ts 有 **ApproveResult/StagingFileInfo/StagingFileContent** 类型（staging/approve/文件审查纯库在）；无 RPC 行 | ⚠️ 纯库齐、薄行缺 |
| stage/approve/reject/uninstall | `POST /api/plugins/library/stage|approve|reject|/:name/uninstall` | ac-plugin-core store 对应能力；缺 webServer 注册行 | ⚠️ |
| 市场（search/cached/stage/install） | `GET/POST /api/plugins/market/*` | 未见市场发现层（src 侧 market/source.ts 未平移） | ❌ |
| 会话插件（list/register[watch]/reload/unload） | `GET /api/plugins/session*` | ac-plugin-registry 有会话级装载（register_plugin 工具上报意图→宿主执行）；**面向 UI 的 session RPC 未见** | ⚠️ |
| 权限词汇表 | `GET /api/plugins/permissions` | ac-plugin-gates（assertPermissionsGranted/isContractsCompatible + HOST_CONTRACTS_VERSION）；词汇表出口未见 | ⚠️（gate 在，视图出口缺） |
| 暂存文件树/内容（人审） | `GET /api/plugins/staging/:id/tree|file` | ac-plugin-core 已有同形类型 | ⚠️ |
| Agent 定时任务 | `GET/POST /api/agents/:id/timer` | ac-timer（TimersService，条目持久化经 agentStore entry 'timer'）+ ac-timer-core（5 模式算法纯库，TimerEntry 同形）+ ac-jobs/ac-job-wakeup；**timer CRUD RPC 未见** | ⚠️ 服务/算法齐、薄行缺 |
| 全局定时（timer.tasks + builtin + \_\_archive_all\_\_/\_\_backup_all\_\_） | 随 `POST /api/config` | ac-timer 机制任务经运行时可选探测（archive-all/backup-all 同语义）；全局 schedule 配置口缺 | ⚠️ |
| 重启后端 | WS `system.restart`（send）+ `system.restarting` 事件 | ac-restart（system_restart **工具**行：interrupt + 退出码 42 + supervisor 重拉；requires ['admin']）；**UI 触发的 RPC/事件未见** | ⚠️ 机制在，触发面缺 |
| 插件域 WS 事件 | `plugin.catalog.changed` / `plugin.reload` / `agent.assembly.changed` | ac-ws-protocol/ac-ws-bridge 在；这三个事件名未见注册 | ❌（事件目录需扩） |
| 文件浏览对话框 | `POST /api/browse/file` | 未见 | ❌ |
| 插件 UI 设置页签（settings-tab:global/agent slot） | `sortedSettingsTabs`/`resolveTabProps` + `/api/ui/extensions` | ✅ 近邻：preview/webui 已有 extensions/host、slots、registry（perspectives/toolResultViews 等）+ ac-webui `GET /api/ui/extensions`；settings-tab slot 需在 slots.ts 补 |
| raw JSON 兜底编辑 / sanitize（$ref 折叠、掩码清理） | 前端 schema.ts | ac-config-merge 在（deepMerge/computeDiff）；sanitize 前端规则需随前端平移 | 前端职责 |

**总结**：preview 的**服务层底座大多已平移**（config/timer/plugin registry+gates+core/credentials/restart/agents/admin），缺的主要是三类：
1. **薄 RPC 注册行**（模式已有范本：ac-web-api/ac-agent-admin 的 `webServer.registerRpc`）：pools、schemas（llm/search/ns）、assembly GET/PUT、catalog/library/staging/session/permissions、timer CRUD、全局 config 读写、models 列表、restart 触发。
2. **纯缺口功能**：市场发现层（market search/cached/install）、头像上传、原生文件浏览对话框、插件域三个 WS 事件。
3. **契约语义差**：effective 双视图（旧轨展示/编辑分离模型）、AssemblyView 形状（presets/available/hooks.order+catalog/tools.include+exclude+enabled+catalog）、sysContent/agentContent 双文档在 config 端点的合并保存语义——preview 拆成了 doc 端点，前端恢复时需选形（跟随 preview 拆分或补双视图）。

前端侧（preview/webui/src）恢复该域需要的配套：schema 归一化层（toFields/filterFields/isNonDefault/sanitize——纯函数可近原样平移）、FieldMeta 七控件原子（SettingField）、NsFieldList（含 JSON 兜底）、ConfirmDialog/Modal、以及 useSettings 同级的快照式 dirty + 竞态守卫状态机（loadSeq/catalogSeq/身份快照保存——这些是旧轨踩坑沉淀，平移时应保留）。
