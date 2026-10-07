# 首次启动引导（首启向导）方案

> **状态：已实施**（cr-298/299/300/301，2026-10-07 四批一次完成）；方案定稿 2026-10-06（cr-293）。
> 原型已过评审：`sandbox/onboarding-prototype/index.html`（自包含静态页，双主题切换 + 逐字段表单 + 跳过确认演示；本地 `node sandbox/onboarding-prototype/serve.mjs` 后访问 http://127.0.0.1:8899/）。
> 一句话：给首次启动的用户一条五步向导，把「我是谁 → 用哪个模型 → 能不能联网 → 我的第一个 Agent → 界面怎么用」在同一个覆盖层里配完；每一步都能跳过，跳过之后一切仍可在设置里完成。
> 定位：**纯增量前端行**——不新增后端契约 / 事件 / RPC，不动 core 四层，不改既有行行为（除 §4.3 的纯抽取重构）。

---

## 一、目标与范围

### 1.1 目标

1. **首启覆盖层向导**，五步：用户设置 / 模型设置 / 搜索设置 / Agent 设置 / 界面导览。
2. **页面内嵌真实设置表单**（本次立项的主要目的）——用户不必在向导与设置面板之间反复跳转，表单直接落盘。
3. **全程可跳过**；未配模型时的跳过给一次确认，确认后不再拦。
4. **首启只弹一次**；重播入口放左下角活动栏「更多」菜单，**不进设置面板**。
5. **独立前端行包**（包名即身份，与后端零耦合、双向可摘除）。

### 1.2 非目标（显式不做）

- 逐元素说明书 / 截图导览（随 UI 演进必然过期）；二期可按需升级为上下文 spotlight。
- 引导内新建群组、独立会话、定时任务、插件安装等长尾配置。
- 服务端首启标记（理由见 §6 D3）。
- 任何后端契约 / 事件 / 服务 / RPC 端点新增或修改。
- 「用户设置」新建设置节（第 1 步落点已裁为直接编辑 user 虚拟 Agent，见 §6 D1）。

---

## 二、现状事实（实施对照基准，2026-10-06 实测）

### 2.1 设置面板左树

左树是数据化派生的：`settings:section` 选举席（`meta.section` 选举键 + `meta.label` 叶词条 + 顶层 `order`）与插件动态页签 `settings:main-view`（叶 id `ui-tab:*`）追加其后。派生纯函数住 `ac-client-ui-settings/client/sectionTree.ts`，壳 = 同包 `components/SettingsPanel.vue`。

现存节（实测 order）：

| order | section | label | 贡献行 |
|---|---|---|---|
| 10 | `agents` | Agent 设置 | ac-client-ui-agents |
| 20 | `llmPools` | 模型管理 | ac-client-ui-llm-pool |
| 30 | `searchPools` | 搜索引擎 | ac-client-ui-search-pool |
| 40 | `pluginLibrary` | 插件库 | ac-client-ui-plugin-registry |
| 90 | `storage` | 存储管理 | ac-client-ui-desktop-storage |
| 95 | `remote` | 远程设备 | ac-client-ui-remote |

**没有名为「用户设置」的节**——user 端点的档案目前从 Agent 设置进入。这是第 1 步落点裁决的依据。

### 2.2 设置深链

`ac-client-ui-layout/client/uiStore.ts`：

- `openGlobalSettings(section?)` —— 打开设置并定位到节键（既有消费先例：`/timer` 快捷命令定位 `sys.timer`）。
- `openAgentSettings(agentId)` —— 打开设置并定位到某 Agent 的编辑态。

### 2.3 overlay 席位

`ac-client-ui-layout` 声明 `overlay: { kind: 'list' }`（全局覆盖层，非布局区域）。现存消费方与 order：文件预览 90 → 建群 95 → 用量 96 → 版本 97 → 设置 100。新增引导取 **98**（版本之后、设置之前）。

### 2.4 四处数据面（引导表单复用对象）

