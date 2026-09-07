# M27 · WebUI 纯 Slot 重构计划（root 即 slot）

| 项 | 说明 |
|---|---|
| 状态 | **实施中**。**S0 已实施**（2026-11）：基建三包之二落地——`src/ac-client-slots`（SlotCore 纯核，14 单测）+ `src/ac-client-runtime`（ClientContext 类型身份/SlotRegistry/对象层骨架/useContext/wrapComponent，14 单测含 D22 查重锁定）+ webui `runtime/vueRenderer.ts`·`slotRender.ts`、`components/SlotOutlet.vue`·`SlotOutletItem.ts`（12 单测）+ `?slots-demo` demo 页（含 mount 级 jsdom 测试）；验收全绿（typecheck×2 / 全量 1427 测试 / check:deps / webui:build 出独立 slots-demo chunk）。开工前 DSH 复查：本机 0.1.2-rc.1 为 bundled 安装无源可读，并包动机（循环依赖/行政成本）不适用本仓，两包拆分维持。**S1 已实施**（2026-11）：D23-B 视觉基线先行（22 张 × 零像素纪律，独立提交）→ main.ts 装配序列（①-⑥）+ App.vue→`clients/base/layout.ts`（AppFrame 占 root + 四 seat + main:perspective + sidebar:plugin-actions，DOM/样式原样迁入）+ slots.ts 三件挂载点与三注册表声明面改经 SlotRegistry（D13 六别名双轨，hostLedger 声明账本）+ D18 门控三件套（bail/fields/redirectTo）+ D14 渲染基准 + 「卸载 layout → root 空且可诊断」验收测试；全量 1443 测试绿 + 视觉 diff 全绿（零像素差异）。**S1.5 已实施**（2026-11）：SlotMap 类型化（hostLedger/layout 各自 declare module 注入已实施声明集 + ownerProps 挂靠 slot-tree §5 横切契约：z-index 配额/移动端继承/四态回落/命令式通道/状态词汇宿主固定）+ cell/priority 选举（single shadow：tier[出厂恒胜]→priority→order→seq；chain=priority 消费序；list=order 轴不变）+ store 座位实例轴（SlotStoreAxis：acquireStore/release/dropScope——引用计数/会话死即清含持久化态）+ inject 面（声明存活期效应）+ onEntryError 监督与 abdicate 退位（EntryErrorBoundary 捕获→退位→次位接任）；D3 两代语义按裁决演进（封印后动态注册从「拒绝」升级为「tier 选举恒低优」，两代差异测试显式记录）；验收门全绿（五项单测 + 朴素语义锁定 + 全量 1463 测试 + 视觉 diff 零像素）。其余阶段开工前按里程碑惯例可再细化 |
| 版本 | v2.3——补视觉零回归双保险（D23：DOM/CSS 不变性纪律 + Playwright 视觉快照基线先行）。v2.2——按二次评审（review2 §6）修订：新增 D22（客户端 Context 类型身份与查重）、D13 补第三方声明开口策略、runview 域落点点名（D12/D19/S3）、owner props 契约挂靠 slot-tree §5 横切约定（D2/S1.5/S2）与四项精度修正。v2.1——v2 内容的版式重排与主题分组；决策编号（D0–D23）、阶段划分（S0–S4）与全部事实、裁决不变。v2 系按复核报告 §7 修订清单全量改写（要点见 §6） |

**输入与依据**：

- `webui-slot-tree.md` —— 约 240 插口的 slot 树 = slot 声明集；
- `webui-plugin-ownership.md` v2 —— 对齐 DSH 的归属地图；
- `webui-koishi-console-research.md` —— Koishi Console 源码研究（root 即 slot 的成熟生态实证）；
- `m27-webui-slot-refactor-plan-review.md` —— 复核报告，v2 的修订依据；
- `m27-webui-slot-refactor-plan-review2.md` —— 二次评审（对 v2.1），v2.2 的修订依据。

> **参照系注记（S0 开工前复查）**：计划所引 DSH 实证原为 0.1.1-rc.2；
> 当前本机已 0.1.2-rc.1，其中 `dsh-client-runtime`（SlotRegistry +
> SessionRuntime）与 `dsh-client-ui-slots`（SlotCore 纯核）**两包已并入
> `dsh-client-ui-renderer` / `dsh-cordis-client-runner`**。本计划的
> `ac-client-slots` / `ac-client-runtime` 两包拆分暂维持（纯核零 cordis
> 依赖、可独立单测是本仓自己的纪律）；S0 开工前复查 DSH 新形态一次——
> 若其并包动机（循环依赖/行政成本）适用于本仓则并包重裁。Koishi 侧
> 参照稳定。

### 术语速查

| 术语 | 含义 |
|---|---|
| 基建三包 | `ac-client-slots`（SlotCore 纯核）/ `ac-client-runtime`（SlotRegistry + 运行时胶水）/ `@agentchat/webui-kit`（设计原语 + tokens）——是运行时，不是行附属 |
| 基础七件 | layout / conversation / renderer / tool / sidebar / theme / settings——随 webui 分发的默认插件集合（D11） |
| 域插件 | 承载单个业务域 UI 的插件；物理落点 = 该域后端行包内 `client/` 目录（D19） |
| 行包 client/ 半边 | D19 裁决的域 UI 物理形态：不独立成包、不独立成行，与后端能力同生共死 |
| seat（席位） | 占用者组件内声明的具名渲染位，经 `<SlotOutlet key>` 渲染 |
| store 座位 | slot 条目上的状态工厂：per-entry handle × scope key 实例化 / 引用计数 / 会话死即清（D2） |
| boot graph | 宿主下发的装载清单（哪些行 + 各行 client 半边）；dev 期 vite 直服源码，生产期按 graph 编译 dist 模块块（D7） |
| 桥（bridge） | 旧注册面（8 个 UISlotId、三注册表、第三方 manifest）到新 slot 注册表的转发层（D13） |
| ClientContext | ac-client-runtime 导出的客户端 Context 类型身份；客户端服务与 SlotMap 的声明合并目标（不 augment '@agentchat/cordis'，防与服务端服务名撞型，D22） |
| 公开子集 | 第三方 manifest 可声明的 slot 集合 = 声明账本中显式标 `public` 的子集（D13 开口策略） |

---

## 0. 终态架构

### 0.1 启动链（现状 → 终态）

- 现状：`main.ts`（24 行）= createApp(App) + pinia + mount——App.vue 是
  硬编码的组合根（直接 import 15 个组件 + 四视角注册 + 五弹窗挂载）。
- 终态：

```
main.ts（装配序列，无任何可视面知识）：
  ① 建 client runtime：浏览器端 cordis 实例 + SlotRegistry（ac-client-runtime）
  ② install(vueRenderer)            // boot-once，唯一渲染器安装口
  ③ 装配基础插件集合（七件，D11/D19：随 webui 分发的默认插件集合）
  ④ 按 boot graph 装配域插件          // 组合行装载交叉 × agentchat.client 清单（D7/D19）
  ⑤ 第三方 UI 插件 install(ctx)       // 既有 /ui-plugin/ 通道，桥接同一注册表（D8）
  ⑥ app.mount(renderSlot('root'))    // 唯一 ctx 级渲染入口
```

### 0.2 视图树即 slot 树

```
root（single，boot 种子席位）
└─ OCCUPIED by layout 插件 · AppFrame（原 App.vue 骨架）
   ├─ seat: sidebar        ← sidebar/theme 及各域入口钮（sidebar:* 全系）
   ├─ seat: list-panel     ← 三面板壳 + roster/session-list/runs 域贡献
   ├─ seat: main           ← main:perspective（视角专座）→ chat/pair/runview 域贡献
   │                          → chat:* / turn:* / message:* / tool-card:* 逐层嵌套 seat
   └─ seat: overlay        ← 全局弹窗与各域覆盖层（list、additive、点击穿透
                              直至条目声明接管）
```

