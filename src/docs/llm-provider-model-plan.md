# LLM Provider / Model 管理策略重构 —— 调研与变更方案

> 状态：**✅ 已实施（2026-09-01 全批落地：P1-P7）**。三项关键裁决
> （D1 种子收编 / D3 Agent 级凭据彻底移除 / D4 服务端会话元数据域）
> 已按定稿执行。**D1 后续修订（同日，用户裁决）：内置种子机制整体
> 移除**——连接池成为唯一事实源（未配置即不注册、删除即真删、警示
> 判定只看池），消除种子带来的一列衍生复杂度（条目复活 / 伪条目隐藏 /
> 注册面≠配置面判定）。2026-09 立项，源自用户诉求：
> ① baseUrl+apiKey 定义一次 provider（如 deepseek），`/models` 可发现全部模型，
> 没必要按模型重复定义池条目；② 定义 `name = provider(baseUrl, apiKey, …)`
> 后，用 `name@model` 决定用哪个模型；③ Agent 模型设置不得变更/覆盖
> baseUrl/apiKey（连接面锁死在 provider 定义）；④ Agent 会话设置参考
> singles，允许快速切换模型。
>
> 关联事实源：`src/README.md`（能力地图）、`docs/m15-reconciliation.md` #7
> （池抽象当年显式延迟——"延迟到有多模型管理的实际需求"，本方案即该需求
> 到期）、`docs/m17-recon/settings-spec.md`（池/AgentPane 现形状）。

---

## 一、现状盘点（已逐文件核实）

### 1.1 运行时路由（L1，ac-llm）

- `ctx.llm.register(name, factory, { models, description })`：注册中心 +
  懒实例化 + fiber 归属回收；**重名注册抛错**。
- 路由 `resolveProvider`：显式 `input.provider` > `meta.models` 精确匹配 >
  前缀匹配（`m/`、`m-`）。
- 当前注册源：
  - **三个静态适配行** `ac-llm-{openai,deepseek,glm}`：各注册一个固定名
    provider，行配置来自 cordis.yml（apiKey/baseUrl/defaultModel + env 兜底），
    `meta.models` 为**硬编码清单**（deepseek 行写死 3 个模型）；
  - 动态插件（`templates/provider-row`）；
  - 测试 mock（scriptedProvider 等）。

### 1.2 池配置（config.json `llmProviders`）——当前语义是"模型别名池"

条目形状：`{ provider?, model, api_key?(侧信道), base_url?, default? }`，
**条目名 ≈ 模型别名**（`AgentConfig.model` 直接存条目名——ac-credentials
注释明言"AgentConfig.model ≈ 池条目名"）。

消费方矩阵（核实结论）：

| 消费方 | 用法 |
|---|---|
| ac-agent-presets `defaultPoolName` | 默认**条目名** → 预设 model（不取 provider 字段） |
| ac-agent-admin `defaultPoolEntry` | 创建兜底：model = `entry.model \|\| 条目名`，provider = `entry.provider`（**与 presets 口径不一致**） |
| ac-credentials `resolveLlmApiKey` | `pool:${input.model}` 凭据解析链：input.api_key → Agent 级 pool → Agent 级 provider → 全局 pool → 全局 provider → 适配行 env 兜底 |
| ac-web-api | `CONFIG_KEY_PREFIXES` 白名单 + `extractPoolCredentials`/`backfillPoolMasks`（api_key ↔ `pool:<条目名>` 全局凭据，机制完善可复用） |
| webui | PoolManager（模型池 CRUD）、AgentList 新建下拉、AgentPane `$ref` 回显/`applyLlmPool`、ChatInput singles 模型覆盖下拉 |
| **base_url** | **运行时零消费者**（纯 UI 展示/默认值；运行时 baseUrl 只来自适配行 yml 配置） |

全局 `llm` 键（`$ref` 指向默认池条目）：仅 webui 读侧 fallback + schema
折叠逻辑消费；服务端运行时零消费。

