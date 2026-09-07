# M27 WebUI 纯 Slot 重构 — 会话交接（2026-11，S3 主体完成点）

> 上一 session 完成至 S3 P0（boot graph + ac-client-runview 首例）；本
> session 完成S3 主体（S3-1a/1b/2/3 + 热通道 + 两径验收）与 S4 两件
> （基础七件落点定案 + isolated-runtime 迁移）。
> 本文件 = 下一 session 的开工交接：现状 / 验收命令 / 剩余工作 / 关键机制与坑。
> 事实源：`m27-webui-slot-refactor-plan.md`（v2.3 + 各阶段实施标注）。

## 1. 当前进度（全部已提交，工作树干净）

| 阶段 | 状态 | 提交 |
|---|---|---|
| S0-S2 + S3 P0（见上一版交接表） | ✅ | `21d089f` 及之前 |
| S3-1a：ac-todo 行包双半边 + rpc.onEvent + boot graph 热通道 + 两径验收 | ✅ | `9619a5f` |
| S3-2/3：bridge D8 收窄（静态断言）+ D13 公开子集校验（含拒绝用例+高危门槛） | ✅ | `4c428d3` |
| S3-1b：五域行 client 收口（jobs/groups/singles/workspaces/roster）+ SessionsClientFace 协调面 | ✅ | `84bff4d` |
| S4 部分：基础七件落点定案（维持 webui clients/base/ 常驻）+ isolated-runtime 迁 ac-client-runtime | ✅ | 本轮末提交 |
| S3-4：desktop 构建冒烟 | ⚠️ 环境阻塞 | electron-builder 构件下载网络超时 ×3（got 600s timeout——非代码问题；desktop/release/win-unpacked 有历史产物） |

**验收基线（每次续作前先跑一遍确认起点绿）**：

```bash
pnpm typecheck && pnpm webui:typecheck   # 双 typecheck
pnpm test                                 # 1523 测试（shell-tools job/settled 为负载敏感 flake，红则隔离复跑）
node scripts/check-deps.mjs               # R1-R6（在仓库根跑；src/ 下跑会 MODULE_NOT_FOUND）
AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
#   视觉门：真浏览器（Edge channel）+ 自动重建 dist；SKIP_BUILD=1 跳过重建；UPDATE=1 重建基线（须在文件头白名单登记）
pnpm webui:build                          # 产物 = 壳 dist + 行 client 模块块（index-*.js）
pnpm --dir desktop dist                   # D21 冒烟（网络可达时）
```

## 2. 剩余工作（全部属 S4 薄壳收口）

1. **`@agentchat/webui-kit` 独立包**（D0 基建三包之三——至今未建）：
   - 内容 = `webui/src/ui/`（18 件：14 vue 组件 + tokens/row/badge 三 css + icons.ts + index.ts）；
   - 包名按计划定名 `@agentchat/webui-kit`（scoped 名在 pnpm workspace 可用；cordis.yml 不动——纯库不进行）；
   - 全量改写 webui 内 `from '.../ui'` 导入面（约 30+ 文件，机械替换 + 双 typecheck 锁）；
   - vite/tsconfig/vitest 的 `@` alias 不受影响（ui/ 目录整体迁走后 webui/src/ui 删）。
2. **README 可视化层章节改写**（§可视化层：boot graph/行包双半边/契约面归
   ac-client-runtime 的现状）+ slot 树文档「已实施声明集」对照表（§4 树
   逐行标注——大半已实施，抽查即可）。
3. **ownership §3.1 目录清单对齐复核**（webui/ 现状：clients/ 仅剩
   base/、stores/ 仅剩四门面——按 §3.1 逐项对表，差异要么修要么改文档）。
4. **CSP 审计**（现状无 CSP 头？核查 ac-web-server 响应头 + iframe
   sandbox 面——P5.5 面原样，补审计记录）。
5. **构建体积对照**（S1 基准：`git show 3cac31a` 期的 dist 体积 vs 现
   在——manualChunks 已有 vue/markdown/chart 预拆；行 client 块独立）。
6. **desktop 构建冒烟**（网络恢复后 `pnpm --dir desktop dist`；两径失败
   记录见 §3-11）。
7. **（可选，S2 遗留低优先）**：feed 分区升级 store 座位实例轴；
   goal/usage/timer/skill 域 UI 资产随各自行包 client/ 迁移（同 ac-todo
   模式——这些行尚未有 client 半边）。

## 3. 关键机制与坑（本 session 新沉淀；S3-1a 之前的见 plan 文档各阶段标注）

1. **行包双半边模板**（7 例在册：runview/todo/jobs/groups/singles/
   workspace/agents）：宿主半边 = `ctx.plugin({ name: '<pkg>.webui-client',
   inject: ['webui'], apply })` 子插件 fiber 声明 boot graph（**不要用
   apply 期 `ctx.get('webui')` 探测——真树装载顺序竞态会静默丢声明**，
   实测踩过）；client 半边 = `clientPlugin({ inject: ['rpc', ...], apply })`
   + default export；package.json 加 `agentchat.client` 清单 + `./client`
   出口 + vue/ac-client-runtime 依赖。
2. **协调面纪律**（行 client 不 import webui）：跨域读走 `ctx.<svc>`
   （inject 声明）；**契约面归 ac-client-runtime**（RpcClientFace 含
   `call`+`onEvent`；SessionsClientFace = feed/chat 结构子集 + presence
   协调口——webui 门面侧 cast 取富类型：`stores/feed.ts`·`chat.ts` 两处
   `as FeedCore`/`as ChatCore`）。新增行 client 需要新协调面时：接口进
   ac-client-runtime + webui 实现侧加「契约满足静态断言」
   （conversation.ts 尾部 `_sessionsFace` 形态）。
