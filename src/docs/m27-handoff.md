# M27 WebUI 纯 Slot 重构 — 会话交接（2026-11，S3 P0 完成点）

> 上一 session 完成至 **S3 P0 纵切片**（boot graph 机制 + ac-client-runview 首例）。
> 本文件 = 下一 session 的开工交接：现状 / 验收命令 / 剩余工作 / 关键机制与坑。
> 事实源：`m27-webui-slot-refactor-plan.md`（v2.3 + 各阶段实施标注）。

## 1. 当前进度（全部已提交，工作树干净）

| 阶段 | 状态 | 提交 |
|---|---|---|
| S0 基建（ac-client-slots / ac-client-runtime / SlotOutlet / demo） | ✅ | `63325f8` |
| S1 视觉基线先行（D23-B，22 张 × 零像素） | ✅ | `3cac31a` |
| S1 壳插件化（main.ts 装配序列 + layout 基础件 + D13 双轨 + D18 + D14） | ✅ | `d7b6398` |
| S1.5 增强门（SlotMap 类型化 / cell+priority / store 座位 / inject / abdicate） | ✅ | `119278f` |
| S2 jobs 域试点 + check-deps R6 红线 + D17 修复 | ✅ | `f20fab2` |
| S2 runview in-bundle（后被 S3 迁出） | ✅ | `4a2a172` |
| S2 groups 域 + vitest 数据根按 worker 分桶 | ✅ | `d18b4ca` |
| S2 singles 域 | ✅ | `f429e56` |
| S2 workspaces 域 | ✅ | `b2ffb83` |
| S2 roster 域 + 层 2 身份面（agents 双模门面） | ✅ | `cf62505` |
| S2 theme 基础件 + D9 三注册表收编 | ✅ | `26e248d` |
| S2 feed/chat 巨石收口（ctx.sessions） | ✅ | `74e86b5` + `8e3ab3c` |
| **S3 P0：boot graph + ac-client-runview 首例** | ✅ | `21d089f` |