规则：

- 一切 seat 由占用者在其组件内经 `<SlotOutlet key>` 渲染；
- 红线：**跨域视图组件直接 import**——域间只经 slot 贡献、inject 声明、
  服务面数据；
- 「壳也是插件」的确切含义（D19）：基础七件与域插件走**同一条 slot
  轨道**（同注册面、同选举语义、可被 shadow），只是随 webui 构建分发、
  不单独成行。

### 0.3 数据层分权（store 归属与访问规则）

UI 按 slot 分，数据按**三层**分。判据与 UI 归属同源：数据面归属 +
跨域聚落下沉 + 可摘除性。DSH 参照：SessionRuntime（scope tree +
object layer + contract 类型）与 SlotRegistry 的 store 实例轴。

**层 1 · 视图状态 → 壳插件私有**

- 布局开合 / 宽度 / 选中 / 主题归基础七件自有（DSH 同款：ui-layout 的
  `ctx.layout` viewing-state 服务）。
- 不跨插件暴露 store 本体；他件要影响布局走壳服务方法 / 事件。

**层 2 · 跨切只读对象层 → ac-client-runtime**

- 多个基础件都要读的身份面（名册 agents/presets、会话索引、工作区
  清单）住运行时对象层，由 `webui/src/api/` 目录各远程模块 +
  `core/api/client.ts` 喂养（重构后经 runtime 喂养）、客户端服务面
  暴露（`ctx.roster` 等）；域插件与基础件一律 inject 消费。
- 管理 / 写面仍归域插件。

**层 3 · 域投影 → 域插件私有**

- 域插件在自己 fiber 里订阅**自己域**的 ws 帧 + RPC 拉取、维护投影，
  对外两态暴露：
  - 跨域消费 → 客户端服务 `ctx.<domain>`（inject 声明——服务端
    「能力调用 → Service 方法」的同构）；
  - 会话作用域 UI 态 → slot store 座位（per-entry handle × scope key
    实例化 / 引用计数；贡献卸载或会话死即回收，持久化态随清）。

**红线**：

- 不 import 他域 store 模块（= 跨插件传引用）；
- 不重复订阅他域帧——现状 feed/chat/jobs 各自解析帧的重复就此消灭；
- 域投影不挂全局 pinia（隐式单例 + 卸载残留）。

pinia 的去留：保留为基础件内部实现细节；域插件用 store 座位 / 服务内
reactive，不强推全退。

**现状 10 store 归属表**：

| 现状 store | 归属 | 暴露面 |
|---|---|---|
| ui.ts | layout（基础件） | ctx.layout（私有，方法面） |
| theme.ts | theme（基础件） | ctx.theme |
| agents.ts | 读面→runtime 对象层；管理写面→agents 域 | ctx.roster（inject） |
| workspaces.ts | 读面→runtime；管理→workspace 域 | ctx.workspaces |
| feed.ts（79KB） | conversation（基础件）：per-dialog 分区=scope 树（key=conversationId）、turn 装配/历史分页=投影管线；群/pair 归一经贡献者注入管线 | ctx.sessions 会话服务 + store 座位 |
| chat.ts（40KB） | 拆解：发送/中断/排队→conversation 服务；interaction 段→interaction 域；compress 反馈→archive/session 域 | 方法面 |
| groups.ts | group 域 | ctx.groups |
| singles.ts | singles 域 | ctx.singles |
| jobs.ts | jobs 域 | ctx.jobs |
| runs.ts | runview 域（无后端行；S3 首个 client-only 行 `ac-client-runview`，D19/D12） | ctx.runs（矩阵轴从 ctx.roster 取） |

**访问规则速查**：同域直用；跨域读走 inject 服务面或 seat owner props；
跨域写走服务方法；帧订阅「谁的数据谁订」。

## 1. 设计决策（D0–D22）

编号是稳定接口（外部文档按编号引用），本次重排未改号；按主题分七组，
组内按依赖与修订顺序排列。三处修订关系以组内后出条目为准：**D19 改裁
D0 的域 UI 落点**、**D15 细化 D1 的类型化时序**、**D16 细化 D2/D4 的
Outlet 语义**。

**决策索引**：

| 编号 | 裁决 | 落点 |
|---|---|---|
| D0 | 基建三包独立；域 UI 不设新包 | S0 建包 |
| D19 | 域 UI 落行包 `client/`，不建 ac-client-ui-* 包族、不新增组合行 | S3 迁移；S4 定基础件落点 |
| D11 | 基础七件 = 随 webui 分发的默认插件集合 | S1 起步；S4 定物理落点 |
| D21 | isolated-runtime / preview-main / desktop 壳归属 | S3/S4 验收 |
| D1 | SlotMap 声明合并取代封闭 UISlotId（分两步） | S0 账本；S1.5 类型化 |
| D2 | slot 终态形状：kind/scope、cell+priority 选举、store 座位；owner props 契约吸收 slot-tree §5 横切约定 | S1.5 |
| D15 | 首版朴素形态；API 签名按终态形状占位 | S0；S1.5 实装 |
| D3 | root 单席位纪律：出厂占据、动态者恒低优、误占即拒 | S0 校验；S1 占据 |
| D16 | Outlet 内外同轴 order + single fallback + data 透传 | S0；S1.5 衔接 |
| D6 | 依赖一律 inject 声明，不用行序/时序 | S1.5；S2 |
| D4 | Vue 渲染适配：install(renderer) + SlotOutlet | S0 |
| D5 | 客户端 cordis；注册进 caller fiber，卸载级联回收 | S0 |
| D17 | 组件级 fiber 生命周期：useContext / wrapComponent | S0 |
| D22 | 客户端 Context 类型身份（ClientContext；声明合并目标=ac-client-runtime/-slots，不碰 '@agentchat/cordis'）+ 服务名查重 | S0 定身份；S0 验收查重 |
| D23 | 视觉零回归双保险：DOM/CSS 不变性纪律（Outlet 零包裹节点 + 迁移期选择器审计）+ Playwright 视觉快照基线先行 | 基线 S1 前置；逐阶段 diff |
| D7 | 行包 client/ + agentchat.client 清单 + boot graph | S3 |
| D8 | 第三方通道收窄：组件六项转 slot，非视觉缝不走 slot | S3 |
| D10 | store 座位与 pinia 共存（三层分权细则 §0.3） | S1.5；S2 |
| D20 | 线帧转 ctx.emit + 聚合推送互补；断线混合策略 | S2 起随域拆解 |
| D13 | 旧 8 UISlotId 永久别名归一；内部旧注册面退役 | S1 双轨；S3 固化 |
| D9 | 三注册表收编为 keyed seat | S2 |
| D18 | 门控三件套：bail / fields / 卸载导航 | S1 |
| D14 | 性能基准 S1 建立；manualChunks 预拆；HMR 后置 | S1 起逐阶段 |
| D12 | 域拆解顺序：数据面单一者优先 | S2 |

### 1.1 包形态与物理落点（D0 · D19 · D11 · D21）

#### D0 · 命名空间与包形态总则

- 浏览器侧基建三包独立：`ac-client-slots`（SlotCore 纯核）、
  `ac-client-runtime`（SlotRegistry + 运行时胶水）、
  `@agentchat/webui-kit`（设计原语 + tokens）。
- **域 UI 不设新包**——落各后端行包内 `client/` 目录（D19）。
- 与宿主行包 `ac-webui*`（传输 / 托管职责）区分。

#### D19 · 包形态裁决（贯穿性决策，复核报告 §3.1 的落实）