**痛点确认（用户①）**：池条目 = 模型别名 ⇒ 同一 deepseek 连接要用 3 个模型
就得建 3 个条目，baseUrl/api_key 重复三份；且运行时按 model 名路由要求
**条目名恰好等于模型 id**（如条目叫 `ds-flash` 则 `resolveProvider`
NO_PROVIDER——除非 AgentConfig.provider 恰好显式给了 'deepseek'）。
池里的 `base_url` 改了也不生效（死配置）。

### 1.3 Agent 模型设置（AgentConfig + ac-agent-admin）

- 字段：`model`（字符串）、`provider?`、`llmParams`（采样白名单 10 键）；
  **无 baseUrl 字段**；apiKey 走侧信道（ALLOWED_FIELDS 含 `apiKey` →
  `ctx.credentials.set(agentId, provider||'default', …)`）。
- `ALLOWED_FIELDS` fail-closed：id/model/provider/virtual/system/tools/
  llmParams/maxSteps/description/tags/settings/apiKey。
- **AgentPane 模型页签的 `base_url` 是死 UI**：BUILTIN_LLM_SCHEMA 展示
  api_key/base_url/model + 采样键，但 `saveAgentConfig` 只映射
  provider/model/api_key/采样键——base_url 保存即丢，运行时也不消费。
- Agent 级 apiKey 覆盖真实存在（`agents/set-credential` RPC + 解析链
  Agent 级 rung）——与用户诉求③"不允许变更覆盖"相悖。

### 1.4 会话级模型覆盖（仅 singles）

- `SingleSessionMeta.model`（undefined = Agent 原配置）；ChatInput 模型
  菜单 `v-if="single"`（**agent 1v1 会话无此菜单**）；选项 = 池条目名列表。
- 链路：`singles/update` → session.json → 前端 deliver 带 `model` 参数 →
  `conversation/deliver`（M18-G 已透传）→ `RouterSendOptions.model` →
  信封 `model: options.model ?? agent.model`。
- **关键缺口：provider 跟随 Agent 不跟覆盖**（router 只覆盖 model 字段，
  `provider: agent.provider`）⇒ singles 快速切到**另一家 provider 的模型**
  根本走不通（除非裸模型名恰好命中那家适配行的 meta.models）。
- 思考强度菜单不受 single 门控（所有会话可用）——模型菜单扩到 1v1 有先例。
- 前缀快照修订键已含 `request.model`（ac-singles `prefixRevision`）——
  换模型 = 换缓存域自然重拍，机制兼容，无需改。

### 1.5 /models 发现：不存在

- `ac-openai-completions` 无 `listModels()`。
- AgentPane「读取」按钮注释宣称"走后端代理，从凭据库附加认证"，实际
  `fetchAgentModels` 调 `llm/providers` RPC 返回**静态 meta.models 并集**
  ——假代理（M17 缩水项，从未补）。
- web-api 无任何 models 代理端点。

### 1.6 记账/事件口径

- ac-usage `loop/after-run` 记 `request.model` **原文**进
  `usage-*.jsonl`（持久审计）+ byModel 聚合（TokenUsage「按模型」视图）。
- `llm/delta-*` 载荷含 `input`（model 原文）。
- ⇒ 若让 `name@model` 字符串流进 `LoopRunRequest.model`，会污染审计流水
  并使按模型聚合碎片化（`deepseek-v4-pro` 与 `deepseek@deepseek-v4-pro`
  分裂为两行）。

### 1.7 保留字护栏（M23）

`BUILTIN_LLM_PROVIDER_NAMES = ['openai','deepseek','glm']`（ac-plugin-core/
reserved.ts + boot 全树一致性测试）——动态插件不得抢注；**config 池行若能
定义同名 provider，必须与内置行的注册权裁决出唯一归属**（register 重名抛错）。

---

## 二、目标模型（对齐用户诉求）