| 面 | 宿主 | 关键导出 |
|---|---|---|
| 模型池写/探测 | `ac-client-ui-llm-pool/client/poolApi.ts` | `saveLlmPoolDomain`（`config/set` key=`llmProviders`）、`deleteLlmPoolCredential`、`fetchPoolReferences`、`probeLlmModels` 等 |
| 搜索池写 | `ac-client-ui-search-pool/client/searchPoolApi.ts` | `saveSearchPoolDomain`（`config/set` key=`searchProviders`） |
| 池读 / schema / 模板 | `ac-client-ui-settings/client/api.ts` | `getPools`、`getLlmSchemas`、`getSearchSchemas`、`LLM_PROVIDER_TEMPLATES` |
| Agent CRUD | `ac-client-ui-agents/client/rosterApi.ts` + 同包 `client/index.ts` | `getAgentConfig` / `saveAgentConfig` / `createAgent` / `fetchAgents` |

两条既有语义必须沿用：

1. **`api_key` 是凭据侧信道**（服务端 `config/set` 语义）——掩码 = 不动 / 空串 = 删 / 新值 = 存；不落 `config.json`。
2. **防覆盖守门（cr-21）**——池数据未成功加载（`poolsLoaded` 为假）时禁止整域写，否则一次保存会清光后端现有连接。

### 2.5 user 虚拟 Agent（第 1 步的落点）

- 形态：名册中 `id: 'user'`、`virtual: true`。
- `virtual` 语义（`ac-agents`）：不驱动 LLM 循环的会话参与方——router 对 virtual Agent 只发 `router/message-received` 事件，**`model` 永不被消费**。
- 落盘形态见数据根 `agents/user/config.json`（示例：`{ "name": "我", "id": "user", "model": …, "provider": …, "systemPrompt": "" }`）。
- 后端 `ALLOWED_FIELDS`（ac-agent-admin）白名单含：`id / model / provider / virtual / system / tools / llmParams / maxSteps / name / description / tags / settings`。
- `agents/get-system-prompt` 对 virtual Agent 直接抛错（"是 virtual（无系统提示词）"）——故第 1 步**不提供人格文档字段**。
- **待核实（实施批 1 第一件事）**：出厂 `agents/user/config.json` 是否落 `virtual: true`。各测试用 `ctx.agents.register({ id: 'user', virtual: true })` 注册，而示例数据根的 config 未见该键——若不带，编辑面会按普通 Agent 放出模型/工具字段，第 1 步须显式收窄表单项（只读 `name` / `avatar`）。

### 2.6 活动栏「更多」菜单（重播入口的落点）

`ac-client-ui-layout/client/ActivityBar.vue`：底部 `more-trigger` 按钮 + Teleport 到 body 的 `.agentchat-more-menu`，**两项硬编码**：数据备份 / 检查更新。无席位贡献通道 → 见 §4.5。

### 2.7 前端行形态（实现范式）

最小样例 `ac-client-ui-todo` / `ac-client-ui-singles`：

- host 半边 `src/index.ts`：`export const name` / `export const inject = ['webui']` / `export const extension: ExtensionMeta`（`name` = settings 键锚点）/ `apply` 内 `ctx.webui.declareClient({ name, entry, platform: 'web', phase: 'domain' })` + `ctx.effect(() => off)`。
- client 半边 `client/index.ts`：`clientPlugin({ name, inject, apply })`，在 `apply` 里 `ctx.slots.register(...)`。
- 挂载**两处缺一不可**：`src/cordis.yml`（带稳定 id）+ `src/ac-app` TREE 同 id 行。
- client 派发面：不 import webui 内部，只经 `ctx.rpc` 契约面 + 席位。

---

## 三、交互设计（评审定稿）

### 3.1 覆盖层形态