**域 UI 落行包内 `client/` 目录；不建 `ac-client-ui-*` 包族、不新增
组合行。**推论与边界：

- **摘除语义**：卸载域行 = 后端能力 + 前端消费面一并消失（D7）；
  不存在「只摘 UI 不摘后端」的独立单元——若确需独立摘除，再为该域
  单开 client-only 行，两形态并存（清单机制不区分）。**首例 =
  runview**（运行矩阵域，无后端行，二次评审 §4.3）：S3 迁移时开
  `ac-client-runview` client-only 行（host 侧薄 apply 不注册服务，
  payload 即 client 半边）。
- **基础七件**：非行附属（无后端行），按 D11 为随 webui 分发的默认
  插件集合；物理落点 S4 复核定案（webui 内 `clients/base/` 常驻 vs
  独立 `ac-client-app` 单包）。
- **基建三包**独立维持——它们是运行时，不是行附属。
- **纯库行**（无 host 侧运行时的）如需 UI，同法在包内加 `client/`
  目录。

#### D11 · 基础插件集合（七件）

- 成员：`layout / conversation / renderer / tool / sidebar / theme /
  settings`（资产清单 = ownership §3.2）。
- 形态 = **随 webui 分发的默认插件集合**（Koishi 同款：其基础 app
  住在 client 库包内 `app/` 目录）：与域插件同一条 slot 轨道、同选举
  语义、可被 shadow / 覆盖，但**不单独成行、不设后端行**。
- S1/S2 期以 in-bundle 插件模块形态存在；物理落点（webui 内
  `clients/base/` 常驻 vs 独立 `ac-client-app` 单包）在 **S4 复核
  一次**定案（见 D19）。

#### D21 · 遗留入口与桌面壳归属

- `isolated-runtime.ts`（iframe 档运行时）随扩展宿主基建迁入
  `ac-client-runtime`。
- `preview-main.ts`（旧轨预览入口）留 webui 构建入口，作薄壳一部分。
- desktop 发布形态（经 extraResources 复制 dist + loadURL 3830）纳入
  S3/S4 验收（§4）。

### 1.2 Slot 模型与核心语义（D1 · D2 · D15 · D3 · D16 · D6）

#### D1 · SlotMap 开放声明合并取代封闭 `UISlotId`

- 每包 `declare module` 注入自己的 slot key + 类型；后端
  BUILTIN_SLOTS 静态表退役；fail-closed 改由声明账本 + 装载校验承担。
- **分两步**（D15）：S0/S1 期为 string key 运行时声明账本（对照
  slot-tree 文档即「声明集」）；SlotMap 类型化在 S1.5 增强门落地。
- 旧 8 个 UISlotId 走 D13 别名。

#### D2 · slot 形状（终态）

- `kind: 'single' | 'list' | 'chain'`；`scope: 'root' | 'session'`；
  owner props 类型化。
- **cell + priority 选举**：同 cell 高者 shadow 低者；chain 型逐条
  消费。
- **store 座位**：per-entry handle → factory，按 scope key 实例化 /
  引用计数 / 会话死即清。
- 语义映射（收编 slot 树四分类）：替换型 → single + cell；填充型 →
  list；装饰型 → 条目作用域的 list seat；覆盖型 → overlay seat 模式。
- **owner props 契约吸收 slot-tree §5 横切约定**（二次评审 §4.4）：
  z-index 配额（插件浮层禁自选高位，宿主按 seat 声明发配额）、替换型
  必须继承移动端行为（三面板左抽屉模式等——替换型最大隐性成本）、
  命令式通道保留（ask()/open()/定位参数）、启停两层分家不可绕开、
  四态回落、行点击导航宿主所有——逐 seat 声明落地，S1.5 类型化时随
  声明集承载。

#### D15 · SlotCore 分级起步 + 终态形状占位

- S0 首版 = Koishi 朴素形态：string key + order + single/list +
  disabled + 装载校验 + 卸载级联。
- 但 **API 签名从首版起按 D2 终态参数形状设计**——`cell` / `priority`
  / `store` / `children` 字段在注册面先占位（S0 不实现选举，S1.5
  实装），把后续演进收敛为**行为增强而非签名变更**。

#### D3 · root 单席位纪律

- root 被 layout 基础件出厂占据，且出厂者优先级最高（动态注册者恒
  低优，防误占打散框架）。
- 插件全屏自有面一律走 `overlay` seat（additive）。
- 写入 SlotCore 装载校验的显式报错文案。
- 时序注记（二次评审 §4.5-B）：S0/S1 朴素形态无 priority/cell，root
  防线 = 装载校验「非出厂注册一律拒绝」；「动态注册者恒低优」语义自
  S1.5 cell 选举生效（D15 占位字段届时实装）。

#### D16 · SlotOutlet 语义（Koishi 采纳）

- ① **内外同轴 order**：宿主模板内容（`<slot-outlet-item order>`）
  与插件贡献用同一 order 轴合并排序（宿主默认可被「排前 / 排后」而非
  只能整体替换）。
- ② **single 未填充回落 Vue 默认插槽**：宿主默认渲染免写 fallback
  分支。
- ③ `data` props 透传 owner 上下文。
- S1.5 后 single 的选举语义升级为 cell shadow；fallback 保留为
  「无任何贡献时」的最终回落。
- 分型说明（二次评审 §4.5-D）：同轴 order 合并对 **list / chain 型
  持续适用**；single 型 S1.5 后 = cell 选举 + 零贡献 fallback——宿主
  默认内容不再参与排序竞争，「排前 / 排后」对 single 不成立。

#### D6 · inject 表达依赖

- `inject(key, cb)` = 依赖 slot 声明存活期的效应（声明即回调、塌缩即
  回收）。
- UI 之间、配对注册（页签 + 面板、导航项 + 视图）一律 inject 声明，
  **不用行序、不用时序约定**。

### 1.3 渲染与客户端运行时（D4 · D5 · D17 · D22 · D23）

#### D4 · Vue 渲染适配（不换栈）

- `install(renderer)` boot-once 契约 + `<SlotOutlet key>` 组件（内部经
  registry 版本计数建立响应式，与现三注册表 `xxxVersion` 同款机制）。
- 组件树内 props 传 `renderSlot` face。

#### D5 · 客户端 cordis

- 直接复用 `src/vendor/cordis`（lib 零 node 内建依赖已验证；bin.js
  不进 bundle）。
- 注册经调用方 `ctx.effect` 路由进调用方 fiber——**插件卸载即级联
  回收其全部 slot 贡献**，与服务端 fiber 语义同构。
- SlotRegistry.register 必须保持 prototype 方法以绑定 caller ctx
  （DSH slots.d.ts 注释的坑原样规避）。
- 运行时复用与**类型身份**是两件裁决：客户端 Context 的类型身份与
  声明合并目标见 D22（S0 必须定案）。

#### D17 · 组件级 fiber 生命周期（Koishi 采纳）

- `useContext()` = 组件内 inject('cordis') → fork + 卸载即 dispose。
- 贡献组件 `wrapComponent` 注入隔离 ctx——组件树与 fiber 树对齐。

#### D22 · 客户端 Context 类型身份与服务命名纪律（二次评审 §4.1）

- **问题**：服务端 ac-jobs / ac-singles 等已经 `declare module
  '@agentchat/cordis'` 声明 `Context.jobs` / `Context.singles`（扁平
  命名空间）；客户端域投影若同名同目标 augment，同名异型 → TS2717
  声明合并冲突——S3 行包双半边同包后必然显形（client 半边自然
  import 同包 contract 类型，取代 webui 现行 shim 隔离模式）。
