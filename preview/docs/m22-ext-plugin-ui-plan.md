# M22 设计稿：扩展与工具 / 插件库 cordis 原生化（ExtToolsPane + PluginLibraryPane）

> 状态：**P1+P2 已实施（2026-08-28）**；P3 注册制目录另立项未实施。生成于
> M21 收官后（2026-08），基于两轮代码勘探（前端组件 → useSettings → api.ts
> 适配层 → 后端 RPC → 服务/纯库全链路）。
> 背景：M17 平移采取"保留 src 契约形状、`api.ts` 适配层仿真"策略换取组件零改写；
> cordis 化后三组 src 概念无对应物，靠仿真在撑，其中一处已是活性 bug。
> 本文档给出目标设计、契约形状与分批迁移步骤。**D1 已经用户裁决**，其余裁决点
> 带推荐值，实施前可复议。
>
> **实施记录（P1+P2）**：B1-B11 全部核销；D2/D3/D4(P2a)/D5/D6/D7/D8 按推荐落地。
> 新增 RPC：`plugin/extension-catalog`（扩展目录 ∩ registry）、`plugin/dev-scan`
> （owner 布局扫描 + 数据根透出）、`plugin/loaded` 附 `failed[]`；
> `agents/assembly/update` hooks 改 per-name 浅合并 / null 删除（发现并修复
> computeDiff 检测不到键删除导致 null 删除不落盘的缺陷）；前端
> ExtToolsPane 重构为「装配」页（扩展|工具 两分区 + 落点徽章 + 参数弹窗编辑
> hooks[名].*），PluginLibraryPane 四页签（装配行/已安装+装载徽章/待审/开发与会话），
> 设置树删 extTools 叶子，api.ts 适配层（PREVIEW_HOOK_CATALOG/hookOrderOf/
> hooksPatchOf/adaptAssembly）整体退场。

---

## 一、问题盘点

### 1.1 概念错位总表（cordis 化后的根本错位）

| src 概念 | cordis/preview 真实形态 | 当前 UI 现状 | 性质 |
|---|---|---|---|
| 插件 per-Agent 启停（presets） | 三层分工：**yml=出厂态、registry.json=安装态、hooks[具名]=启用表达**；per-Agent 只有软停用+参数+工具意图（ADR-4 显式缩水） | agent 模式插件开关写 `raw.presets`，但 `api.saveAssembly` 只转发 tools/hooks（`api.ts:178-181`），保存后 `syncRawFromAssembly` 重置回 `[]`（`useSettings.ts:276-287`） | **活性 bug B1**：勾选→dirty→保存→开关静默回退 |
| hooks 注册中心（7 kinds） | 事件族：`before-*`（决策）→ 主体 → `transform-*`（塑造）→ `after-*`（通知）waterfall + emit；"钩子"实体变成"消费事件的扩展行" | 前端硬编码 `PREVIEW_HOOK_CATALOG` 11 条（`api.ts:48-60`）；9 分区导航中 5 个恒空（stepStart/stepEnd/fallback/toolExecutionEnd 无条目） | 适配债 B9：词汇表住前端，新增扩展行要改前端代码 |
| 中心化 schema/目录元数据 | 契约归属 owning package；目录应随行装载/卸载增删 | 目录、hooks 参数面归集全在前端 | 架构债（B9 同源） |
| 钩子清单顺序 = 执行顺序 | waterfall 执行序 = 监听器注册序，**不可配置**；`hooks[具名]` 是配置对象不是有序清单 | 拖拽排序 + "按推荐顺序排序"在编辑一个**无消费者的人工顺序**（`ExtToolsPane.vue:344-366`） | 死语义 B10 |

### 1.2 活性缺陷清单（实施时逐项核销）