```
连接定义（全局唯一，settings 面）：        引用语法（单值，UI/wire/会话元数据）：
llmProviders:                             name@model
  deepseek:                               ├ deepseek@deepseek-v4-flash
    base_url: https://api.deepseek.com/   ├ deepseek@deepseek-v4-pro
    api_key: <→credentials pool:deepseek> ├ glm@glm-5.3
    defaultModel: deepseek-v4-flash       └ …（裸模型名 = 旧路由，兼容）
    default: true
    models: [发现缓存，/models 拉取]
```

- **一个连接一个条目**（诉求①）：baseUrl/apiKey/defaultModel 归 provider
  定义；模型清单由 `/models` 发现（诉求①），不再按模型建条目。
- **`name@model` 引用语法**（诉求②）：左 = provider 名（池条目名/内置名），
  右 = 模型 id；裸模型名保留旧路由语义（精确 > 前缀）全兼容。
- **Agent 模型设置只选不连**（诉求③）：provider + model（+ 采样参数），
  连接字段（baseUrl/apiKey）不在 Agent 面出现、不可覆盖。
- **会话级快速选模**（诉求④）：singles 语义升级为 `name@model` 并可跨
  provider；agent 1v1 会话补同款菜单。

---

## 三、变更方案（分批）

### P1 纯库与契约（零行为变更的地基）

1. `ac-openai-completions` 增 `listModels(options?: { api_key? }): Promise<string[]>`
   ——GET `{baseUrl}/models`，Bearer 鉴权（`api_key` 覆盖构造默认，同
   stream 的传输层键语义），`fetchImpl` 注入测试零网络。Ollama 等非标
   `/api/tags` 不做（首期 OpenAI 兼容面）。
2. `ac-llm/src/contract.ts` 增纯函数 `splitModelRef(ref: string):
   { provider?: string; model: string }`——按**首个 `@`** 拆分；左段为空或
   右段为空 → 原样返回（视作裸模型）。配套 `joinModelRef(provider?, model)`
   （显示/wire 拼装单点）。
   - 拆分策略（防误伤含 `@` 的模型 id）：router 侧拆分后若左段**不是已注册
     provider 名**（`ctx.llm.providers()` 含种子），回退整串按裸模型路由
     （最终由 `resolveProvider` 的 roster 报错兜底，可诊断）。

### P2 配置驱动的 provider 注册行（核心新件，诉求①落地）

新行 **`ac-llm-pool`**（inject `['llm','config','credentials']`）：

- 读 `config.llmProviders`，逐条 `ctx.llm.register(name, factory,
  { models: entry.models ?? [], description: entry.base_url })`；
  factory = `OpenAICompletions({ baseUrl: entry.base_url, defaultModel:
  entry.defaultModel })`——apiKey 不进工厂（凭据链 per-request 注入，
  见 P4-3）。
- **内置种子让位语义**：config 无同名条目时按现三适配行缺省注册
  `openai/deepseek/glm`（baseUrl/env 兜底原样平移，保留开箱即用）；
  config **有**同名条目 → 完全以 config 为准（用户可改官方连接的
  baseUrl/默认模型——这正是诉求①"定义好 provider"的含义）。种子与
  config 注册在**同一行内**做归属裁决，绕开行序不确定性；`register`
  重名抛错转为可诊断的配置校验错（"条目名 X 与内置种子/其他条目冲突"）。
- **热更**：订阅 `config/changed` → diff 条目集 → 撤注册（disposer，已
  实例化 provider 自动 `close()`）→ 重注册。与 ac-agent-presets 的
  `refreshModels` 同款事件驱动模式。
- **三静态适配行退役**：cordis.yml / ac-app TREE 删除 `llm-openai/
  llm-deepseek/llm-glm` 三行（包删除或保留一版标记 deprecated）；
  `BUILTIN_LLM_PROVIDER_NAMES` 保留字表**不动**（种子仍内置，防动态插件
  抢注的语义不变；reserved-consistency 测试改对照池行的注册面）。
- `meta.models` 从硬编码改为**发现缓存驱动**（P3 回写 config → 热更重
  注册）——裸模型名精确匹配路由因此对动态发现的模型也生效（存量
  `AgentConfig.model = 'deepseek-v4-pro'` 无感兼容）。

