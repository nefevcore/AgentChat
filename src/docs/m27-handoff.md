# M27 WebUI 纯 Slot 重构 — 最终交接（2026-11，M27.1 域 UI 拆包修正）

> **M27 主体已收口**（S0-S4 全阶段，验收基线全绿——见 §1）。
> 用户复核后**改裁 D19**：功能与 UI 应为两个独立插件包——域 UI 从
> 现行「后端行包 client/ 双半边」拆出为**独立 client-ui 行包**。
> 本文件 = 下一 session 的开工文档：修正目标（§2）+ 裁定点（§3）+
> M27 剩余后置项（§4）+ 机制坑（§5）+ 开工序（§6）。
> 事实源：`m27-webui-slot-refactor-plan.md`（v2.3 + 各阶段实施标注 +
> **D19 修订记录[2026-11 用户改裁]**）。

## 0. 修正目标一句话

**每个域 = 后端行 + UI 行两个独立插件包，各自可独立摘除。**
现状六域（todo/jobs/group/singles/workspace/agents）的 UI 住在后端行
`client/` 目录里（D19 原形态）；修正 = 拆成 `ac-client-ui-<域>` 独立行
（cordis.yml/TREE 新增行）。`ac-client-runview` 本来就是独立 UI 行
形态——**它就是迁移模板，方向不变、只是把六域对齐过去**。

## 1. 收口现状（修正起点）

| 阶段 | 提交 |
|---|---|
| S0-S2 + S3 P0 | `21d089f` 及之前 |
| S3-1a：ac-todo 双半边 + rpc.onEvent + boot graph 热通道 + 两径验收 | `9619a5f` |
| S3-2/3：bridge D8 收窄 + D13 公开子集校验 | `4c428d3` |
| S3-1b：五域行 client 收口 + SessionsClientFace 协调面 | `84bff4d` |
| S4(a)：isolated-runtime 迁移 + 基础七件落点定案（clients/base/ 常驻） | `2ea677e` |
| S4(b)：@agentchat/webui-kit 抽取 + 收口文档 | `f17045f` |
| S4(c)：desktop 构建与启动冒烟 ✓（NSIS Setup 0.8.5.exe） | `52bd798` |

**验收基线（续作前先跑一遍确认起点绿）**：

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1523 测试（shell-tools job/settled 负载敏感 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6（仓库根跑）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
pnpm webui:build                          # 壳 dist + 行 client 模块块
```

**为什么修正来得急（可行性）**：S3-1b 已把六域 client 半边的依赖面
**全部契约化**（只依赖 ac-client-runtime：RpcClientFace call+onEvent /
SessionsClientFace / lastContext——零 webui import）。拆出 = 移文件 +
建包 + 注册行 + 改 re-export 指向，纯机械动作；boot graph/热通道/
D13/视觉门机制不动，只「长行」。

## 2. M27.1：域 UI 拆独立 client-ui 行包（主线）

### 2.1 目标形态（模板 = ac-client-runview）

```
src/ac-client-ui-todo/
  package.json        # name ac-client-ui-todo；agentchat: { plugin: true,
                      #   client: { platform: web, entry, phase: domain } }
                      # deps: vue + ac-client-runtime；exports: ./src/* + ./client*
  src/index.ts        # 行 apply：inject ['webui'] → declareClient({
                      #   name: 'ui-todo',   ← 必须与目录派生名一致（见 2.3）
                      #   entry: ../client/index.ts 绝对路径, ... }) + ctx.effect
                      # + ExtensionMeta（label「待办清单（前端）」runview 同款）
  client/             # 原 ac-todo/client/* 原样迁入（组件/服务/数据管线）
  tests/todo-ui-row.test.ts   # boot graph 声明 + 卸载级联（runview-row 同款）