- 尺寸 `min(940px,100%) × min(640px,100%)`，`overlay` 席位渲染（非独立路由页）。
- 左侧步骤条：序号 / 已完成 ✓ / 副标题（如"虚拟 Agent user"），顶部一行「模型：已配置 | 未配置」状态。
- 右侧：eyebrow（第 N 步 / 共 5 步）+ 标题 + 导语 + 表单/内容 + 进度条。
- 底部：`跳过引导`（左）｜`上一步` `下一步/完成`（右）；右上 ✕ 等同「跳过引导」。
- ≤768px：改全屏卡片 + 顶部步骤条横滚（远端 App 同样受益）。

### 3.2 五步细则

#### 第 1 步 · 用户设置

- **目的**：把自己立起来——会话气泡、群聊转录、活动栏署名都用它。
- **落点**：直接编辑 user 虚拟 Agent（不新建设置节）。
- **字段**：头像（上传 / 移除）、昵称（`name`）。
- **写口**：`agents/update-config` → `{ name, avatar }`；头像走既有 `/api/agents/<id>/avatar` HTTP 面（`rosterApi`）。
- **不给的字段**：模型 / provider / 工具 / 采样参数 / 人格文档（virtual 语义，见 §2.5——给了只会误导）。
- 保存按钮 → 成功即在本步标 ✓，可继续下一步。

#### 第 2 步 · 模型设置（首启关键步）

- **目的**：没有可用连接，Agent 一句话都说不出来。
- **字段**：提供方模板（`LLM_PROVIDER_TEMPLATES`）/ 名称（引用名 = `name@model` 左段）/ API 地址 / API Key / 模型清单（「读取模型」经后端代理直调 `/models`，或手工添加）/ 默认模型 / 设为默认连接。
- **写口**：`config/set { key: 'llmProviders', value }`（`saveLlmPoolDomain`）；**保存即落盘**，不等统一保存。
- **守卫**：cr-21 防覆盖守门（池未加载成功禁写）+ `api_key` 侧信道语义。
- **状态探测**：进入本步时读 `getPools()`，连接数 0 → 副标题与文案强调"还没配"；≥1 → 标 ✓。

#### 第 3 步 · 搜索设置

- **目的**：检索类工具（`web_search` 等）依赖搜索引擎连接；不配也能用。
- **字段**：名称 / Provider 类型 / API Key。
- **写口**：`config/set { key: 'searchProviders', value }`（`saveSearchPoolDomain`）。
- 明确标为「最该跳过的一步」；跳过不影响后续步骤。

#### 第 4 步 · Agent 设置（内嵌创建表单，最小字段集）

- **字段**：名称 / 模型（下拉来自第 2 步的连接，格式 `provider@model`；留空 = 跟随全局默认连接）/ 人格（`system`）/ 能力标签（沿用 `AgentPane` 的 `TagChoice` 词表，默认只勾最小可用集）。
- **写口**：`agents/create`（白名单 + model 引用归一）；建完即刻出现在左侧 Agent 列表。
- **不做**：AgentPane 的其余页签（工具细项 / 定时 / 装配 / 系统提示词文档等）——那是长期调整入口。

#### 第 5 步 · 界面导览（独立一步，无表单）

- 一张线框地图（活动栏 / Agent 与群列表 / 会话流 / 辅助侧栏）+ 两句话讲清：
  - **Agent 会话**：与某个 Agent 的长期对话（桶键 = 你~它），人格与记忆都在这儿；
  - **独立会话**：与名册解耦的一次性会话页（桶键 = 会话 id），可单独指定模型。
- 按钮「开始使用」= 走完流程（写首启标记并关闭）。

### 3.3 首启判定与跳过语义

- **存储**：localStorage 单键 `agentchat.onboarding`，值 `{ version: 1, completedAt }`。
- **触发**：无键 → boot 就绪后弹（须等 boot graph 装载完、`__agentchatBootReady` 之后，避免与 splash 抢首帧）。
- **写键时机**：走完全程，或点跳过（含确认后仍跳过）。
- **版本语义**：`version` 只作未来显式决策的锚，**不是自动重弹的理由**（内容小改不重弹）。
- **重播**：不受键影响，随时可重进（入口见 §3.5）。

### 3.4 未配模型的跳过确认