- **裁决**（备选三取 a）：ac-client-runtime 导出独立的客户端
  **`ClientContext`** 类型身份（extends vendor Context）；客户端
  服务与 SlotMap 的声明合并目标 = `'ac-client-runtime'` /
  `'ac-client-slots'` 模块，**不 augment `'@agentchat/cordis'`**。
  备选 b（ctx.ui.* 统一前缀）与 c（逐个更名避让）弃——撞名集会随
  两侧演进取交集增长。
- **查重纪律**：客户端服务名与服务端占名查重（服务端扁平命名空间
  纪律的客户端镜像）进 S0 验收与新增能力域 checklist。

#### D23 · 视觉零回归双保险（DOM/CSS 不变性 + 视觉快照基线）

「理论不变」到「机械保证」的两道防线。第一道是实现纪律，第二道是
机械检测——现状测试锁的是契约与行为（port-b/e2e/DOM 级），**没有
像素级视觉回归检测**，本决策补齐。

**A · DOM/CSS 不变性纪律**（样式不变的前提是 DOM 结构不变）：

- **SlotOutlet 零包裹节点**：渲染返回扁平 children 数组（Koishi KSlot
  同款），不引入任何包裹 DOM——scoped CSS、后代选择器、flex 布局
  上下文全部不受影响；确需包裹的场景（Transition/KeepAlive/作用域
  provide 壳）必须显式声明，且该包裹**计入快照基线**（结构差异可见）。
- **迁移期选择器审计**（每域拆解清单项）：①后代选择器父链依赖——
  迁移前 grep 出依赖宿主祖先类（`.app-layout .xxx` 等）的选择器
  清单，随域迁移逐一改写或保留等价锚类；②scoped 边界——贡献组件
  的 scoped 样式不得依赖宿主作用域属性，`:deep()` 使用面逐一核对；
  ③stacking context / z-index——Teleport 弹窗语境与嵌套层级变化
  的 z-index 审计（D2 配额契约的消费面）；④主题令牌——贡献组件
  只用 `--color-*`/`--role-*` 变量，不硬编码色值（slot-tree 既有
  纪律重申）。

**B · Playwright 视觉快照基线**（新增 devDependency，仓库现无）：

- **基线先行**：S1 动第一行代码**之前**对现状拍基线——先锁现状、
  再重构，顺序是本保险成立的前提。
- 基线集（深浅双主题 × 以下各面）：桌面三栏全貌、≤768px 移动端
  抽屉、设置弹窗（含插件库三页签）、消息流（含工具卡 / 思维链折叠 /
  dock 卡）、运行矩阵。
- 各阶段验收：快照 diff 全绿才过。**白名单**（允许的 diff，即计划内
  有意行为改进）：D19 域行卸载后消费面消失、D20 断线重放策略、boot
  graph 装载骨架期——白名单外任何像素差异即回归，阻断该阶段验收。
- 快照测试与 portb-e2e 复用同款「bootTree + 真 WS」测试环境形态，
  避免另起炉灶。

### 1.4 装载通道与清单（D7 · D8）

#### D7 · 装载通道与清单

- 域 UI 落在行包内 `client/` 目录；行 `package.json` 声明
  `"agentchat": { "client": { "platform": "web", "inject": [...] } }`
  清单 + `./client` 出口。
- **行卸载 → 不在 boot graph → 该域后端 + 前端消费面一并消失**
  （D19 形态下 UI 与后端能力同生共死，这是有意的语义：域行是可摘除
  单元）。
- `ac-webui` 的 entries 面升级为下发 boot graph：dev 期 vite 直服行包
  client/ 源码；生产期 `pnpm webui:build` 按 graph 编译为 dist 模块块。

#### D8 · 装载通道统一（范围收窄）

- 第三方 `/ui-plugin/` 的 `install(ctx)` 中，**组件贡献类六项**
  （perspective / tool-result / message-view / settings-tab×2 /
  sidebar-action）转发为 `slots.register`。
- **非视觉缝不走 slot**：`registerGlobalStyle` 维持样式消毒通道原样；
  `registerEventHandler` / `wsOn` 并入 D20 的 cordis 化事件通道。
- isolated iframe 档维持**不进 slot 注册表**现状不变。

### 1.5 数据层（D10 · D20）

#### D10 · store 座位与 pinia 共存

- 细则见 §0.3；实现时序 = S1.5 门。
- 视图状态归壳件；跨切只读身份面归 runtime 对象层；域投影归域插件，
  以客户端服务面 / store 座位暴露；域投影不挂全局 pinia。

#### D20 · 数据通道增补（Koishi 采纳 + 裁决）

- 线帧在前端转 `ctx.emit`（插件以普通 ctx.on 消费——现
  wireRpc.onWireEvent 的 cordis 化）。
- 域投影可增配服务端 DataService 式聚合推送：data/patch 双帧、
  per-client 惰性求值、推送前 intercept。
- 与 §0.3「谁的数据谁订帧」互补：高频聚合数据由 owning 服务端行聚合
  推送，低频详情仍走 RPC。
- 断线策略混合裁决：活跃会话增量重放、其余键清空（弃 Koishi 整页
  重载）。

### 1.6 兼容桥与注册表收编（D13 · D9）

#### D13 · 兼容桥与第三方声明开口策略（永久语义写明；二次评审 §4.2/§4.5-A）

- **注册面映射**：bridge 的**组件贡献类六项**（perspective /
  tool-result / message-view / settings-tab×2 / sidebar-action）映射
  新 slot id（收编表 = slot-tree §6）；ws-event / global-style 为
  **常设通道**——manifest `ui.slots` 声明照旧授权，但不进 slot 注册表
  （D8 两项非视觉缝，无映射关系）。
- manifest `ui.slots` **双读归一（旧 id → 新 id）为永久机制**：不对
  第三方既有 manifest 作废，无拆桥期。
- **第三方可声明集 = 声明账本的显式公开子集**（逐 seat `public`
  标志；数据源由账本派生，替代 BUILTIN_SLOTS 静态数组——fail-closed
  精神与 slot-tree §5.10 安全边界不变式延续；D8 收窄的是转发面，
  本条裁的是 manifest 声明校验面）。**高危替换 seat（整面板 /
  composer 类 ⚠ 名单）单列门槛**：manifest 显式声明 + 安装确认面
  明示。S3 验收含「第三方声明未公开 id 被拒」用例。
- 退役的只是前端内部旧注册面：bridge 双轨在 S3 末收敛为纯转发 +
  静态断言无内部直用。

#### D9 · 三注册表收编（依赖 S1.5 门）

- `toolResultViews` → tool 面上 keyed presentation seat（精确名 /
  正则族 / priority 语义原样进选举）。
- `messageViews` → keyed final-view seat。
- `perspectives` → `main: perspective` 专座（active 谓词保留在贡献
  声明，宿主选举逻辑不动）。
- 收编后注册表文件退役；bridge 兼容期双轨。

### 1.7 门控、性能与拆解顺序（D18 · D14 · D12）

#### D18 · 门控三件套（Koishi 采纳）

视角 / 面板 / 页签注册项支持：

1. **bail 事件权限**——默认拒绝：入口一行禁用一切、由权限面放行；
2. **fields 数据就绪门控**；
3. **卸载导航**——redirectTo 记住原路径、回 home、重装恢复。

#### D14 · 性能与开发体验

- slot 渲染开销基准（Outlet 渲染、选举、版本计数失效范围）在 S1
  建立、各阶段回归对照。
- vite manualChunks 按 boot graph 预拆。
- HMR 后置：vite 组件级热更已覆盖大部分场景；插件级热卸载 / 重挂
  在 S4 评估。

#### D12 · 域拆解顺序

- 按 ownership §3.3 配对表，数据面单一者优先：todo → goal → jobs →
  usage → timer → skill → llm-pool → …