| # | 缺陷 | 位置 | 一句话 |
|---|---|---|---|
| B1 | 插件开关保存静默回退 | `api.ts:176-184` + `useSettings.ts:276-287` | presets 被 saveAssembly 丢弃后基线重置 |
| B2 | 会话装载 owner 归属丢失 | 前端发 `owner`（`api.ts:380`）vs 后端读 `agentId`（`ac-web-api/src/index.ts:932`） | 字段名错配，plugin/load 的 agentId 永远为空 |
| B3 | `getSessionPlugins` 不过滤 `sessionOnly` | `api.ts:361-372` | 已安装且已装载的插件被误标"会话已加载"（dev 页签恒空所以暂不可见，补 dev 面后变真 bug） |
| B4 | dev 页签恒空 + 路径提示虚构 | `SettingsPanel.vue:435` 过滤 `source==='dev'`，但 `getCatalog` 无 dev 源（`api.ts:222-289`）；src 有 `scanDevPlugins`（`src/boot/boot/src/loader.ts:740-769`）preview 未平移 | 提示 `<workspace>/plugins/<agentId>/<name>/` 与实际数据根 `<AGENTCHAT_DATA_ROOT>/plugins/`（boot 锚 cwd，`ac-app/src/boot.ts:20-21`）不符 |
| B5 | 市场页签是抛错桩 | `api.ts:341-357` | "preview 轨道暂无插件市场" |
| B6 | 文案失真 | `PluginLibraryPane.vue:96`（"已加入 owner Agent 的 presets 自动生效"——preview 无此机制，工具进全局注册表）、`:41`（卸载确认提 presets 引用） | src 遗留语义 |
| B7 | legacy 通道死代码 | `useSettings.ts:46-71`（assemblyOf legacy 分支）、`AgentPane.vue:95/552-554`（迁移横幅）、`AssemblyView.legacy` | preview 无旧盘数据 |
| B8 | hooks 保存 read-modify-write 丢失更新窗口 | `api.ts:176-184`：先 GET 折叠 enabled 位再全量 PUT，与并发 WS 热重载有竞态 | 合并语义应下沉服务端 |
| B9 | 扩展目录/词汇表前端硬编码 | `api.ts:33-95` | 见 1.1 |
| B10 | 钩子顺序编辑无消费者 | `ExtToolsPane.vue:235-259/344-366` | 见 1.1 |
| B11 | 装载失败结果只进日志 | `ac-plugin-registry/src/index.ts:105-111`（loadInstalled outcomes 仅 logger.warn） | 前端无从展示"已安装但装载失败" |

---

## 二、设计原则（对齐 cordis 三层）

1. **单元重定义**：UI 的"扩展"单元 = 消费事件的**扩展行**（ac-persona/ac-memory/…），
   不是 src 的 hook 注册条目。per-Agent 控制只有三件事：软停用
   （`hooks['<名>'].enabled=false`）、参数（`hooks['<名>'].*`）、工具意图
   （`tools.include/exclude`）。进程级启停 = 行组合（yml/registry），UI 不重复表达。
2. **词汇换轨**：7 hook kinds → **事件落点**三组徽章：
   运行前（`loop/before-run`）/ 工具链（`tool/before-execute`·`tool/transform-result`）/
   运行后（`loop/transform-run`·`loop/after-run`）。
3. **目录回 owning 方**：前端零词汇表。目录条目与进程实际装载的行联动
   （行摘除 → 条目隐藏）。

---

## 三、目标设计

### 3.1 信息架构（D1 已裁决：全局叶子并入插件库）

设置树：`extTools` 叶子**删除**；`pluginLibrary` 保留，四页签：

```
设置树                                    插件库（pluginLibrary）
├─ Agent 设置                             ┌─[装配行]── 行清单 + 工具目录 + 扩展目录（只读）+ 默认参数入口
├─ 模型管理                               ├─[已安装]── PluginCard + 装载状态徽章
├─ 搜索引擎                               ├─[待审暂存] 人审流（原样不动）
├─ 插件库 ◄─ 承接原全局目录               └─[开发与会话] dev 扫描卡片 + 手动注册表单
├─ 定时任务
└─ …
```

AgentPane 第 5 页签改名「**装配**」（原"扩展与工具"），只做 per-Agent 编辑。

论据：全局"启用/停用"在 cordis 是行组合（编辑 cordis.yml + 重启），UI 无法也不应
表达——现状全局页横幅"启用/停用在各 Agent 面板"已承认此点，剩下的只读目录价值
（plugin/rows 自带 fibers/active/origin，天然运行时诊断视图）并入插件库更内聚。

### 3.2 AgentPane「装配」页签（原 ExtToolsPane agent 模式）