### P3 /models 发现面（诉求①的"找到三个模型"）

- 新 RPC **`llm/models`**（ac-web-api）：入参 `{ name, refresh? }` →
  解析连接（config 条目 base_url；凭据 `pool:<name>` 全局 → 种子 env 兜底）
  → `listModels()` → 返回 `{ models: string[] }`。
- **缓存回写**（`refresh: true` 或条目无 models 时）：写
  `config.llmProviders[name].models` → `config/changed` → P2 热更重注册。
  读取路径（AgentPane/ChatInput 下拉）优先吃 config 缓存，免去每次拉取。
- 修正 AgentPane「读取」假代理（现调 `llm/providers` 静态并集）——改调
  本 RPC（M17 缩水项就此补齐）。

### P4 `name@model` 寻址接线（诉求②落地）

1. **router.send 边界拆分**（`ac-router`）：对 `options.model ?? agent.model`
   过 `splitModelRef`——左段有效则 `provider = 左段`（**覆盖 agent.provider，
   修复 1.4 的跨 provider 缺口**）、`model = 右段`；裸名维持现语义。
   `LoopRunRequest.model` **恒为裸模型 id**（契约不变），带来的好处：
   ac-usage 审计/聚合、`llm/delta-*` 载荷、singles 前缀快照修订键全部
   天然干净，L1 `LlmService` **零改动**（provider 优先路由已存在）。
2. **写侧归一**（存储态收敛）：
   - `ac-agent-admin` sanitize：入参 model 含 `@` → 拆存
     `provider + model` 两字段（AgentConfig 存拆分态，检索/展示双字段）。
   - `SingleSessionMeta.model` 保持**单值 ref 字符串**（`name@model` 或裸名
     ——会话覆盖是轻量单值语义，与现状同构）；deliver 拆分交给 router。
   - `ac-subagent` 派生信封处补同款 `splitModelRef` 防御（父 model 存量
     可能带 `@` 的迁移窗口）。
3. **凭据解析链收窄**（`ac-credentials` `resolveLlmApiKey`）：
   - poolRef 键从 `pool:${input.model}` 改为 **`pool:${有效 provider}`**
     （input.provider 优先，其次 splitModelRef(model).provider）——凭据
     锚定"连接"而非"模型别名"，与池 v2 语义对齐；
   - **删除 Agent 级 rung**（Agent pool / Agent provider，诉求③）：
     `agents/set-credential` RPC + agent-admin `apiKey` 侧信道 + ALLOWED_FIELDS
     的 `apiKey` 一并退役（fail-closed 风格，与 M24 X1 同款"删旧强制迁移"；
     存量 Agent 级凭据由迁移脚本搬至 `pool:<provider>`）。

### P5 Agent 模型设置收敛（诉求③落地）

- AgentPane 模型页签：
  - **删除 api_key / base_url 字段**（BUILTIN_LLM_SCHEMA 收缩为 model +
    采样键）；页签头部提示"连接由 Provider 定义（设置 → 模型管理）"。
  - 选择器升级：provider 下拉（池条目 ∪ 内置种子）+ model 下拉
    （`entry.models` 缓存 + 「读取」真代理按钮）→ 写
    `provider + model` 双字段；生效摘要沿用（来源标注 Provider 名）。
- `ac-agent-admin.defaultPoolEntry` 与 `ac-agent-presets.defaultPoolName`
  **口径统一**为：默认池条目 → `provider = 条目名, model = defaultModel`
  （消除 1.2 的两处不一致）。
- AgentList 新建对话框 / AgentListPane：模型下拉从池条目名改为
  provider × model 矩阵（双字段提交）。

### P6 会话级快速选模（诉求④落地；D4 裁决 = 服务端会话元数据域）