**验收基线（每次续作前先跑一遍确认起点绿）**：

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1501 测试（shell-tools job/settled 为负载敏感 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6（R6 = clients 跨域边）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
#   视觉门：真浏览器（Edge channel）+ 自动重建 dist；SKIP_BUILD=1 跳过重建；UPDATE=1 重建基线（须在文件头白名单登记）
pnpm webui:build                          # 产物 = 壳 dist + 行 client 模块块（index-*.js）
```

## 2. 剩余工作

### S3 余项（下一 session 主线）
1. **域行 client/ 迁移**（模式已由 ac-client-runview 验证）：
   - 首选 `ac-todo`（计划验收点名）：`src/ac-todo/client/index.ts`（todo 域 UI 组件 + TodoPanel 资产迁入）+ 宿主半边 `ctx.webui.declareClient` + cordis.yml/TREE **不动**（todo 行已在册，只加 client 半边）；
   - 验收：**yml patch 卸载 ac-todo 两径**（重启 + include 热通道）→ 后端能力 + 前端消费面一并消失；视觉白名单登记（插件目录行变化）；
   - 然后 jobs/groups/singles/workspaces/roster 逐域从 webui/src/clients/* 迁行包（同模式）；
   - todo/goal/usage/timer/skill 的域 UI 资产（组件）随各自迁移落地（S2 时未迁，计划允许）。
2. **第三方 bridge D8 收窄**：`core/extensions/bridge.ts` 六项组件类（perspective/tool-result/message-view/settings-tab×2/sidebar-action）转发 `slots.register`；ws-event/global-style 维持常设通道；
3. **D13 公开子集校验**：manifest `ui.slots` 声明 id 必须 ∈ 声明账本 `public` 子集；高危 seat（highRisk）门槛；S3 验收含「声明未公开 id → 拒绝且可诊断」用例；
4. **desktop 构建冒烟**（D21）：`pnpm --dir desktop dist`。

### S4 薄壳收口
- `@agentchat/webui-kit` 独立包（ui/* + tokens）；
- `isolated-runtime.ts` 迁 ac-client-runtime（D21）；
- webui/ 收口为：main.ts 装配序列 + runtime 胶水 + 构建配置 + 设计原语出口；
- **基础七件物理落点定案**（clients/base/ 常驻 vs 独立 ac-client-app 单包——S4 复核裁决）；
- 验收：目录清单对齐 ownership §3.1 + 全量回归 + CSP 审计 + 构建体积对照（S1 基准）+ desktop 冒烟。

## 3. 关键机制与坑（实测沉淀，勿重踩）

1. **D22 查重**：客户端服务名 ∩ 服务端占名 = ∅（`ac-client-runtime/tests/client-context-identity.test.ts` 静态锁定）。命名：无碰撞直用域词（groups/runs/roster/theme/rpc/sessions）；碰撞用 Board 后缀（jobBoard/singleBoard/workspaceBoard）。
2. **cordis namespace 插件形态**：`import * as row` 后 `ctx.plugin(row)` 的 apply **返回值不被收集为 disposer**——必须 `ctx.effect(() => off)`（ac-client-runview/src/index.ts 现范本）。
3. **Service 类插件无参构造**：`constructor(ctx: Context, options: X = {})` 缺省参形态（否则 TS 要求 2 参）；首个参数类型用 `Context`（不是 ClientContext，否则 plugin 泛型推断要求传 config）。
4. **注释内 `*/` 序列**（如 `ac-*/client`）会提前终止块注释——esbuild/vite 直接解析炸；jsdoc 里写 `ac-<pkg>/client`。
5. **视觉基线确定性**：page.clock 固定时间锚 + 动画禁用 + `.snap-time` 隐藏（服务器墙钟）+ 市场页签服务器侧 fetch 固定失败（npm/github 离线）；pixelmatch threshold **0.02**（亚像素抖动吸收，结构性变化仍全量计数）。
6. **vitest 数据根按 `VITEST_POOL_ID` 分桶**（scripts/vitest-setup-chdir.mjs）——并行 worker 共享根竞态（EPERM rename）的根因修复；三连接 fixture 自动复制进桶。
7. **D17 wrapComponent**：用独立 `SLOT_OWNER_KEY` 标记 owner，**不劫持 CLIENT_CONTEXT_KEY**（曾致 AppFrame 整棵子树读 ctx.jobBoard 抛 "without inject" → root 白屏；回归锚在 slot-outlet.test「owner 包裹不劫持子树」）。
8. **双模门面模式**（agents/theme/feed/chat 已用）：`clientRuntime()?.svc?.core ?? new Core()`——app 绑单一事实源；单测（无 runtime）每 pinia 实例独立 Core，既有测试族零改动。
9. **boot graph 静态映射名派生**：目录名 strip `ac-client-` → `ac-`（`ac-client-runview` → `runview`）——vite.config.ts `discoverRowClients`。
10. **jsdom 测试环境** URL 全局是垫片：需要 node:url/fs/真 HTTP 的用例单独拆 **node env 文件**（boot-graph-http.test.ts 即此因）；jsdom 缺 matchMedia——全局 setup 已垫。
11. **调试浏览器侧问题**：visual-snapshot.test 已挂 pageerror/console 捕获（`[visual:pageerror]` / `[visual:console]` 前缀）——S3 类装载问题先看它。
12. **ctx.sessions（feed/chat 核心）**：服务面 ref 直取 `.value`（toRefs 桥）；pinia 门面自动 unwrap 同值；chat 公开面无 activeDialogId（归 feed 面）。
13. **契约随行走**：RunsSnapshot 族 + toRunsSnapshot 合成管线的 owning = ac-client-runview/client；webui api/runs re-export 维持旧 import 路径。后续域迁移同款。

## 4. 文件地图（M27 面）

```
src/ac-client-slots/            SlotCore 纯核（SlotMap 类型化/cell 选举/store 座位/abdicate）
src/ac-client-runtime/          ClientContext 身份 + SlotsService + objects 层 + vue 适配 + rpc 契约面
src/ac-client-runview/          client-only 行首例：src/（宿主=graph 声明）+ client/（ctx.runs）
src/webui/src/main.ts           装配序列①-⑥（③基础件⑤第三方④=applyBootGraph）
src/webui/src/clients/base/     layout/theme/tool/conversation 基础件 + feed-core/chat-core
src/webui/src/clients/*.ts      jobs/groups/singles/workspaces/roster（in-bundle，待迁行包）
src/webui/src/runtime/          vueRenderer/slotRender/SlotOutlet 支撑 + bootGraph/rpcClient/
                                 clientRuntime/hostLedger/virtual-row-clients/slots-demo
src/webui/src/components/SlotOutlet.vue + SlotOutletItem.ts   席位渲染（D16/D23-A）
src/webui/src/core/extensions/  bridge 双轨（D13；D8 收窄待做）
src/webui/src/core/registry/    三注册表解析面（D9 收编完成，数据面=SlotRegistry）
src/webui/src/stores/           仅剩双模门面（agents/theme/feed/chat）——S4 退役
src/cordis.yml + src/ac-app/src/index.ts   组合根两表（同步纪律）
```

## 5. 下一 session 建议开工序

1. 跑 §1 验收命令确认起点绿（约 5 分钟）；
2. S3-1：ac-todo client 半边迁移（含组件资产 TodoPanel/ToolResultTodo 归属裁决）→ yml patch 卸载两径验收 → 视觉白名单登记；
3. S3-2/3：bridge D8 收窄 + D13 公开子集校验（含拒绝用例）；
4. S3-4：desktop 构建冒烟；
5. S4 按 §2 顺序收口。