```
┌─ 左导航 ──┬─ 右主区 ─────────────────────────────────┐
│ 扩展 (11) │ [搜索________]                            │
│ 工具 (31) │ ┌──────────────────────────────────────┐ │
│           │ │ 人设注入 persona        [运行前]      │ │
│           │ │ AGENT.md / persona 文本角色块前置注入 │ │
│           │ │ 参数：file/text…           [开关 ●]  │ │
│           │ └──────────────────────────────────────┘ │
│           │ ── 基础设施行（装载即生效，不可关）─────  │
│           │ │ MCP 工具发现 mcp   [运行前][auto]     │ │
│           │ │ Token 用量记录 usage [运行后][auto]   │ │
```

- 导航收敛为 **扩展 | 工具** 两分区（删 7 hook-kind 导航；落点做徽章不做分区）。
- 扩展行卡片：label/description/落点徽章/参数入口（弹窗编辑 `hooks['名'].*`，
  schema 由目录条目声明）；开关写 `enabled`；automatic 行单独成区不可关。
- **插件开关退场**（D2）：动态装载插件改只读徽章（"已装载/会话级"，点击跳插件库）；
  删 `togglePlugin` 与 presets 修剪联动（`ExtToolsPane.vue:141-167`）。
- **顺序编辑退场**（D3）：删拖拽排序与"按推荐顺序排序"（事件执行序=注册序）。
- 工具分区语义不变：三态徽章（默认/显式/停用）+ include/exclude + requires 标签门禁。

### 3.3 插件库页签细节

| 页签 | 内容 |
|---|---|
| 装配行 | `plugin/rows` 行卡片（name/origin/version/description/fibers/active）+ 工具目录（`tools/list` 只读）+ 扩展目录（3.4 目录面只读 + 全局默认参数弹窗，承接原 NsFieldList 入口） |
| 已安装 | PluginCard + **装载徽章**：已装载 / 未装载 / **装载失败（附原因）**（D6） |
| 待审暂存 | 原样（stage→人审→approve 是标杆流程，不动） |
| 开发与会话 | **dev 扫描**卡片（PluginDevCard：注册会话[grants 弹窗]/卸载会话/发布 stage）+ **手动注册表单**（dir/owner/grants/watch → `plugin/load sessionOnly`）；路径提示改为 `<数据根>/plugins/<agentId>/<name>/`（数据根经 RPC 透出） |

### 3.4 契约形状（新增/变更）

**① 目录面（D4，P2a 静态起步）** —— 新 RPC `plugin/extension-catalog`：

```ts
interface ExtensionCatalogEntry {
  /** AgentConfig.hooks 键（persona/memory/…；动态插件 = manifest.name） */
  name: string;
  /** 装配行包名；可见性 = row ∈ plugin/rows（行摘除 → 条目自动隐藏） */
  row: string;
  label: string;
  description: string;
  /** 事件落点（preview 事件词汇；UI 映射三组徽章） */
  targets: Array<'loop/before-run' | 'tool/before-execute' | 'tool/transform-result'
    | 'loop/transform-run' | 'loop/after-run'>;
  /** 基础设施行：装载即生效，per-Agent 不可关 */
  automatic?: boolean;
  /** per-Agent 参数面：命名空间键 + 字段（P3 起由 owning 行注册 schema） */
  configNs?: string;
  fields?: string[];
}
```

首版条目 = 现 `PREVIEW_HOOK_CATALOG` 11 条迁移 + `row` 补齐（persona→ac-persona、
mcp→ac-mcp、session→ac-session、web-tools→ac-web-tools、archive→ac-archive、
usage→ac-usage、security→ac-security、skill→ac-skill、system-prompt→ac-system-prompt、
datetime→ac-datetime、memory→ac-memory）。落点修正两处：security =
`['tool/before-execute','tool/transform-result']`（门禁+脱敏双落点）；
web-tools = `[]`（工具行，能力供给非事件拦截）。常量住 ac-web-api；
**删除前端 `PREVIEW_HOOK_CATALOG`/`hookOrderOf`/`hooksPatchOf`/`adaptAssembly`**。

**② dev 扫描面（D7）** —— ac-plugin-registry 加 `listDev()`（plugins/ 目录归它，
owning service 规约）+ RPC `plugin/dev-scan`：