- **singles**：ChatInput 模型菜单选项改为按 provider 分组 × `models` 缓存
  （+「默认模型」空选项），值 = `name@model`；选中即时 PATCH
  （`singles/update` 原样，服务端仅加格式校验：`@` 左段须为已知 provider
  名或整串裸名）。菜单内加「刷新」入口调 `llm/models`。持久化沿用
  session.json 既有 `model` 字段——**独立会话不进 conv-settings 域**
  （自包含会话语义不变，避免双源）。
- **新能力域 `ac-conv-settings`（会话设置，D4 裁决落点）**——按「新增
  能力域 checklist」全套：
  - 契约（contract.ts）：`ConvSettings = { model?: string /* name@model
    或裸名 */ }`；服务 `ctx.convSettings`；
  - 事件（events.ts）：`convSettings/updated`（@mode emit / @scope host；
    载荷 = conversationId + 变更后设置——多端/多标签同步广播）；
  - 服务（service.ts）：owns `<root>/conv-settings/<conversationId>.json`
    （规约 2：文件名即 conversationId；对桶 `a~b` / 群 gid 均文件系统安全，
    `~` 已被 assertAgentId 挡在路径危险字符外；sid 形态天然合法但按上条
    不写入）；`get(conversationId)` / `set(conversationId, patch)` /
    `clear(conversationId)`，原子写（tmp+rename，同 singles）；
  - 组合根：cordis.yml + ac-app TREE 加行（两表行集一致）；
  - RPC（ac-web-api）：`conv-settings/get {conversationId}` /
    `conv-settings/set {conversationId, patch}`（patch.model null = 清除）；
  - **生效合并点 = conversation/deliver**（web-api 薄编排行）：入参
    `model` 缺省时查 `ctx.convSettings.get(conversationId)` 补投——
    "会话级模型覆盖"在会话边界单点生效，任何客户端（含未来非 WebUI 端）
    零改动获得同一语义；显式入参优先（临时换模不回写）。
- **agent 1v1 会话**：ChatInput 模型菜单去掉 `v-if="single"` 门控；
  非 single 会话选中即 `conv-settings/set`（conversationId = 前端既有的
  pairKey 推导口径），读取走 `conv-settings/get` 回显。

### P7 前端配套与迁移

- PoolManager 改版为 **Provider 连接管理**：字段 = 名称/base_url/api_key
  （侧信道机制原样）/defaultModel（models 缓存下拉）/default（全局默认
  连接）/models 只读清单 + 「读取模型」；`LLM_PROVIDER_DEFAULTS` 保留为
  新增条目的 applyDefaults。
- types/schema/useSettings 同步池 v2 形状；`applyLlmPoolDefault` 的
  shadowKeys 同步收缩（provider/model 不再是池条目遮蔽键）。
- **迁移脚本** `scripts/migrate-llm-pool-v2.ts`（先例
  migrate-hooks-to-settings.ts：幂等 + marker + `--dry-run` + 恒等门测试）：
  1. 池：旧别名条目按 `provider || base_url 归一` 分组合并为 provider 条目
     （defaultModel 取 default:true 或首条目；`default` 传递）；
  2. 凭据：`pool:<旧别名>` → `pool:<provider名>`（去重合并）；
     Agent 级凭据 `<agentId>_<provider>_API_KEY` → 并入全局 `pool:<provider>`
     （仅当全局为空时，防覆盖）；
  3. AgentConfig.model 存量别名 → 拆 provider+model（agents 数据目录遍历）；
  4. singles session.json model 别名 → `name@model`。
- README 布局图/链路图、两技能（agentchat-framework/plugin-dev 的 provider
  行叙述）同步。

### 测试与验收（对照仓库规约）

