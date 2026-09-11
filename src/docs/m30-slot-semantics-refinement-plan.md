# M30 席位语义收口（elect/data 轴扶正 + 树关系原语化 + 服务端注册表退役）

> **状态：实施中（2026-11 本 session 开工）**。来源 = 三轮槽位语义评估对话：
> ① 逐槽评估当前实际开槽 → ② 更好槽位结构存在性 → ③ Slot 树关系设计。
> 对象：M27.2/M28/M29 后的浏览器席位账本（17 席 + 2 常设通道）。
> 关联事实源：`webui-slot-tree.md`（调研树 + 实施注记）、
> `ui-rows-and-slots.md`（行/席对照）、`src/README.md`（契约归属总表）。

---

## 0. 诊断摘要（三轮评估的收敛结论）

1. **骨架不动**：扁账本 + 两段命名 + 所有权树/渲染树松耦合是对
   "域 × 容器矩阵"的正确回应。结构化父子树（选边耦合易变渲染树）、
   双轴寻址（17 席全 1:1 时纯增熵）、域子树命名（容器轴散失）均否决
   ——翻盘条件见 D8。
2. **词汇落后于实践**：5 处 keyed 选举席（main:perspective /
   message:final-view / tool-card:result-view / list-panel:domain /
   settings:section）的选举语义住在注释（"keyed seat"自称 10+ 处）与
   meta.def 约定里，类型词汇表不可见；数据贡献席
   （sidebar:plugin-actions，icon+onClick def）被迫伪造 stub component。
3. **关系语义手码**：占用门控（"子席位占用 → 父壳显隐"）在 AppFrame
   以两段复制的"版本计数 ref + slots/changed 订阅 + entries().length"
   存在；壳宿主落位两种表达——SidebarHost/ListPanelsHost/
   SettingsOverlayHost 是注册条目，PerspectiveHost 却是 main outlet
   默认子节点（不参与选举、不可退位、不可卸载）。
4. **命名规则未成文**：第一段事实规则 = "席位宿主"，唯一离群点
   tracking:dock-widget（宿主 = conversation 件 DialogView/TaskDock，
   键名却用内容域前缀 tracking——该域另两处 UI 在 main:tracking 与
   list-panel:domain/meta.panel，本就不构成子树）。
5. **服务端注册表遗迹**：ctx.uiExtensions（BUILTIN_SLOTS 六槽白名单 +
   declareSlot/register/install 超时）生产链路零消费——第三方 UI 实际
   链路 = manifest.ui → `ctx.webui.addEntry`（ac-plugin-registry:1276）→
   浏览器 `/api/ui/extensions` → bridge install（浏览器侧自持 15s 超时，
   host.ts:50）→ SlotRegistry 注册 + `assertDeclarableSlot` 账本派生校验。
   服务端 register 仅剩 ac-webui/tests 直测消费面。

## 1. 裁决

### D1 `elect` 轴：keyed 选举席词汇扶正

评估轮提出 `SlotKind` 补 `'keyed'`；**实施裁决改为 `SlotDecl.elect?: boolean`
独立轴**——理由：keyed 席位的 entries() 行为仍是 list 轴（选举链
[match/section/panel/active 谓词 + priority] 住解析面 meta.def，SlotCore
不重复实现），做成 kind 会产生"与 list 行为全同的第五种 kind"；轴化后
与 D2 的 data 轴正交（未来 toolIcon/toolLabel 键控数据注册表 =
elect+data 双轴席，slot-tree P3 批次的天然落点）。

- `SlotDecl.elect` + `SlotTypeMeta.elect` 增字段（JSDoc：宿主解析面
  keyed 选举、不堆叠；选举协议由席位 owner 在解析面文档化）。
- 五席声明补 `elect: true`（owning 件各改一处 declare + SlotMap）。
- SlotOutlet：elect 席位渲染恒空 + DEV 警告（堆叠渲染 keyed 席位 =
  语义误用，fail-closed 对齐 D1）。

### D2 `data` 轴：数据席位（宿主渲染、贡献供 def）

- `SlotDecl.data?: boolean` + `SlotTypeMeta.data`：席位 owner 声明
  "我渲染、贡献供数据（meta.def）"；register 对 data 席**免 component
  必填**（错误信息同步改写——非视觉常设通道 ws-event/global-style 仍
  不走 slot，D8 边界不变）。
- sidebar:plugin-actions 转 `data: true`；bridge `registerSidebarAction`
  退役 stub component（`{ render: () => null }` 伪造载荷消灭）。
- SlotOutlet：data 席位渲染恒空 + DEV 警告。

### D3 `useSeatOccupancy`：占用门控关系原语化

渲染器包（ac-client-ui-renderer，Vue 侧原语的 owning 件）新增
`client/useSeatOccupancy.ts`：`useSeatOccupancy(key): Ref<boolean>`
（inject ctx + 版本计数 + slots/changed 细粒度失效 + onScopeDispose）。
AppFrame 两段手码门控（main:workspace / main:tracking）换用原语。
关系语义"子席位占用控制父壳显隐"从宿主复制粘贴模式升为词汇。