- **触发条件**：正要跳过（`跳过引导` 或右上 ✕）**且** `getPools()` 显示一个 llmProviders 连接都没有。
- **行为**：弹一次确认——说明"现在跳过 Agent 无法回复任何消息；之后可在设置 → 模型管理补配，或在更多 → 新手引导重播"。
- **按钮**：`回去配置`（跳回第 2 步）/ `仍然跳过`（写键退出）。
- **只拦一次**：确认后不再拦；已配模型时不弹。

### 3.5 重播入口

左下角活动栏「更多」菜单内新增一项「新手引导」→ 打开向导并重置到第 1 步。**不放设置面板。**

---

## 四、架构设计

### 4.1 新包 `src/ac-client-ui-onboarding`

目录（照抄 `ac-client-ui-todo` 形态）：

- `src/index.ts` —— host 半边：`name` / `inject = ['webui']` / `extension: ExtensionMeta = { name: 'ui-onboarding', label: '新手引导（前端）', automatic: true }` / `apply(ctx)` 内 `declareClient({ name: 'ui-onboarding', entry: client/index.ts, platform: 'web', phase: 'domain' })` + `ctx.effect(() => off)`。
- `client/index.ts` —— client 半边：`clientPlugin({ name: 'ac-client-ui-onboarding.client', inject: ['rpc', 'slots'], apply })`，注册 `overlay` 席位（order 98）与 `activity-bar:more-menu` 数据席位（见 §4.5）。
- `client/WizardOverlay.vue` —— 向导壳（步骤条 / 进度 / 底部按钮 / 跳过确认）。
- `client/steps/ProfileStep.vue` / `LlmStep.vue` / `SearchStep.vue` / `AgentStep.vue` / `TourStep.vue`。
- `client/onboardingState.ts` —— 首启标记读写（localStorage）+ 步骤状态机 + 「模型是否已配」探测。
- `package.json` —— `type: module`、`exports` 指向 src（含 `./client` 子路径）、`agentchat.plugin: true` + `agentchat.client`；依赖：`@agentchat/cordis` / `@agentchat/webui-kit` / `ac-client-runtime` / `vue` 进 dependencies，被复用面所属包（`ac-client-ui-llm-pool` / `ac-client-ui-search-pool` / `ac-client-ui-agents` / `ac-client-ui-settings`）与 `ac-extension-core` / `ac-webui` 进 devDependencies。
- `tests/` —— 行单测（席位注册形态 + 首启标记纯函数 + 跳过确认判定）。

**挂载两处**：`src/cordis.yml`（带稳定 id）+ `src/ac-app` TREE 同 id 行。

### 4.2 依赖与可摘除性

- 引导行**跨包 import** 复用 §2.4 的四处数据面与 `LLM_PROVIDER_TEMPLATES`。此形态经用户裁决放行（"独立插件包"要求让步：不追求零依赖与自写一套池表单），仓库既有同型先例——`ActivityBar.vue` import `ac-client-ui-system/client/systemApi.ts`、`useAgentSettings.ts` import settings 的 `api.ts`。
- **摘除引导行**：overlay 席位与菜单项随 fiber 回收，首启不再弹；被复用行零改动。
- **反向缺席降级**：若某被复用行不在场（如 ui-llm-pool 被摘），对应步骤降级为静态说明 + 深链按钮，**不得崩**（席位/RPC 失败静默降级是既有约定）。

### 4.3 表单共用件抽取（避免双份漂移，建议必做）

引导内嵌表单与设置面板表单若各写一份，字段一改就漂移。抽取为共用组件（**纯抽取重构，行为分毫不变**）：

| 抽取件 | 现宿主 | 说明 |
|---|---|---|
| `PoolEntryForm.vue` | `ac-client-ui-llm-pool/client/PoolManager.vue`（连接编辑弹窗体） | 设置面板弹窗与引导共用；props = 草稿/模板/schema，emits = 保存 |
| `SearchEntryForm.vue` | `ac-client-ui-search-pool/client/SearchPoolManager.vue` | 同上 |
| `AgentCreateForm.vue` | `ac-client-ui-agents/client/AgentPane.vue` 的基础字段子集 | AgentPane 与引导共用基础字段面 |