- **runview（运行矩阵 / runs.ts，无后端行）**收尾 in-bundle 拆解为
  独立域（S2），S3 迁移时走**首个 client-only 行** `ac-client-runview`
  （D19 预留形态的首例，二次评审 §4.3 点名）。
- 每域一次可摘除性验收。

**编号映射注记**：koishi 研究文档 §3 建议 ↔ 本文 D 编号——§3.1-1→D15、
§3.1-2→D16、§3.1-3→D17、§3.1-4→D18、§3.2→D19、§3.1-5/6/7→D20；
研究文档中的 "D16" 字样指其 §3.2 包形态建议，非本文 D16。

## 2. 分阶段落地

主线：S0 基建 → S1 壳插件化（视觉零回归）→ S1.5 增强级验收门 →
S2 域插件化（in-bundle）→ S3 拆包与装载统一 → S4 薄壳收口。各阶段
验收口径汇总见 §4。

### S0 · 基建（纯核 + 注册服务 + Vue 渲染器）✅ 已实施

- 开工前：复查 DSH 0.1.2-rc.1 的 slot 基建包新形态（见头部参照系
  注记），确认 / 重裁 `ac-client-slots` 与 `ac-client-runtime` 的
  拆分。（**已复查**：本机安装为 bundled 产物无源可读；并包动机不适用
  本仓——纯核零依赖可独立单测是本仓自己的纪律，拆分维持。）
- 新包 `src/ac-client-slots`（零 cordis 依赖纯库）：
  - **首版 Koishi 朴素形态**：string key + order + single/list +
    disabled + 装载校验 + 卸载级联，~200 行含测试；
  - 注册面签名按 D2 终态形状占位（cell/priority/store/children 字段
    先占位不实现，D15）。
- 新包 `src/ac-client-runtime`：SlotRegistry **最小面**——
  - cordis Service 层：register 经 caller-ctx effect、'slots/changed'
    事件桥、renderer install boot-once、声明账本 snapshot 调试面；
  - `useContext()` 组件级 fork 与 `wrapComponent`（D17）；
  - 层 2 对象层骨架；
  - **store 实例轴与 onEntryError 不在 S0**——落 S1.5 门（复核 §3.2
    对齐）；
  - 导出 `ClientContext` 类型身份（D22）：客户端服务 / SlotMap 声明
    合并目标 = 本包与 ac-client-slots，不 augment '@agentchat/cordis'。
- webui 内 `runtime/vueRenderer.ts` + `components/SlotOutlet.vue`
  （D16：内外同轴 order + single 默认插槽 fallback + data props）。
- 测试：
  - SlotCore 单测——注册 / 同 id 替换 / order 排序 / single
    fallback / 级联回收 / 装载校验 / root 抢占拒绝；
  - SlotRegistry 单测——fiber 卸载回收。
- **验收**：`pnpm typecheck`；新包测试全绿；demo 页（临时路由）纯
  slot 装配玩具界面（root 由 slot 装配、含一个插件贡献位）；客户端
  服务名与服务端占名查重（交集为空，D22）。

### S1 · root 即 slot（壳插件化，视觉零回归）✅ 已实施

（D23-B 视觉快照基建为独立先行提交；S1 重构本体验收：全量 1443 测试 +
视觉 diff 22 张全绿 + 「卸载 layout → root 空且可诊断」layout-unload.test。）

- **视觉快照基建（D23-B，本阶段第一项——基线先行）**：Playwright
  引入 + 对**现状**拍基线集（深浅双主题 × 桌面三栏 / 移动端抽屉 /
  设置弹窗 / 消息流 / 运行矩阵），此后任何代码改动之前基线已锁定。
- `main.ts` 重写为 §0.1 装配序列（暂全部 in-bundle）。
- App.vue → `webui/src/clients/base/layout.ts`（首个基础件插件）：
  AppFrame 占 root、声明 sidebar / list-panel / main / overlay 四
  seat；原三层布局 DOM / 样式原样迁入。
- PerspectiveHost → `main` seat 内的视角专座渲染；`core/extensions/
  slots.ts` 三件与 8 个 UISlotId 挂载点改经 SlotRegistry（bridge
  双轨，D13 永久别名）。
- 门控三件套上线（D18，视角 / 面板注册项）。
- 渲染性能基准建立（D14）。
- **验收**：既有 webui 测试全绿（port-b / e2e / 渲染性能基准）+
  手工冒烟对照（布局 / 移动端抽屉 / 覆盖层零回归）+ **视觉快照
  diff 全绿**（D23-B，白名单外零像素差异）；「卸载 layout 件 →
  root 空且有可诊断报错」演示。

### S1.5 · 增强级验收门（S2 的前置；复核 §3.2 设立）✅ 已实施

五项全绿（纯核 slot-core-s15 + 运行时 slots-s15 + 渲染面 slot-s15 集成
= 20 新测试；朴素贡献语义锁定 + 全量 1463 测试 + 视觉 diff 零像素差异）：
D3 两代语义按裁决演进——封印后动态注册从「拒绝」升级为「tier 选举恒低优」
（出厂层卸载后动态层接任 = layout 消失时的恢复路径），两代差异在测试
显式记录。

SlotCore / SlotRegistry 升级到 D2 终态形状，逐项带单测：

1. **SlotMap 声明合并**类型化（declare module；240 插口声明集在此
   从 string 账本升级为类型化声明，对照 slot-tree §4；owner props
   契约同步吸收 slot-tree §5 横切约定——D2）；
2. **cell + priority 选举**（含 single 的 shadow 语义与 D16 fallback
   的衔接：无任何贡献 → 默认插槽；有贡献 → cell 选举）；
3. **store 座位**（实例轴：handle × scope key 创建 / 缓存 / 引用
   计数 / 会话死即清含持久化态）；
4. **inject 面**（声明存活期效应）；
5. **onEntryError 监督 + abdicate 退位**。

**验收门**：上述五项单测全绿 + S0/S1 全部贡献在升级后行为不回归
（朴素 order 注册的贡献在 cell 选举下语义锁定测试）。

### S2 · 域插件化（in-bundle，红线立起来）

