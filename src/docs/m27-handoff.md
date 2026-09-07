# M27 WebUI 纯 Slot 重构 — 交接（2026-11，**里程碑收口**）

> **M27 已收口**：S0-S4 全阶段实施完毕，验收基线全绿。本文件转为
> 收口记录 + 后置项清单；事实源：`m27-webui-slot-refactor-plan.md`
> （v2.3 + 各阶段实施标注——S0/S1/S1.5/S2/S3-1a/S3-2·3/S3-1b/S4）。

## 1. 收口状态（提交序列）

| 阶段 | 提交 |
|---|---|
| S0-S2 + S3 P0 | `21d089f` 及之前 |
| S3-1a：ac-todo 双半边 + rpc.onEvent + boot graph 热通道 + 两径验收 | `9619a5f` |
| S3-2/3：bridge D8 收窄 + D13 公开子集校验 | `4c428d3` |
| S3-1b：五域行 client 收口 + SessionsClientFace 协调面 | `84bff4d` |
| S4(a)：isolated-runtime 迁移 + 基础七件落点定案 | `2ea677e` |
| S4(b)：@agentchat/webui-kit 抽取 + 收口文档三件 | `f17045f` |
| S4(c)：desktop 构建与启动冒烟（NSIS Setup 0.8.5.exe + 进程冒烟 ✓） | 本文件收口提交 |

**验收基线（收口态全绿）**：

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1523 测试
node scripts/check-deps.mjs               # R1-R6（仓库根跑）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
pnpm webui:build                          # 壳 dist + 行 client 模块块
pnpm --dir desktop dist                   # NSIS 安装器（网络可达时）
```

## 2. 后置项（不阻断收口；按需开新里程碑）

1. **goal/usage/timer/skill 域 UI 资产**随各自行包 client/ 迁移
   （同 ac-todo 模式——四行尚无 client 半边；goal 已有 GoalBar/
   ToolResultGoal + useGoalTracking 在 webui）；
2. feed 分区升级 store 座位实例轴（scopeKey = dialogId）；stores/
   四门面退役评估（消费面全量切 ctx.roster/sessions）；
3. 主文档 CSP 实施（审计记录在 plan S4 段——script-src 'self' 等，
   待插件装载模型稳定）；HMR 插件级热卸载评估（D14 后置）；
4. QueueDock/InteractionBar 迁入 tracking:dock-widget 席位贡献
   （slot-tree P1 批次余量）；~230 建议名插口按需逐个开口；
5. api/{jobs,groups,singles,roster,files} 薄包装层随消费面收敛逐步
   退役（契约 owning = 行包；wrapper 仅为旧路径兼容）。

## 3. 机制与坑（沉淀全集——S3-1a 前的见 plan 文档各阶段标注）

1. **行包双半边模板**（7 例：runview/todo/jobs/groups/singles/
   workspace/agents）：宿主半边 = 子插件 fiber `inject:['webui']` 声明
   boot graph（勿用 apply 期 `ctx.get('webui')`——装载顺序竞态会静默
   丢声明）；client 半边 = clientPlugin + default export + package.json
   `agentchat.client` 清单。
2. **协调面纪律**：跨域读走 ctx.<svc>（inject）；契约面归
   ac-client-runtime（RpcClientFace call+onEvent / SessionsClientFace）；
   webui 富类型经门面 cast；同键双声明 TS2717——ClientContext 服务名
   只在一处 declare。
3. **注册顺序竞态**：事件驱动布尔必须问初值来源（DialogView 连接条
   `ref(wireRpc.connected)` 修复——boot graph 异步化放大一切顺序假设）。
4. **e2e 三件套**：client 栈全装 → setClientRuntime → sessions.init()
   → 新 pinia 在 setRuntime 之后建 store。
5. **ac-client-runtime DOM 纪律**：结构化类型（lastContext/
   isolated-runtime 两例）+ `export {}` 保模块作用域；根 tsc exclude
   浏览器纯库（webui/webui-kit）。
6. **视觉门调试链**（无图像输入）：diff 红掩膜包围盒/行带 → 双图逐行
   色采样 → worktree HEAD 对照 dist → 页内几何 walk dump；gate 失败
   自动落 current.png。
7. **desktop 构建网络依赖**：electron-builder 构件下载超时是环境阻塞
   （got 600s timeout×3 后网络恢复即通过）；缓存 %LOCALAPPDATA%
   \electron-builder\Cache。

## 4. 文件地图（收口态）

```
src/ac-client-slots/            SlotCore 纯核（SlotMap 类型化/cell 选举/store 座位）
src/ac-client-runtime/          ClientContext + SlotsService + rpc/sessions 契约面
                                 + lastContext + isolated-runtime（D21）
src/webui-kit/                  @agentchat/webui-kit 设计原语库（基建三包之三）
src/ac-client-runview/          client-only 行首例
src/ac-{todo,jobs,group,singles,workspace,agents}/client/   域行 client 半边
src/webui/src/                  薄壳：main.ts 装配序列 + clients/base/（七件常驻）
                                 + runtime/（bootGraph 热通道/rpcClient/slotRender）
                                 + api/（行包 re-export）+ stores/（四门面）
src/webui/src/core/extensions/  bridge（D8 纯转发）+ slotCatalog（D13）+ isolated 宿主
src/ac-webui/src/service.ts     declareClient + listBootGraph + boot-graph-changed
src/cordis.yml + src/ac-app/src/index.ts   组合根两表（M27 全程未动——行集不变）
```
