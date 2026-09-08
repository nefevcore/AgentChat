# M28 交接——§4.2 深批（stores 双模对子退役 + 座位实例轴）

> **状态（2026-11-08，本 session 收口时点）**：M28 P0/P1/P2 + P3 主体
> 全部落地（28 提交，全量门禁绿）。**唯一余项 = P3 §4.2 深批核心**。
> 进度总表与裁决注记见 `m28-ui-plugin-tree-plan.md` §10（事实源）；
> 本文件 = 下 session 开工文档（范围 + 消费面清单 + 设计方向 + 坑）。

## 0. 开工第一步：确认起点绿

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1595 通过（boot 族偶发负载 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts   # 基线 pristine
```

## 1. 余项范围（§4.2 深批核心，五件一体）

1. **stores/{feed,chat}.ts 双模对子退役**：webui 最后两个 store 门面。
   形态：runtime 在场 → 绑 ctx.sessions 核心；无 runtime → 独立实例
   （`vi.mock('../src/api/wire')` 拦截面——feed/chat 状态机测试族
   〔port-b + feed-* 十余文件〕的数据驱动面）。
2. **agentsStore 消费面切 ctx.roster**：agentsStore =
   RosterCore 的 pinia 转发壳（owning = ac-client-ui-agents RosterCore；
   文件住 ac-client-ui-conversation/client/agentsStore.ts）。
3. **feed 分区 store 座位实例轴**（新机制）：排队/交互等 per-dialog
   状态从 DialogView 本地 composable 迁到按 conversationId 实例化的
   轴——**基建现成**：`ac-client-slots` SlotStoreAxis（acquire/release/
   dropScope + entry.store 工厂）+ SlotsService.stores/acquireStore。
4. **queue/ask dock 出厂贡献化**（注记 0b）：QueueDock/InteractionBar
   改 tracking:dock-widget 贡献——**依赖第 3 件**（useQueuedMessages
   是 per-dialog 实例，先行贡献化必须状态先上轴）。
5. **api/ 门面层退役**（注记 0d）：12 个 webui/src/api/* 域门面。
   生产消费面仅 wire（运行时本体，保留）+ extensions（host.ts）；
   其余全是测试动态 import（依赖 wireRpc 缺省签名——包内函数 rpc
   必传）。退役 = 测试换源 + 补 rpc 实参，与 1/2 同族测试改写同期。

## 2. 消费面清单（本 session 实勘）

**useAgentStore**（切 ctx.roster 时逐个改）：
- conversation：chat-core.ts、feed-core.ts、ChatInput、DialogView、
  GroupDrawer、PairDialogView、Message/TurnDisplayItem
- layout：AppFrame（activeAgentId 让位 watch）
- ui-agents：AgentSettingsHost（refreshAvatar）、AgentList
- ui-singles：SessionList；ui-runview：RunTracking、RunTrackingPanel
- settings：SettingsPanel
- 测试 16 处（已换源直连 conversation 包——见 grep
  `ac-client-ui-conversation/client/agentsStore`）
- 形状（全量转发）：agents/activeAgentId/presets/defaultPreset/
  defaultPresetId/requestAgents/fetchPresets/selectAgent/setAgents/
  bumpAgent/bumpAgentById/tryRestoreLastAgent/getAgentAvatar/
  refreshAvatar/getAgentName/isPreset

**api 门面测试消费**（动态 import，grep `src/api/` 于 webui/tests）：
port-b（7 模块静态 + runs/chat-ops 动态）、portb-e2e（roster/singles/
runs）、singles-multiturn、singles-reopen、visual-snapshot（roster）、
goal-tracking（tasks）、history-order（runs）、jobs、
tool-result-visibility（runs/chat-ops）、feed-group-ghost（chat-ops）。

## 3. 设计方向（建议，未裁决）

- **agentsStore 切换**：RosterCore 已是纯 reactive——消费面可直取
  `clientRuntime()?.roster?.core`；无 runtime 测试态需要「同测试内多次
  取用同实例」语义（现靠 pinia 实例缓存）——最小改写 = conversation
  包内提供 `useRosterCore()`（模块级单例缓存 per runtime 缺席期），
  或测试显式 `new RosterCore()` 注入。feed-core/chat-core 签名改造
  （roster 作参数传入）是本件主体。
- **座位实例轴**：优先复用 SlotStoreAxis 而非自建——
  `slots.acquireStore(key, entryId, scopeKey)` + `dropScope(convId)`
  （会话死即清）。QueueDock 状态 = entry.store 工厂返回
  useQueuedMessages 的核心态。
- **api 退役**：测试换源后包内函数 rpc 必传——port-b 族已有
  `makeRpcStub().impl` 与 `setWireSocketFactory` 先例，可造
  `wrapRpc(pkgFn)` 测试助手统一补参。

## 4. 坑（本 session 实录，均踩过）

- **动态 import 带 `.ts` 后缀**：`import('../src/stores/agents.ts')`
  ——grep 不带后缀漏网（首跑红灯 ×2 实录）。换源时全量 grep
  `stores/`、`api/` 两族都要带/不带后缀各扫一遍。
- **PowerShell 批量编辑**：①自定义 ReplaceIn 改 package.json 曾产出
  损坏 JSON（引号丢失）——**JSON 一律用 edit 工具**；②here-string 会
  吃 JS 模板字符串反引号（生成 package.json 事故）——**生成文件用
  write 工具**。
- **行尾混布**：仓库 CRLF/LF 混在，PS 原生 Replace 需双态探测；edit/
  write 工具无此问题。
- **R5 环检测只看 .ts 运行时值边**：.vue 跨包互引合法（conversation↔
  agents 相向依赖成立的前提）；新 .ts 边先查环。
- **行 client/index.ts 内禁静态 .vue import**（node 测试/portb-e2e 炸
  useMarkdown 的 document）——一律 defineAsyncComponent。
- **跨席位贡献统一 slots.inject**（声明存活期效应：在场即注册/缺席
  即等待/塌缩或卸载即回收）——P0-2 起全族既定形态。
- **portb-e2e 行集断言 = ASCII sort**（不是 localeCompare——`ui-web`
  居 `ui-usage` 后、`ui-plugin-registry` 居 runview 前均踩过）。
- **boot graph 按名排序**（listBootGraph localeCompare）——yml 行序
  无装载语义，改序不必动 yml。
- **视觉门**：基线 pristine 勿轻重建；插件目录/配置两页在视觉环境是
> **确定性空态**（裁决 0e——抽样断言已否决）；新行入册需
> `AGENTCHAT_VISUAL_UPDATE=1` 重建 07/08（+06 若设置树变化）。
- 测试残留 `src/cordis.test.yml` / `cordis.patch-guard.test.yml`
  用后即删（勿提交）。

## 5. 建议开工序（下 session）

1. §0 基线确认绿；
2. **agentsStore 切 ctx.roster**（独立可提交——先 conversation 包内
   useRosterCore + feed-core/chat-core 参数化，测试族逐文件换）；
3. **store 座位实例轴 + queue/ask dock 贡献化**（一体两件，独立提交）；
4. **stores/{feed,chat}.ts 退役 + api 门面退役**（同族测试改写收官）；
5. 每步独立提交过全门禁；§10 执行进度段随步记入。

—— 完成后：m28 计划头部状态改「已全部实施」，M28 关闭。