若决定不做抽取（省事换空间），须在本档标注为已知债务：引导表单与设置表单字段须人工同步，字段变更时双处修改。

### 4.4 首启标记存储

localStorage 单键，不写后端 config：`config/save` 是**白名单域 replace 语义（白名单外键不动）**，为"首启一次"扩白名单不值当。代价：换浏览器/换设备会各弹一次——可接受。

### 4.5 更多菜单数据席位

`ActivityBar.vue` 现有两项硬编码，引导行若直接改它，卸载后会残留菜单项（违反可摘除性）。做法：

1. `ac-client-ui-layout` 增声明 `activity-bar:more-menu: { kind: 'list'; data: true }`（与既有 `activity-bar:plugin-actions` 同族：数据席位，宿主渲染，插件只填空）。
2. `ActivityBar.vue` 渲染现有两项 + 遍历该席位 entries（order 升序稳定），位置固定在现有项之后。
3. 引导行注册一项 `{ id: 'onboarding', label: '新手引导', icon: …, action: () => 打开向导 }`。

卸载引导行 → 菜单项消失；这是本次唯一必须触碰既有行的地方（除 §4.3）。

### 4.6 与既有行的边界（不改清单）

- 不改任何后端包、不新增事件与服务。
- 不动 `ac-client-ui-settings` 的左树派生与壳（第 1 步不新增节）。
- 不改 `uiStore` 既有方法签名（只用 `openGlobalSettings(section?)`）。
- 不动 `ac-webui` 的 boot graph 机制（新行走既有 `declareClient`）。

---

## 五、分批实施（建议顺序）

> 每批独立可验证、可交付；批间不强依赖（批 1 完成后即使停下，也是一条完整可用的「用户设置 + 导览」向导）。

**批 1 · 骨架 + 首启 + 前两步**

1. 先核实 §2.5 待核实项（user config 是否带 `virtual`）。
2. 建包（host/client 半边 + package.json + cordis.yml/TREE 挂载 + 最小 overlay 壳）。
3. 首启标记 + boot 就绪触发 + 跳过/完成语义 + 未配模型确认。
4. 第 1 步（用户设置）+ 第 5 步（导览）；中间三步先放静态说明占位。
5. 验证：`pnpm typecheck && pnpm test:unit && pnpm check:deps` + `npx eslint src/ac-client-ui-onboarding` + `pnpm webui:typecheck` + `pnpm smoke`（动了行集）。

**批 2 · 模型设置 + 搜索设置表单**

1. §4.3 的 `PoolEntryForm` / `SearchEntryForm` 抽取（先重构既有行并单独验证，行为不变）。
2. 两步表单接入 + 写盘 + 错误反馈（tone 反馈同轴：FeedbackNotice / toast）。
3. 验证：同上 + 定向 `npx vitest run src/ac-client-ui-llm-pool src/ac-client-ui-search-pool`。

**批 3 · Agent 创建表单**

1. `AgentCreateForm` 抽取（或按裁决直接写引导内表单 + 标注债务）。
2. 模型下拉取第 2 步连接；`agents/create` 接入；建完左侧列表可见性验证（经既有 `agents/updated` 帧）。

**批 4 · 更多菜单席位 + 打磨**

1. `activity-bar:more-menu` 席位（layout 声明 + ActivityBar 渲染 + 引导注册项）。
2. 移动端形态（≤768px 全屏卡片 + 步骤条横滚）+ 双主题过目 + 文案定稿。
3. 发版前：`pnpm lint` 全量 + `pnpm test` 全量。

---

## 六、裁决记录（2026-10-06 用户评审）