> **后记（同批除役）**：后续「主区语义纯化 / aux 区域构造对齐」（main
> 与 aux-sidebar 升 keyed 选举席）令占用门控**内在于选举**——条目缺席
> = 非候选 = 区域消失，原语失去全部生产消费方（仅余自锁单测）。按
> 「最少抽象」纪律除役（文件删除，git 史可溯）；预留席（bottom-panel/
> status-bar）实现时若需显式门控，再行复活。

### D4 壳宿主统一为注册条目

PerspectiveHost 自 main outlet 默认子节点迁为 layout 件对 `main` 席位的
注册贡献（id `webui-base-layout.perspective-host`，base 批次装载 →
同 order 平局恒先，DOM 序不变——视觉零 diff 预期）。规则唯一化：
**壳的每个区域 = 一个席位；宿主只是它的第一个贡献者**（外部贡献与宿主
同轴 order 合并，D16-① 既有承诺不变）。副产收益：宿主条目获得
EntryErrorBoundary 崩溃隔离（S1.5-5）与 wrapComponent fiber 对齐（D17）。
SlotOutlet 的默认子节点机制保留为通用原语（slot-outlet.test 锁定），
仅不再被壳宿主使用。

### D5 席位键规则成文 + 离群点改名

规则（写入 ac-client-slots SlotDecl.key JSDoc + 本文档）：
**席位键第一段 = 席位宿主（渲染 outlet 的宿主组件/owning 件），
内容域不入键**；布局区域（main/sidebar/list-panel/overlay）与宿主
组件/件（settings/tool-card/message/agent-pane/group/conversation）同权。
离群点改名：`tracking:dock-widget` → **`conversation:dock-widget`**
（内部席位、非 public、非 legacy 别名目标——零兼容成本；ac-plugin-core
manifest 词汇 = 旧 8 id 永久集，不受影响）。

### D6 装饰批次容器裁决（规约项，无代码）

slot-tree P2 装饰批次（~100 个 `*-item-suffix`/`*-badge`/`*-menu-items`）
开口前先裁决容器：**默认落"数据注册表 + 宿主固定词汇"**
（fields/toolIcon 先例；elect+data 双轴席是 P3 数据注册表批次的落地
形态），仅真需自绘组件的装饰才开 list 微槽。席位总数维持 ~20 量级。

### D7 服务端 ctx.uiExtensions 退役

词汇表（slotCatalog.ts）留包转纯库（浏览器 settings re-export 与
ac-plugin-core UI_SLOT_IDS 镜像不动），Service/BUILTIN_SLOTS/
declareSlot/register/install 超时机制退役：

- 删 `ac-webui-extensions/src/service.ts` + `tests/`；
- index.ts 改纯数据 re-export；package.json 去 `"agentchat": {"plugin": true}`
  与 keywords agentchat（纯库判据，fail-closed）；
- cordis.yml 行 + ac-app TREE 行 + 两处 package.json 依赖摘除；
- ac-webui/tests/webui.test.ts 旧服务 describe 块删除（浏览器侧
  host.ts 自持 15s 超时 + bridge assertDeclarableSlot 是现行防线，
  各有测试锁定）；
- README 契约表 uiExtensions 行删除、布局节同步。

### D8 不做项与翻盘条件（显式存档）

- **结构化父子树**（声明须父在场/级联 undeclare）：耦合易变渲染树或
  重复所有权树；包粒度级联已覆盖（layout 件卸 = 9 席全消）。
  `SlotEntry.children` 缝保留不启用。
- **双轴寻址**（mount × vocabulary）：17 席全 1:1 时纯增熵。翻盘条件 =
  同一词汇需挂多位（如 pair 只读视图复用 message:final-view、dock 列
  出现在第二视角）。
- **ownerProps 机器强制**（z-index 配额发放器）：公开面（6 席）扩至
  几十第三方 UI 插件前不做。

## 2. 任务清单

| # | 任务 | 落点 | 状态 |
|---|---|---|---|
| T1 | D1+D2 词汇轴：SlotDecl/SlotTypeMeta 增 elect/data；register 校验放宽；SlotOutlet 恒空+DEV 警告 | ac-client-slots/src/index.ts、ac-client-ui-renderer/client/SlotOutlet.vue | ✅ |
| T2 | 五席 elect 扶正 + sidebar:plugin-actions data 转正 | layout/conversation/tool/sidebar/settings 各 client/index.ts | ✅ |
| T3 | bridge registerSidebarAction 退役 stub | webui/src/core/extensions/slots.ts | ✅ |
| T4 | D3 useSeatOccupancy 原语 + AppFrame 接管（后随主区语义纯化同批除役，见 D3 后记） | ac-client-ui-renderer/client/useSeatOccupancy.ts、layout/client/AppFrame.vue | ✅ |
| T5 | D4 PerspectiveHost → main 注册条目 | layout/client/{index.ts,AppFrame.vue} | ✅ |
| T6 | D5 改名 conversation:dock-widget | conversation（client+src+package.json）、goal、todo、webui tests ×4、docs ×3 | ✅ |
| T7 | D7 服务端注册表退役 | ac-webui-extensions、cordis.yml、ac-app、ac-webui tests、README | ✅ |
| T8 | 测试补齐：elect/data 轴单测、occupancy 单测、门控/条目断言更新 | ac-client-slots/tests、ac-client-ui-renderer/tests、webui/tests | ✅ |
| T9 | 文档同步：README、ui-rows-and-slots、webui-slot-tree 注记、architecture-diagram | src/README.md 等 | ✅ |