```

后端行（ac-todo 等）反向摘除：删 `client/` 目录与 `webui-client`
子插件、package.json 去 client 清单与 vue/ac-client-runtime/ac-webui
依赖；行为纯后端。

### 2.2 每域迁移清单（六域同款机械动作）

1. `git mv src/ac-<域>/client → src/ac-client-ui-<域>/client` + 新
   package.json + src/index.ts（模板抄 ac-client-runview/src/index.ts）；
2. **cordis.yml + ac-app/src/index.ts TREE 两表加行**（M27 期间首次动
   组合根！两表行集同步纪律；行 id 建议 `ui-todo` 等与 boot graph
   name 一致）；
3. webui re-export 指向改：`api/tasks.ts`·`api/jobs.ts`·`api/groups.ts`·
   `api/singles.ts`·`api/roster.ts`·`api/files.ts` 内 `from
   'ac-<域>/client'` → `from 'ac-client-ui-<域>'`；`bootGraph.ts` 的
   `import type {}` 六处同改；`stores/agents.ts` 的 RosterCore 同改；
4. 测试随行走：`ac-<域>/tests/*-row.test.ts` 迁入新包（改断言名）；
   webui `tests/clients-*.test.ts` 导入面同改；`portb-e2e` 行集清单
   断言补六行；`boot-graph-http` 真树断言改新名；
5. `pnpm install` + 双 typecheck + 全量测试 + 视觉门（插件目录页出现
   六个新行——07/08 两景白名单登记，runview 先例）+ webui:build。

### 2.3 静态映射命名对齐（坑）

vite `discoverRowClients` 从**目录名**派生 boot graph 静态映射键：
`ac-client-ui-todo` → 去 `ac-client-` 前缀 → **`ui-todo`**。行
declareClient 的 name 必须等于派生键（`ui-todo`），否则
`rowClientLoaders[def.name]` 映射缺失 → 装载器 warn 跳过（runview 的
`ac-client-runview`→`runview` 天然一致；六域命名照此对齐，或改
discoverRowClients 支持 manifest 显式名——二选一，开工定）。

### 2.4 跨 UI 行依赖（已在机制上成立）

`ui-group`/`ui-singles` 的 client 插件 inject `['rpc','sessions',
'roster']`——`roster` 服务由 `ui-agents` 行提供：行间依赖走 inject
声明（fiber 等待，装载序无关）✓ 机制现成，迁移时保持 inject 不动。

### 2.5 验收（修正的核心收益显性化）

- **独立摘除语义**（每域两径）：
  - 卸 **UI 行**（yml patch / 热通道）→ 后端能力在（`todo/get` RPC
    可调）+ 前端消费面消失（工具卡回落文本渲染、dock 卡无贡献）；
  - 卸**后端行** → UI 行照常装载，RPC 失败 → `fetchTodos` null →
    dock 静默空态（graceful degradation——现有三态契约的另一半）；
- 测试形态：`ac-client-ui-<域>/tests/` 两向用例（boot graph 级联 +
  RPC 空态）；boot-graph-http 真树断言新行集；
- 视觉白名单登记（插件目录六新行）；portb-e2e 行集断言更新。

### 2.6 建议迁移顺序

todo（最小、带组件资产）→ jobs → workspace → singles → groups →
agents（roster 最后——ui-group/ui-singles 依赖它）。每域独立提交
（可单点回退），域绿再进下一域。

### 2.7 顺流直下（不再走后端 client/ 过渡）

goal/usage/timer/skill 四域 UI（§4-1）在修正后的形态下**直接建
`ac-client-ui-*` 行包**，不再经历「先后端 client/ 再拆」两步。

## 3. 开工裁定点（两处，需用户定夺）

1. **基础七件是否同样独立成包**（ownership §3.2 的 ac-client-ui-*
   七件族 = 对 S4「clients/base/ 常驻」定案的再复核）。注意七件
   **无后端行**，「功能/UI 两包」语义不适用——问题实质是要不要
   `ac-client-app` 单包（S4 定案的三条反对理由见计划 S4 段，仍成立）。
   若维持常驻：补拆 renderer/sidebar/settings 三件为 webui 内基础件
   （第五~七件，席位从 hostLedger 代持转正）——此项**无论包形态如何
   都值得做**；
2. **命名方案**（§2.3）：目录派生名对齐（`ui-todo`）vs manifest
   显式名。推荐前者（零机制改动）。

## 4. M27 剩余后置项（不因修正变化）

1. goal/usage/timer/skill 域 UI → 直接建 `ac-client-ui-*` 行（§2.7）；
2. renderer/sidebar/settings 三件拆件（§3-1 附带项）；
3. stores 四门面（agents/theme/feed/chat）退役评估（消费面切
   ctx.roster/sessions）；feed 分区升级 store 座位实例轴；
4. QueueDock/InteractionBar 迁入 tracking:dock-widget 席位贡献；
   ~230 建议名插口按需开口；
5. api/ 薄包装层随消费面收敛退役（re-export 指向 §2.2-3 已改一次，
    退役时同点收口）；主文档 CSP 实施；HMR 热卸载评估（D14 后置）。

## 5. 机制与坑（开工前必读）

1. **宿主半边声明**：子插件 fiber `inject: ['webui']` + declareClient
   （勿用 apply 期 `ctx.get('webui')`——装载顺序竞态静默丢声明，踩过）；
   UI 行因整行即宿主，直接 top-level `inject = ['webui']`（runview 形）；
2. **同键双声明 TS2717**：ClientContext 服务名只在一处 declare；富类型
   经门面 cast（stores/feed·chat 两处 `as` 现范本）；
3. **注册顺序竞态**：事件驱动布尔必须问初值来源（DialogView 连接条
   `ref(wireRpc.connected)` 教训）；
4. **e2e 三件套**：client 栈全装（rpcHost+conversation+ui-agents）→
   `setClientRuntime` → `sessions.init()` → 新 pinia 在 setRuntime 之后
   建 store；
5. **ac-client-runtime DOM 纪律**：结构化类型 + `export {}`；根 tsc
   exclude 浏览器纯库（webui/webui-kit，两例在 tsconfig exclude）；
6. **视觉门调试链**（无图像输入）：diff 红掩膜包围盒/行带 → 双图逐行
   色采样 → worktree HEAD 对照 dist → 页内几何 walk dump；gate 失败
   自动落 `*.current.png`（取证增强已固化）；
7. **desktop**：构建含构件下载（网络敏感——超时×3 后恢复通过的实录
   在案）；冒烟 = `pnpm --dir desktop dist` + win-unpacked exe 进程
   12s 存活。

## 6. 建议开工序

1. §1 基线确认绿；
2. §3 两处裁定点定夺（用户）；
3. §2.6 顺序逐域拆包（todo 首域立范 → 逐域独立提交）；
4. §4 后置项按需（goal/usage/timer/skill 直达新形态）；
5. 全量验收（基线 + desktop）后 M27.1 收口、计划文档 D19 修订段
   补「已实施」标注。