| 面 | 用例 |
|---|---|
| ac-openai-completions | listModels 成功/401/非 200/空清单（fetchImpl 注入零网络） |
| ac-llm | splitModelRef 纯函数表驱动（含 `@` 在头部/尾部/多个/不含） |
| ac-llm-pool（新） | 注册/回收；config 热更 diff；种子让位（config 定义 deepseek → 种子不注册）；重名冲突可诊断；凭据经 pool:<name> 注入 |
| ac-router | @ 覆盖优先级（override@ > agent.provider > 裸名路由）；左段非注册名回退；override 跨 provider 生效 |
| ac-credentials | 新解析链（pool:<provider> 全局单级）；Agent 级 rung 删除后旧键不再生效 |
| ac-agent-admin | model 含 @ 拆存；apiKey 字段 fail-closed 拒绝（破坏性变更红灯） |
| ac-conv-settings（新） | get/set/clear + 原子写 + `convSettings/updated` emit；deliver 缺省 model 时合并生效（web-api 集成） |
| ac-web-api | llm/models RPC；config/set llmProviders v2 校验；掩码侧信道回归；conv-settings 两 RPC |
| webui | port-b / e2e：PoolManager v2、AgentPane 无连接字段、ChatInput 分组下拉 |
| 一致性 | reserved-consistency 对照池行注册面（三适配行退役后） |

---

## 四、关键决策点（D1/D3/D4 已裁决 ✅；D2/D5 默认按推荐执行）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 三静态适配行去留 | ✅ **收编为池行种子**：三行退役，池行在 config 无同名条目时按现缺省注册 openai/deepseek/glm——开箱即用保留，config 同名条目可覆盖官方连接的 baseUrl（满足诉求①） |
| D2 | `@` 拆分位置 | （默认采纳推荐）**router 边界拆分，LoopRunRequest.model 恒裸名**——L1 零改动、usage/delta/快照天然干净 |
| D3 | Agent 级凭据覆盖收窄幅度 | ✅ **彻底移除**：UI 字段 + `agents/set-credential` RPC + 解析链 Agent 级 rung + ALLOWED_FIELDS 的 `apiKey` 键全删，存量凭据迁移脚本并入全局 `pool:<provider>` |
| D4 | 1v1 会话模型覆盖持久化 | ✅ **服务端会话元数据域**：新 owning 域 `ac-conv-settings`（见 P6），deliver 边界单点生效，跨设备漫游 |
| D5 | 旧池数据迁移方式 | （默认采纳推荐）一次性迁移脚本（幂等/marker/dry-run/恒等门，M24 X1 先例） |

## 五、风险与缓解

- **破坏性变更面**：`agents/set-credential` 删除、AgentPane 连接字段删除、
  池形状 v2——集中在一次切换 + 迁移脚本 + PR 描述明示（与 M24 X1 同款
  "类型删除强制迁移"节奏）。
- **`@` 误伤模型 id**：拆分仅当左段为已注册 provider 名，否则整串按裸模型
  路由；`resolveProvider` roster 报错文案列全清单，可诊断。
- **发现缓存过期**：`models` 是缓存不是事实源——provider 侧上新模型后
  「刷新」即可；`name@model` 寻址**不依赖**缓存（右段原样发往 provider），
  缓存仅服务下拉与裸名精确匹配。
- **凭据迁移覆盖风险**：Agent 级 → 全局 pool 仅在全局为空时并入，
  dry-run 报告冲突项。
- **conv-settings 与 singles 双源边界**（D4 引入）：独立会话的模型覆盖
  恒走 session.json（singles/update），conv-settings 不收 sid 键——
  ChatInput 按会话形态分流写口；两域无读写交叉，无双源歧义。
- **conversationId 键域**：conv-settings 接受对桶 `a~b` / 群 gid / 任意
  调用方显式键；sid 传入时服务端拒绝（防误写双源）。

## 六、建议实施顺序

P1（纯库+契约）→ P2（池行+退役）→ P3（发现 RPC）→ P4（@ 接线+凭据收窄）
→ P5（Agent 面收敛）/ P6（会话选模：singles 语义升级 + ac-conv-settings
新域，两者可并行）→ P7（迁移+文档）。P1-P2 合并首批可独立冒烟
（`pnpm typecheck && pnpm test && pnpm smoke`），P4 起每批带回归测试；
ac-conv-settings 按新增能力域 checklist 全套交付（契约/事件/服务/
组合根两表/测试/README）。