```ts
interface DevPluginInfo { name: string; version?: string; description?: string;
  owner: string; dir: string; permissions?: string[] }
```

扫描算法（src `scanDevPlugins` 适配 preview 数据根与平铺安装目录共存）：
遍历 `<root>/plugins/` 一层——跳过 `.staging`/`.backup`/`.market`/`registry.json`
与**直接含 manifest.json 的平铺目录**（= 已安装插件）；其余视为 owner 目录，再扫
其下一层子目录的 manifest.json（损坏跳过不阻断），owner=目录名。

**③ 装载状态透出（D6）** —— `plugin/loaded` 响应增 `failed: Array<{name, error}>`：
registry 行内记录 boot 扫描 rejected outcome（内存态，不写 registry.json——安装态
不混运行态），前端与 `plugin/installed` 交叉出三态徽章。

**④ assembly 写口合并语义（D5）** —— `agents/assembly/update` 的
`patch.hooks: Record<name, object | null>`：

- `object` = **per-name 浅合并**进既有 `hooks[name]`（`{enabled:false}` 只动 enabled，
  既有 maxTokens/whitelist 等字段不动）；
- `null` = 删除该 name 配置；
- `patch.tools` 不变（`{include?, exclude?}`，全空意图=恢复缺省）。

前端 `api.saveAssembly` 随之删除 read-modify-write（B8 消除）。

**⑤ 会话装载参数修正（P1）**：`registerSessionPlugin` 发 `agentId`（对齐后端
`plugin/load` 读法，B2 消除）。

### 3.5 前端状态与 api.ts 收编

- `useSettings`：`pluginCatalog` 数据源 = `plugin/extension-catalog` × `plugin/rows`
  （交集）+ `plugin/loaded` + `plugin/installed` + `tools/list`；`pluginLibrary` =
  `plugin/installed` + `plugin/staging-list` + `plugin/dev-scan`；`sessionPlugins` =
  `plugin/loaded` 过滤 `sessionOnly`。
- api.ts 适配层（adaptAssembly/hookOrderOf/hooksPatchOf/PREVIEW_HOOK_CATALOG/
  PREVIEW legacy 分支）整体退场，前端直消费 preview 形状；`AssemblyView`/
  `HookInfo`/`HookKind` 等 src 形状类型从消费面移除（shims 仅保留仍被引用者）。
- WS 刷新词汇不变（`plugin/*` + `agents/updated` → `refreshAssembly`，含
  dirty 保护逻辑原样保留）。

---

## 四、裁决点

| # | 裁决 | 状态 |
|---|---|---|
| D1 | 全局「扩展与工具」叶子去向 | **已裁决：并入插件库「装配行」页签** |
| D2 | agent 模式插件开关 | 推荐：改只读徽章（ADR-4 诚实表达；替代方案=整区移除） |
| D3 | 钩子拖拽排序/推荐排序按钮 | 推荐：删除（无消费者的死语义） |
| D4 | 目录后端化路径 | 推荐：P2a 静态常量+rows 交集（天级）→ P3 注册制（另立项） |
| D5 | hooks 写口 | 推荐：服务端 per-name 合并 + null 删除 |
| D6 | 装载失败透出 | 推荐：`plugin/loaded` 增 `failed[]`（内存态，不污染 registry.json） |
| D7 | dev 扫描归属 | 推荐：ac-plugin-registry `listDev()`（plugins/ 目录 owning） |
| D8 | 市场页签 | 推荐：摘除（api 桩一并删），ac-plugin-market（M14+ 延后）落地再恢复 |

---

## 五、迁移步骤（分批，每批独立可验收）

验收命令统一：`pnpm --filter ac-webui-app typecheck` +
`pnpm exec vitest run preview/webui/tests` +（涉后端时）`pnpm preview:typecheck &&
pnpm preview:test` + `pnpm preview:smoke` / boot 手测该批功能。

### P1 止血（纯前端，半天级）

1. B1：ExtToolsPane agent 模式插件开关 → 只读徽章；删 `togglePlugin` 与 presets
   修剪联动；`decl`/`patchDecl` 拆掉 presets 字段。