| 编号 | 议题 | 裁决 |
|---|---|---|
| D1 | 第 1 步「用户设置」落点 | **直接编辑 user 虚拟 Agent**（不新建设置节）：字段仅 `name` / `avatar`，落 `agents/update-config` |
| D2 | 是否需要引导内嵌表单 | **需要**——本次立项的主要目的；「独立插件包」要求让步（允许跨包复用既有数据面/表单件） |
| D3 | 首启判定与跳过语义 | 无标记则弹；走完或跳过即写标记（localStorage 单键）；重播随时可进 |
| D4 | 第 5 步是否独立 | **独立成步**（只做概念地图，不写说明书） |
| D5 | 未配模型就跳过的处理 | **弹一次确认**；确认后不再管 |
| D6 | 重播入口位置 | **左下角活动栏「更多」菜单**，不放设置面板 |

### 遗留风险与开放项

- **R1 表单双份漂移**：缓解 = §4.3 共用件抽取；若不做则须人工同步（文档标注债务）。
- **R2 user config 的 `virtual` 键**：实施批 1 第一件事核实（§2.5）；若缺失，需在编辑编排里显式收窄而非依赖后端。
- **R3 首启触发时序**：必须等 boot graph 装载就绪（`__agentchatBootReady`），否则与 splash 抢首帧或席位未注册。
- **R4 多端标记独立**：桌面端与远端 App 各自一份 localStorage，会各弹一次（已接受）。
- **R5 建 Agent 后的列表刷新**：依赖既有 `agents/updated` 帧贯通，批 4 验证。
- **R6 引导内容迭代**：`version` 字段已预留，但"内容更新是否重弹"保持人工决策（默认不重弹）。
- **R7 能力标签默认集**：默认勾选哪些标签需按出厂最小可用集定稿（批 3 定）。

---

## 七、验收清单

- [ ] 首启（无 localStorage 键）自动弹向导；有键不弹。
- [ ] 五步都可单独跳到（点步骤条）；`上一步/下一步/完成` 边界正确。
- [ ] 第 1 步保存后 user 的昵称/头像在会话气泡与活动栏即时可见。
- [ ] 第 2 步保存后 `config.json` 出现对应 provider 条目、`api_key` 进凭据库（不在 config.json 明文）、设为默认生效。
- [ ] 第 3 步保存后 `searchProviders` 域出现条目。
- [ ] 第 4 步创建后左侧 Agent 列表出现新 Agent，模型引用正确。
- [ ] 未配模型时点跳过 → 弹确认；`仍然跳过` 后不再拦；已配模型时不弹。
- [ ] 更多菜单出现「新手引导」；重播可重进且重置到第 1 步。
- [ ] 卸载引导行（从 yml/TREE 摘除）→ 菜单项消失、不再弹、其余行零改动。
- [ ] ≤768px 全屏形态正常；双主题（Nebula/Aurora）均过目。
- [ ] 验证阶梯全绿（见 §五各批）。

---

## 八、参考

- 原型：`sandbox/onboarding-prototype/index.html`（自包含，含评估工具条：双主题切换 / 设计说明开关 / 假装已配好模型 / 重播）+ `sandbox/onboarding-prototype/serve.mjs`。
- 行形态样例：`src/ac-client-ui-todo`（最小行）、`src/ac-client-ui-singles`（含行间 inject）。
- 席位账本：`src/docs/ui-rows-and-slots.md`（行/席对照事实源）、`src/docs/m30-slot-semantics-refinement-plan.md`（elect/data 轴裁决）。
- 落点相关：`src/ac-client-ui-settings/client/sectionTree.ts`、`src/ac-client-ui-layout/client/uiStore.ts`、`src/ac-client-ui-layout/client/ActivityBar.vue`。
- 数据面：`src/ac-client-ui-llm-pool/client/poolApi.ts`、`src/ac-client-ui-search-pool/client/searchPoolApi.ts`、`src/ac-client-ui-agents/client/rosterApi.ts`、`src/ac-client-ui-settings/client/api.ts`。
- 池加固背景：`src/docs/llm-pool-hardening-cr99.md`、cr-21（防覆盖守门）。