**jobs 域试点已实施**（2026-11）：`clients/jobs.ts` 域插件（JobBoardService =
「域投影 + ctx 服务面」形态首验：域 fiber 自订 job/* 帧 + RPC 拉取 + reactive
投影 + ctx.jobBoard 服务名避让服务端 'jobs' 占名；stores/jobs.ts 退役——域投影
不挂全局 pinia）+ 双消费面切换（RunTrackingPanel / ConversationJobsChip）+
check-deps **R6 跨域边规则**上线（clients 目录运行时值导入图无跨域边，自造边
实测拦截）+ 可摘除性测试（fiber dispose → ctx.jobBoard 消失无残留）。
**附带修复**：D17 wrapComponent 改经 SLOT_OWNER_KEY 标记 owner（不劫持子树的
应用级 CLIENT_CONTEXT_KEY——曾致 AppFrame 子树读 ctx.jobBoard 抛 "without
inject" → root 崩溃退位白屏；回归锚入 slot-outlet.test）。验收：全量 1468 测试
+ 视觉 diff 零像素 + typecheck×2 + check:deps 全绿。其余域（todo/goal/usage/
timer/skill + groups/singles/runs + feed/chat 巨石 + D9 三注册表收编）待续。

**runview 域已实施**（2026-11）：`clients/runview.ts`（RunsClientService =
ctx.runs——服务名无碰撞直用域词；3s 快照轮询 + 1s 秒针随域 fiber 卸载回收；
内容签名短路保引用——矩阵零重算防御原样继承）；stores/runs.ts 退役；
双消费面切换（RunTrackingPanel / RunTracking）；可摘除性 + 定时器零泄漏
测试（clients-runview.test）。验收：全量 1472 测试 + 视觉 diff 零像素 +
typecheck×2 + check:deps 全绿。

**group 域已实施**（2026-11）：`clients/groups.ts`（GroupsClientService =
ctx.groups——服务名 'groups' 与服务端 'group' 单数占名无碰撞；群列表/
活跃群/创建弹窗投影 + group/* 七事件帧订阅随域 fiber 回收 + 选中协调
[清 Agent 选中/feed 活跃对话/lastContext]——过渡期经 pinia store 协调，
feed/chat 收尾时改服务面互调）；stores/groups.ts 退役；四消费面切换
（AppFrame/RunTrackingPanel/RunTracking/GroupDrawer）；App.vue 回滚保留
版删除（S1 窗口已闭，回滚走 git revert）；clients-groups.test 可摘除性。
**附带加固**：vitest 数据根按 worker 分桶（并行 worker 共享根上的
agents 目录 rename/config 写入竞态——EPERM/丢行 flake 的根因修复，
全量 ×2 + webui ×4 连跑全绿）。

**singles 域已实施**（2026-11）：`clients/singles.ts`（SingleBoardService =
ctx.singleBoard——'singles' 服务端占名避让（Board 后缀与 jobBoard 同族）；
独立会话列表/激活态投影[activeSingleId 派生自 feed 活跃分区] + singles/
updated 帧订阅随域 fiber 回收 + 会话上下文协调[setSingleContext/
lastContext]——过渡期经 pinia，feed/chat 收尾改服务面互调）；stores/
singles.ts 退役；七消费面切换（AppFrame/SessionList/DialogView/AgentList/
ChatInput/RunTracking/RunTrackingPanel）+ 三个直接驱动 store 的既有测试
（singles-reopen/singles-multiturn/portb-e2e）迁至服务面；clients-singles
.test 可摘除性。视觉门 comparator 校准：pixelmatch threshold 0→0.02
（吸收 GPU/字体光栅化亚像素抖动——偶发 1-2px 抗锯齿舍入差、重跑即消；
结构性变化仍全量计数）。

**workspace 域已实施**（2026-11）：`clients/workspaces.ts`
（WorkspaceBoardService = ctx.workspaceBoard——'workspace' 单数占名避让；
用户工作区清单 + CRUD 管理写面）；stores/workspaces.ts 退役；双消费面
切换（SessionList 会话树根 / ChatInput 工作区挂载下拉）；clients-
workspaces.test 可摘除性。S2 单域小 store 批次（jobs/groups/singles/
runs/workspaces）全部完成；余量：agents 读面对象层（ctx.roster）→
todo/goal/usage/timer/skill 域 → feed/chat 巨石收尾 → D9 三注册表收编。

**roster 域 + 层 2 身份面已实施**（2026-11）：`clients/roster.ts`
（RosterCore 纯 reactive 核心 + RosterService 壳 = ctx.roster——服务名
'roster' 与服务端占名无碰撞；名册/预设/选择 + 显示名/头像解析 + 名册
刷新/活跃提升/头像同步写面）；stores/agents.ts 改为**双模门面**（D13
bridge 哲理：runtime 在场绑 ctx.roster.core 单一事实源；无 runtime 每
pinia 实例独立 Core——feed/archive 状态机测试族 15+ 文件零改动）。
消费面组件暂经门面（零 churn），feed/chat 收尾时门面退役全量切
ctx.roster。clients-roster.test：排序/名称解析链/双模绑定/可摘除性。

**theme 基础件 + D9 三注册表收编已实施**（2026-11）：
- `clients/base/theme.ts`（ThemeCore 纯核心 + ctx.theme 服务面——toggle/
  html class/localStorage/theme-changed 事件原样，sync flush 确定性）+
  stores/theme.ts 双模门面（roster 同款）；装配序 theme 先于 layout；
- **D9 收编**：三注册表数据面 = SlotRegistry（keyed seat 的 meta.def），
  本模块保留为解析面——register → slots.register / resolve ← slots.
  entries（版本计数响应式；无 runtime 回落旧数组，既有测试族零改动）；
  内置批次经基础件出厂注册：`clients/base/tool.ts`（12 工具卡 →
  tool-card:result-view）+ `clients/base/conversation.ts`（user/assistant
  → message:final-view）；perspectives 注册直达 main:perspective（内置
  四视角由 AppFrame post-boot 注册）；d9-registry-consolidation.test
  锁全链（内置出厂/动态覆盖/无 runtime 回落/卸载级联 redirectTo）；
- 附带：shell-tools job/settled 测试固定 sleep → 轮询等待（全量并行
  负载容忍——本轮三连红的一致根因）。
- 验收：全量 1492 测试 ×2 连跑 + 视觉 diff 零像素 + typecheck×2 +
  check:deps。基础七件已装配四件（layout/theme/tool/conversation）。

**feed/chat 巨石收口已实施**（2026-11，§0.3 归属表收尾）：
- `clients/base/feed-core.ts`（74KB）+ `chat-core.ts`（38KB）：defineStore
  闭包体【脚本化原样抽取】（零行为变更；chat 仅三处机械适配——feed 依赖
  参数化 / storeToRefs→toRefs / Init 尾块提取为幂等 init()）；
- ConversationService（ctx.sessions——'session' 单数占名无碰撞）= feed
  核心（per-dialog 分区 = scope 键、流式 ingest 状态机、历史分页管线）
  + chat 核心（发送/中断/排队/交互/预览/压缩反馈，经 reactive(feed)
  视图注入）；服务面 init() 由装配序列显式发起（main.ts setActivePinia
  之后——名册启动链经门面）；
- stores/feed.ts / stores/chat.ts → 双模门面（roster 同款：runtime 绑
  服务核心单一事实源；无 runtime 独立实例 + 创建即 init 旧行为原样）
  ——feed 状态机测试族（并行工具/快速切换/resume 合并等 12 文件）零
  改动全绿；
- 验收：全量 1496 测试 ×2 连跑 + 视觉 diff 零像素 + typecheck×2 +
  check:deps。**S2 域插件化阶段收口**（六域 + 四基础件 + D9 收编 +
  feed/chat 巨石）；S3 余项：feed 分区升级 store 座位实例轴、
  interaction/compress 段随域走、todo/goal/usage/timer/skill 域 UI
  （随 S3 行包 client/ 迁移逐域落地）。

- 按配对表把域资产迁入 `webui/src/clients/<domain>.ts` 插件模块
  （todo / goal / jobs / usage / timer / skill 先行）；模块间禁
  import 跨域视图组件——扩展 `scripts/check-deps.mjs` 新规则
  （clients 目录的运行时值导入图无跨域边）。**每域迁移附 D23-A
  选择器审计清单**（后代选择器父链 / scoped 边界 / :deep() /
  z-index 语境 / 主题令牌）。
- **store 同批拆解**（§0.3 归属表；依赖 S1.5 的 store 座位 /
  inject）：
  - 单域小 store 先行（jobs / groups / singles / runs 验证「域投影 +
    ctx 服务面」形态）；
  - feed / chat 两巨石收尾——feed 拆为会话 scope 树 + 投影管线
    （群 / pair 归一经贡献者注入管线）、chat 按动作域拆解
    （interaction / compress 段随域走）；
  - 全程以既有 feed 状态机测试（并行工具 / 快速切换 / resume 合并
    等）锁零回归。
- 三注册表收编（D9）：presentation / final-view keyed seat 上线，
  内置工具卡迁移为各域贡献。
- **验收**：可摘除性逐域测试（运行时动态 unload 模块 → UI 消费面
  消失，无残留无报错）；依赖图 CI 规则生效；feed / chat 拆解后既有
  webui 测试全绿；逐域检查项含「替换型继承移动端行为」「z-index
  配额合规」（D2 挂靠的 slot-tree §5 约定）。

### S3 · 拆包与装载统一（D19 形态）

**P0 纵切片已实施**（2026-11，boot graph 机制 + runview 首例全链）：
- **ac-webui boot graph 面**：WebUiService 增 declareClient（行 apply
  声明 client 半边；disposer 经 ctx.effect 挂行 fiber——卸载即级联
  回收）+ listBootGraph + `GET /api/ui/boot-graph` 路由；
- **`src/ac-client-runview` client-only 行首例**（cordis.yml/TREE 两表
  + agentchat.client 清单 + ./client 出口）：宿主半边 = 声明 boot graph
  条目（无服务）；client 半边 = RunsClientService（ctx.runs——经
  **ctx.rpc 契约面**调宿主 RPC，不 import webui 内部模块）+ **域投影
  合成管线 toRunsSnapshot 迁入**（snapshot+agents/list 双 RPC 聚合，
  契约随行走——RunsSnapshot 族类型 owning = 行包，webui api/runs
  re-export 维持既有消费面）；
- **ctx.rpc 契约面**（ac-client-runtime/src/rpc.ts：RpcClientFace 接口
  归运行时包）+ webui 宿主实现（rpcClient.ts 薄壳 wireRpc.call，
  装配第③步 rpcHostPlugin）；
- **webui 装载器**：runtime/bootGraph.ts（拉图 → 静态映射装载 →
  ctx.plugin；一行失败隔离）+ vite rowClientsPlugin（扫 src/ac-*/
  client/index.ts → virtual:row-clients 静态映射——dev 直服源码 /
  prod 构建为行 client 模块块 `index-*.js`）；vitest alias 注入口
  （virtual-row-clients.ts 垫片）；