2. B7：删 legacy 通道（assemblyOf legacy 分支 / legacyReadonly 横幅 / 保存迁移段）。
3. B5+D8：摘市场页签，删 `api.ts` 四个桩函数。
4. B2：`registerSessionPlugin` 参数 `owner`→`agentId`。
5. B3：`getSessionPlugins` 过滤 `sessionOnly === true`。
6. B4/B6：dev 空态文案改"扫描面随 M22 P2 提供"；会话注册/卸载确认文案去 presets 语义。

### P2 原生化（前后端，1-2 天级）

1. D4①：后端 `EXTENSION_CATALOG` 常量 + `plugin/extension-catalog` RPC（rows 交集）；
   前端删 `PREVIEW_HOOK_CATALOG`，ExtToolsPane 导航收敛两分区 + 落点徽章 +
   删拖拽/排序（D3）。
2. D5④：`updateAssembly` hooks 合并语义 + 前端 `saveAssembly` 去 RMW（同步唯一
   调用方 webui + ac-agent-admin 测试更新）。
3. D7②：`listDev()` + `plugin/dev-scan` + PluginDevCard 接线 + 数据根透出与提示修正。
4. D6③：registry 行记录 boot 装载失败 + `plugin/loaded` 增 `failed[]` + 已安装卡片
   装载徽章。
5. D1：设置树删 `extTools` 叶子；PluginLibraryPane 增「装配行」页签（承接原全局
   只读目录 + NsFieldList 默认参数弹窗）；AgentPane 页签改名「装配」。

### P3 注册制目录（另立项，不阻塞）

- 扩展行 `apply` 时注册目录元数据（照 `ToolsService.register` 注册即归属形态）；
  动态插件经 manifest 声明进同一管道；目录随行装载/卸载自动增删（消灭静态表
  "新增要改常量"的最后漂移面）。
- 可选：已安装卡片"提供 UI 页签"徽章 ↔ settings-tab slot 跳转联动
  （`webui/extensions-changed` 已有事件面）。

---

## 六、显式缩水与风险记录（对齐 M17 勘误风格）

**缩水**（src 概念在 preview 无对应，不恢复）：

1. 7 hook-kind 导航 → 两分区（5 个分区恒空，词汇属 src 注册中心）。
2. 钩子清单顺序编辑 → 删除（事件执行序=注册序，不可配置）。
3. per-Agent 插件启停开关 → 只读徽章（ADR-4 重申）。
4. 市场页签 → 摘除（market/source.ts 未平移，M14+ 延后）。
5. legacy plugins 契约迁移 → 删除（preview 无旧盘）。

**风险与对策**：

- **双轨分叉加深**：preview/webui 弃 src 契约形状后与旧轨 UI 代码彻底分叉——
  已是既成事实（独立副本），接受并记录。
- **静态目录行名漂移**：P2a 靠 plugin/rows 交集兜底——行名写错 = 条目隐藏，
  boot 手测自暴露；P3 注册制根治。
- **updateAssembly 合并语义变更**：唯一调用方是 webui，同批改齐；ac-agent-admin
  测试补合并/null 删除用例。
- **AgentPane 装配页签表面积变化**：P2 后逐 Agent boot 手测（开关持久化、参数
  保留、工具三态）。

---

## 七、事实源索引

| 内容 | 文件 |
|---|---|
| 现状勘探（本轮两轮链路） | `webui/src/settings/{api.ts,useSettings.ts,types.ts}` + `components/{ExtToolsPane,PluginLibraryPane,PluginCard,PluginDevCard,StagingReviewModal,AgentPane,SettingsPanel}.vue` |
| 后端面 | `ac-web-api/src/index.ts`（plugin/* RPC + plugin/rows）、`ac-agent-admin/src/{index,service}.ts`（assembly）、`ac-plugin-registry/src/{service,index}.ts`、`ac-plugin-gates/src/index.ts`、`ac-plugin-core/src/store.ts` |
| 三层分工 / ADR-4 / 事件模式 | `docs/src-to-preview-map.md`、`README.md` 设计铁律节 |
| M17 平移策略与勘误 #5/#7（本设计继承其决策） | `docs/m17-ui-parity-plan.md` |
| src 对照（scanDevPlugins / getCatalog 四源） | `src/boot/boot/src/loader.ts:739-840` |