3. **同键双声明 TS2717**：ClientContext 的同一服务名只能在一处
   `declare module`（webui 不得重复声明 sessions——富类型走 cast）。
4. **e2e 测试三件套**（portb-e2e/singles-* 族迁移后形态）：client 栈全装
   （rpcHost + conversation + roster 行 client）→ `setClientRuntime` →
   **`clientCtx.sessions.init()`**（wire 订阅须显式发起）→ 新 pinia 实例
   **在 setClientRuntime 之后**创建 store（门面绑定时读 runtime 单例，
   先建后设会绑到独立核心——portb-e2e 踩过）。
5. **注册顺序竞态（本 session 最深坑）**：DialogView 连接条初值
   `ref(false)` + 纯 onWireOpen 事件——boot graph 异步装载使 WS 常在
   挂载前已开 → 事件永不触发 → 31px 连接条永久误显（45859px 视觉 diff）。
   修复 = 初值读现态 `ref(wireRpc.connected)`。**教训：任何「事件驱动
   布尔」都要问初值来源**；boot graph 异步化会放大一切注册顺序假设。
6. **视觉门调试法**（无图像输入时的定位链）：diff.png 红掩膜算包围盒/
   行带分布 → 基线 vs 当前逐行平均色采样 → worktree 在 HEAD 建对照
   dist 跑视觉（ bisect 环境隔离）→ 页内 `getBoundingClientRect` walk
   dump 几何树比对。失败取证已固化：gate 失败时自动落 `*.current.png`。
7. **行 client .vue 的类型覆盖**：根 tsc 走 `client/shims.vue.d.ts` 垫片
   （include `src/*/client/**/*.ts`）；webui vue-tsc include 扩
   `../ac-*/client/**/*`（全量类型检查）。
8. **ac-client-runtime 的 DOM 纪律**：包内文件进根 tsc 程序（无 DOM
   lib）——浏览器面一律结构化类型（lastContext/isolated-runtime 两例：
   `interface WindowLike` + `declare const` + `export {}` 保模块作用域）。
9. **D13 词汇表单源**：旧 8 UISlotId 永久集在 ac-plugin-core
   （UI_SLOT_IDS/HIGH_RISK_UI_SLOTS——服务端安装期校验 + 评审载荷）；
   前端 slotCatalog.ts 是别名/公开子集/校验面（账本 public 派生）。
   注意 SLOT_ID_RE 已修（冒号段 `settings-tab:global` 此前无法通过安装
   期格式校验——历史漏洞）。
10. **boot graph 热通道**：ac-webui declareClient 收缩/登记 →
    `webui/boot-graph-changed` 帧（ws-bridge 转发）→ 前端装载器 300ms
    debounce 重拉 diff（卸载先回收 fiber 后清缓存）；重启径 =
    cordis.patch.yml disabled 行（bootDist skip 集同一代码路径）。
11. **desktop 失败形态**：electron-builder 下载 Electron 构件
    （got 'request' 600s timeout）——纯网络阻塞；缓存
    `%LOCALAPPDATA%\electron-builder\Cache` 在场但版本构件不全。
    网络恢复后直接复跑即可。

## 4. 文件地图（M27 面·本 session 后现状）

```
src/ac-client-slots/            SlotCore 纯核
src/ac-client-runtime/          ClientContext + SlotsService + rpc/sessions 契约面
                                 + lastContext 小件 + isolated-runtime（S4 迁入）
src/ac-client-runview/          client-only 行首例（ctx.runs）
src/ac-{todo,jobs,group,singles,workspace,agents}/client/   域行 client 半边
                                 （tool 卡/dock 卡/域投影服务/数据管线随行走）
src/webui/src/main.ts           装配序列（④ = 纯 applyBootGraph；无 in-bundle 域件）
src/webui/src/clients/base/     基础件（layout/theme/tool/conversation + feed/chat 核心）
                                 ——S4 定案：常驻 webui，不建 ac-client-app
src/webui/src/runtime/          vueRenderer/slotRender/SlotOutlet + bootGraph（热通道）/
                                 rpcClient/clientRuntime/hostLedger/virtual-row-clients
src/webui/src/api/              jobs/groups/singles/roster/files = re-export/薄包装
                                 （契约 owning = 各行包 client/）
src/webui/src/stores/           四门面（agents/theme/feed/chat）——S4 待退役评估
src/webui/src/core/extensions/  bridge（D8 纯转发）+ slotCatalog（D13）+ isolated 宿主
src/ac-webui/src/service.ts     declareClient + listBootGraph + boot-graph-changed 事件
src/cordis.yml + src/ac-app/src/index.ts   组合根两表（同步纪律；S3 未动——行集不变）
```

## 5. 下一 session 建议开工序

1. 跑 §1 验收命令确认起点绿（约 5 分钟）；
2. S4-1：`@agentchat/webui-kit` 独立包（ui/* 18 件迁出 + 导入面全量
   改写 + 双 typecheck/视觉/build 全绿）；
3. S4-2：README 可视化层改写 + slot 树「已实施声明集」对照；
4. S4-3：ownership §3.1 对齐复核 + CSP 审计 + 体积对照；
5. desktop 冒烟（网络窗口）；全量验收后 M27 收口。