## 3. 测试与验收

- `pnpm typecheck && pnpm webui:typecheck && pnpm test`（root vitest
  workspace 全量，1595+ 基线）。
- 行为不变量：root 席位条目集不变；main 席位 DOM 序不变（PerspectiveHost
  仍居首）；dock 卡 DSH 序 todo(10) → goal(20) → queue(30) →
  interaction(40) 不变；六公开席位 public 断言（slot-bridge.test）不变。
- 新增：data 席 register 无 component 成功 / 非 data 席仍拒；elect 席
  outlet 渲染恒空；useSeatOccupancy 响应注册/撤销。

## 4. 文档同步点

`src/README.md`（uiExtensions 行删除 + 客户端 slots 行补 elect/data 词汇）、
`docs/ui-rows-and-slots.md`（席位表改名 + 轴标注）、
`docs/webui-slot-tree.md`（头部实施注记补 M30 行）、
`docs/architecture-diagram.html`（uiExtensions 卡片/表行删除）。

## 5. 执行进度

- [x] T1-T9 全部完成（本 session 单轮实施）。
- [x] 门禁：`pnpm typecheck` ✓ + `pnpm webui:typecheck` ✓ + `pnpm test`
      210 文件 / 1590 用例全绿（含新增 elect/data 双轴单测、
      useSeatOccupancy 翻转单测；旧服务测试块随退役删除）+
      `check-deps` R1-R7 ✓（白名单只减不增）。
- [x] 行为不变量复核：root 席位条目集不变；dock 卡 DSH 序
      todo(10) → goal(20) → queue(30) → interaction(40) 不变
      （clients-conversation 断言）；六公开席位 public 断言不变
      （slot-bridge.test）；boot-graph 热通道行集断言同步更新
      （portb-e2e 全行集目录摘 webui-extensions）。
- [x] 实施期坑（记档）：PerspectiveHost 条目注册须置于全部 declare
      **之后**（fail-closed：先声明后注册——首跑 62 例红灯实录）。

### 5.1 事故修复：D4 显形的 M28 P0.2 潜伏缺陷（群/独立会话视角 def 直访服务）

**现象**（浏览器实录）：群选中态下点击 Agent 切换 → 控制台
`[slots] entry 崩溃退位：main#webui-base-layout.perspective-host
Error: cannot get property "groups" without inject` → 主区空白
（壳条目退位后再无候选）。

**根因（双因叠加）**：
1. **潜伏缺陷（M28 P0.2 引入）**：ui-group / ui-singles 视角 def 的
   active/props 闭包直访 `ctx.groups` / `ctx.singleBoard`——本件
   apply ctx 的 fiber 链上无人 inject 该服务名，cordis 属性解析抛
   "cannot get property without inject"（正解 = talk def 既有的
   `ctx.get('<name>')` 可选探测姿势）。
2. **显形机制（M30 D4）**：潜伏期该异常只在 pair/talk 均不激活
   （群/独立会话选中态）求值到这两个 def 时触发，且旧形态下异常
   传播仅致 PerspectiveHost 渲染失败（视图停留旧态的哑故障）；D4
   壳宿主条目化后，异常经 EntryErrorBoundary 捕获 → perspective-host
   **退位** → main 席位空 → 主区整体空白，故障从"隐性"变"显性"。

**修复（三层）**：
- ① 两 def 改 `ctx.get('groups')` / `ctx.get('singleBoard')` 可选探测
  （ui-group/ui-singles client/index.ts——active 与 props 工厂双改）；
- ② 解析面防御（ac-client-ui-layout/client/perspectives.ts +
  PerspectiveHost.vue）：main:perspective 为公开席位（第三方可贡献），
  缺陷 def 只应失去选举资格——activePerspective 求值
  （safeActive）、registerPerspective 卸载导航（D18-3 redirectTo
  前置判定）、PerspectiveHost buildProps 三处全部 try/catch + 警告；
- ③ 回归锁 `webui/tests/perspective-election.test.ts`（3 用例：
  群激活选举不抛 / singles def 求值不抛 / 毒 def 跳过 + 警告）。

**门禁**：双 typecheck ✓ + 全量 test ✓（一次 boot/perf 族负载
flake 隔离复跑确认——slot-render-perf 单跑 582ms 远低于护栏）+
`webui:build` ✓（19.2s）。

**遗留观察项（D4 后续）**：~~视角**组件级**渲染崩溃仍会退位壳条目~~
（**已收口**：PerspectiveHost 内嵌视图级错误边界——渲染期崩溃就地
降级错误卡〔重试 / 切视角自愈〕，止播不上抛，壳条目不退位；
`perspective-election.test.ts` 第 4 例回归锁。事件处理器等运行期错误
不降级视图，走默认传播链）。