- **runview 迁出 in-bundle**（webui/src/clients/runview.ts 退役）；
- **验收全绿**：全量 1501 测试 ×2（含 runview-row 卸载级联 / boot-graph
  HTTP 面真树 / 装载器装载 / port-b 合成管线兼容）+ 视觉 diff（白名单
  登记：插件目录出现 runview 行——扩展目录随行集生长的既定语义）+
  typecheck×2 + check:deps；`pnpm webui:build` 产物 = 壳 dist + 行
  client 模块块（index-*.js 独立 chunk）。
- 余项：第三方 bridge D8 收窄改写 + D13 公开子集校验、desktop 构建冒烟
  （D21）。jobs/groups/singles/workspaces/roster 域行 client/ 迁移（同
  ac-todo 模式）。

**S3-1a 已实施**（2026-11，ac-todo 行包双半边首例——计划验收点名域）：
- `src/ac-todo/client/`：ToolResultTodo（tool-card:result-view 出厂贡献
  id 'todo'，BUILTIN 表摘除）+ TodoPanel/TodoDockCard（新席位
  **tracking:dock-widget** ——slot-tree chat:composer-docks 收编首例；
  conversation 基础件声明，TaskDock 改席位宿主：零包裹化 + 6px 底距
  下放各卡，零像素）+ 数据管线 tasks.ts（契约随行走）；
- 宿主半边：可选 webui 依赖以【子插件 fiber + inject】承载（headless
  宿主跳过声明、webui 迟到不丢——apply 期 ctx.get 有顺序竞态，实测
  真树丢声明后改此形态）；
- **ctx.rpc.onEvent**（RpcClientFace 增事件帧订阅，D20 运输前置）+
  **boot graph 热通道**：ac-webui declareClient 收缩/登记 →
  webui/boot-graph-changed 帧（ws-bridge 转发）→ 前端装载器 debounce
  重拉 diff（卸载先回收 fiber 后清缓存）；
- **两径验收**：重启径（bootTree skip 集 = bootDist 读 cordis.patch.yml
  后同一代码路径 → graph 无 todo + ctx.todos 同灭）+ 热通道径（帧 →
  重拉 → 行 client 级联回收 → 重装幂等）；行包双半边/卡片归一化/
  出场贡献可摘除性测试齐（todo-row/todo-card/boot-graph×2）；
- webui tsconfig include 扩 `../ac-*/client/**`（行 client .vue 全量
  vue-tsc 覆盖；根 tsc 走 client/shims.vue.d.ts 垫片）。

**S3-2/S3-3 已实施**（2026-11，bridge D8 收窄 + D13 公开子集校验）：
- **D8**：bridge 组件类六项纯转发确认（数据面经三解析面 = SlotRegistry；
  ws-event/global-style 常设通道维持）；AppFrame 内置四视角出厂批次改
  slots 直注册（对齐 tool 基础件形态）——旧注册面唯一入口 = bridge；
  **静态断言测试**（slot-catalog.test）：webui/src 内 registerXxx 六件
  仅 bridge/types/定义模块出现（内部直用 = 编译期外红灯）；
- **D13**：`core/extensions/slotCatalog.ts` 永久别名目录（旧 8 id → 新
  席位/常设通道 + highRisk 标志）+ `assertDeclarableSlot`（未声明 /
  席位未 declare / 未公开 → 拒绝且可诊断——公开子集由**账本派生**
  declOf().public，替代静态白名单）；服务端安装期 fail-closed
  （ac-plugin-core UI_SLOT_IDS 8 id 永久词汇——未知 id 拒绝）；高危
  门槛（perspective ⚠ = 整面板替换）：manifest 显式声明（既有）+
  **安装确认面明示**（评审载荷 uiHighRiskSlots + 插件库「高危席位」
  徽章）；拒绝用例齐（plugin-core 安装期 + webui bridge 席位级）。

**S3-1b 已实施**（2026-11，五域行 client 半边收口——jobs/groups/
singles/workspaces/roster 全部迁出 in-bundle）：
- **ac-jobs/client**（ctx.jobBoard）+ **ac-group/client**（ctx.groups）+
  **ac-singles/client**（ctx.singleBoard）+ **ac-workspace/client**
  （ctx.workspaceBoard，REST 直连无 rpc）+ **ac-agents/client**
  （ctx.roster——RosterCore/RosterService + 名册合成管线 toAgentList）；
  webui/src/clients/*.ts 域模块退役（仅剩 base/），main.ts 第④步 =
  纯 boot graph 装载；api/{jobs,groups,singles,roster,files} 转
  re-export/薄包装（契约随行走，旧 import 路径维持）；
- **协调面服务化**（S2 过渡期 pinia 协调就此收口）：groups/singles
  的选中互调改 ctx.sessions/ctx.roster 服务面——**SessionsClientFace
  契约归 ac-client-runtime**（RpcClientFace 同款：行 client 不 import
  webui；feed/chat 富类型经门面侧 cast）+ ConversationService 增
  setKnownGroups/trackKnownSingle（presence 帧路由判别的协调口）+
  roster 增 clearSelection；
- **lastContext 持久化小件**迁 ac-client-runtime（三域行共用——
  结构化 localStorage 类型，不引 DOM lib）；
- 双模门面（stores/agents·feed·chat）绑行包 RosterCore/sessions
  契约面——无 runtime 独立实例语义不变（feed 状态机测试族零改动）；
- webuiBoot 测试靴补 conversation 基础件（sessions 协调面前提）；
  每行附宿主半边 boot graph 声明/卸载级联测试；boot-graph-http
  真树断言五域条目在场。

- 域模块迁入行包内 `client/` 目录（如 `src/ac-todo/client/`）：行
  `package.json` 加 `"agentchat": { "client": {...} }` 清单 +
  `./client` 出口——**不新建包、不新增组合行**（cordis.yml / TREE
  两表仅在基建三包时动过）。例外首例：runview 开首个 **client-only
  行** `ac-client-runview`（无后端能力的独立 UI 行，D19/D12）。
- `ac-webui` 升级 boot graph 下发（dev 直服行包 client/ 源码 / prod
  按 graph 构建）。
- 第三方 bridge 按 D8 收窄改写（组件类六项转发 slots.register）；
  D13 别名归一机制固化。
- **验收**：
  - 卸载 **`ac-todo` 行**（yml patch，重启 + include 热通道两径）→
    **该域后端能力 + 前端 todo 全部消费面一并消失**，宿主不残废；
  - 第三方示例插件经旧 manifest `ui.slots` 声明仍可装载（D13 永久
    双读）；**声明未公开 id / 高危 seat 未过门槛 → 拒绝且可诊断**
    （D13 开口策略）；
  - `pnpm webui:build` 产物 = 壳 dist + 行 client 模块块；
    `pnpm --dir desktop dist` 构建通过（D21）。

### S4 · 薄壳收口

- webui/ 只剩：main.ts 装配序列 + runtime 胶水 + 构建配置 + 设计原语
  出口；`@agentchat/webui-kit` 独立包（原 ui/* + tokens）；
  `isolated-runtime` 迁 ac-client-runtime（D21）。
- **基础七件物理落点复核**（D11 / D19 遗留裁决；此时 slot 轨道的
  shadow / 替换已被 S1–S3 验证）：webui 内 `clients/base/` 常驻 vs
  独立 `ac-client-app` 单包——定案并执行。
- README 可视化层章节改写；slot 树文档标注「已实施声明集」对照表。
- **验收**：webui/ 目录清单与 ownership §3.1 逐项对齐；全量回归 +
  CSP 审计 + 构建产物体积对照（S1 基准）+ desktop 构建与启动冒烟。

## 3. 影响面清单（文件 / 包级一览）

| 面 | 变更 |
|---|---|
| 新包（仅三件基建） | ac-client-slots、ac-client-runtime、@agentchat/webui-kit |
| 行包（≥15 个域行） | 各加 `client/` 目录 + `agentchat.client` 清单 + `./client` 出口（D19；不新增组合行） |
| webui 重写 | main.ts（装配序列）、App.vue→layout 基础件、core/extensions/*（bridge 按 D8 收窄改写）、core/registry 三件（收编退役）、isolated-runtime 迁出（D21） |
| webui 迁移 | components/** 与 settings/** 按 ownership 配对表分流至域插件（S2 in-bundle → S3 迁行包 client/） |
| 宿主行 | ac-webui（boot graph 下发）、ac-webui-extensions（BUILTIN_SLOTS 退役→声明账本） |
| 组合根 | 仅基建三包进 cordis.yml 与 ac-app TREE 两表（同步纪律不变） |
| CI | check-deps 新规则（clients 跨域边）；webui 测试矩阵扩 slot 用例 |
| desktop | 发布形态随 dist 模块块变化；S3/S4 构建与启动冒烟纳入验收（D21） |
| 文档 | README 可视化层、slot-tree/ownership 状态标注、本计划进度 |

## 4. 验收与测试口径

- 每阶段：`pnpm typecheck && pnpm test` + `pnpm --filter ac-webui-app
  typecheck`（vue-tsc）+ 冒烟。
- 结构性测试（随阶段生长）：SlotCore/SlotRegistry 单测（S0 朴素面 +
  S1.5 增强面分列）、**视觉快照 diff（S1 基线先行后逐阶段，白名单
  外零像素差异——D23-B）**、可摘除性逐域测试（附 D23-A 选择器审计
  清单）、依赖图 CI 规则、root 抢占拒绝、entry 崩溃退位（S1.5 起）、
  CSP 审计、desktop 构建冒烟（S3/S4）。
- 视觉回归：S1 起以现有 port-b/e2e + 渲染性能基准锁零回归。
- 行为不变量：**卸载任一域行或客户端件，宿主不残废**（D19 语义：
  域行卸载 = 后端 + 前端消费面一并消失）——框架「可独立摘除」心法
  的前端验收形态。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| CSS 作用域 / stacking context 断裂（组件迁入插件渲染树：后代选择器父链、scoped 边界、Teleport 语境） | D23-A 纪律：Outlet 零包裹节点 + 每域选择器审计清单；D23-B 快照 diff 兜底 |
| 无像素级视觉回归检测（现状仅契约/DOM 级测试 + 手工冒烟，「样式不变」缺机械保证） | D23-B：S1 基线先行 + 逐阶段 diff 全绿；白名单（有意行为改进）外任何差异即回归、阻断验收 |
| slot 渲染开销（深层嵌套 Outlet×选举×版本失效） | D14 基准 S1 建立、逐阶段对照；Outlet 细粒度版本计数（key 级，非全局） |
| **SlotCore 两代语义断层**（朴素 single fallback → cell shadow 选举：order 排序 ≠ shadow，首版注册的贡献升级后行为会变） | D15 签名按终态占位（演进=行为增强非签名变更）；S1.5 验收门含「朴素贡献在 cell 选举下语义锁定测试」；两代语义差异单测显式记录 |
| 迁移期双轨漂移（bridge 与新注册表不一致） | bridge 只转发不实现；S3 末收敛为纯转发 + 静态断言无内部直用（D13 别名归一为永久机制，不拆） |
| feed/chat 拆解回归面大（状态机语义微妙：steer/续拉/合并） | 单域小 store 先行验证形态；既有 feed 状态机测试全程锁行为；拆解独立成提交可单点回退 |
| root 被误占/基础件互踢 | D3 装载校验显式报错；基础件 cell 冲突进 CI 测试 |
| boot graph 与行装载竞态（热通道） | graph 变更走既有 extensions-changed debounce diff；卸载先回收后清缓存 |
| desktop 发布形态随 dist 模块块变化（extraResources 复制链路） | S3/S4 构建冒烟前置；desktop 构建脚本随 boot graph 调整单独提交 |
| 浏览器 bundle 体积（cordis + 基础七件） | manualChunks 预拆 + 基准对照；cordis 按需入口（仅 Context/fiber 面） |
| 回滚 | S0/S1 各自可独立回退（S1 前 App.vue 原样保留一版）；S2 起每域独立提交，可单域回退；S3 行包 client/ 迁移逐行独立提交 |

## 6. 与调研文档及复核报告的关系

- `webui-slot-tree.md`：§4 的树 = slot 声明集（S0/S1 为 string 账本，
  S1.5 升级为 SlotMap 类型化声明；实施时逐域标注「已声明」）；§6
  收编表 = D13 别名的映射依据。
- `webui-plugin-ownership.md`：§3.2/§3.3 = D11 基础集合与 D12 拆解
  顺序的事实源；其「独立 ac-client-ui-* 包」形态已被 D19 改裁为行包
  client/ 半边（配对表语义不变，物理落点变更）——实施后该文档降格
  为历史对照。
- `webui-koishi-console-research.md`：D15–D20 的证据源（编号映射见
  §1 末注记）。
- `m27-webui-slot-refactor-plan-review.md`：本计划 v2 的修订依据
  （P0-P3 全量落实：D19 贯穿 §2/§3/§4、S1.5 增强门、API 形状占位、
  desktop、D13 永久双读、D8 收窄、DSH 版本注记、D21 遗留入口、
  main.ts 24 行）。
- `m27-webui-slot-refactor-plan-review2.md`：本计划 v2.2 的修订依据
  （P1-P3 全量落实：D22 客户端 Context 类型身份与查重、D13 第三方
  公开子集与高危门槛 + S3 拒绝用例、runview client-only 行点名
  （D12/D19/S3）、owner props 契约挂靠 slot-tree §5（D2/S1.5/S2）、
  四项精度修正——D13 六项分述 / D3 时序注记 / api-remotes 实名 /
  D16 分型说明）。
