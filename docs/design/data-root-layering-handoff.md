# 数据根分层与第二层收敛方案（cr-handoff：2026-11-07 会话交接）

> 来源：2026-11-07 会话面板空白事故的完整排查链 + 数据分层设计讨论。
> 本文档是下一会话的开工依据：背景、已完成的修复、分层原则、收敛方案、
> 待办清单全部在此，不依赖原会话上下文。

---

## 一、事故链与已完成的修复（全部已落地并验证）

当日事故是六层洋葱，逐层修复如下（全部有回归测试锁定）：

| # | 事故 | 根因 | 修复 | 锁 |
|---|---|---|---|---|
| 1 | boot 刷屏 `[webui-v3][出厂] 行缺席 wire` | auditFactoryRows 用文档短 id 对拍 wire 包全名（永假阳性）+ 装载窗误报 | `webui-row-v3.ts` 改 spec 轴对拍 + auditArmed 门闩 | webui-row-v3.test |
| 2 | 前端 404 boot-graph | apps/ui/dist 是 cutover 前旧产物 | `pnpm webui:build` 重建 | — |
| 3 | `Failed to resolve module specifier` 整页崩 | rollup 对外部化说明符的动态 import 保留原生裸 import()（无解析面） | `build-channel.mjs` 产物级改写为 require + 纯度门补扫 | 构建门 |
| 4 | 单组件崩溃 → root 退位白屏 | 选举渲染路径绕过 EntryErrorBoundary；PerspectiveHost 过滤器漏 async component loader 标签 | 三防线：MainViewHost 经 entryVNode、出口三态契约（deadCellFace）、过滤器补洞 | crash-hardening.test |
| 5 | 会话面板空白（结构在数据无） | **ESM/CJS interop 断裂**：rollup 默认导入外部化 .vue 深词无解包（`_interopDefault` 依赖 __esModule 旗标），且壳产物种子命名空间被 Object.freeze——`defineProperty` 标注静默失败 | `build-channel.mjs` interop:'auto' + `module-system.ts` markEsmNamespace（冻结 → WeakMap 记忆的可写替身） | full-mount-regression.test（真产物整树挂载）+ module-system-interop.test |
| 6 | 刷新后总落到空会话 | localStorage 残留空草稿劫持 openDefaultSingle 落点 | `hasPendingSubstance`（正文/续发 id 为准） | singles 套件 |

数据层事故：用户曾清空 `workspace/home/viewer/`（以为是全部数据）——
messages.jsonl 已用 `projectUserLedgers`（ac-import 自带投影重建器）恢复
**1017 会话 / 8667 行**；session.json（workspaceId 等归属属性）永久丢失，
穷尽了 agent 账本 / journal / 消息正文路径启发式（仅 7 个可靠）/ 回收站 /
conv-settings 四条恢复路均无系统性来源。

---

## 二、分层原则（本次设计讨论的结论）

按"丢了能不能重建"分三层，操作规则只由耐久性轴决定：

```
第一层 真值   agents/<id>/sessions/        消息、运行记录     → 必须备份
第二层 属性   meta/*（拟建）               用户域源数据        → 必须备份
第三层 投影   viewer/sessions/*.jsonl      纯派生             → 整树可删、boot 自愈
```

事故本质：第二层（session.json）寄生在第三层目录里，"清投影"连源数据一起清了。
对照组：conv-settings/ 住在投影树外，1123 项毫发无损。

**三条操作边界**（boot doctor 的校验依据）：
1. 可整树删：只有 `viewer/` 和 `.runtime/`；
2. 必须备份：`agents/`、`meta/`、`credentials/`、`files/`、`file-snapshots/`、`sap-adt/`、`outbox/`；
3. 删了静默丢功能：`outbox/`（在途 run——名字像运行态实为 durable 队列）、`credentials/`、`meta/remote/`（配对失联）、`timer/state.json`。

## 三、第二层形态决策

对比过五种形态，结论：

- **主存储 = 每会话单文件**（`meta/sessions/<sid>.json`，conv-settings 模式）：
  单文件原子写、坏一个丢一个、可 grep。单文件 JSON 清单被否——单点爆炸半径
  是本次事故复刻；JSONL 事件溯源留作未来升级路径；SQLite 过重；localStorage 是
  隐藏的同风险层（agentchat.pendingSingle / drafts / lastContext / theme 在此，
  清浏览器数据即丢——草稿正文值得后续迁服务端）。
- **兜底 = 账本 header 下沉创建时不可变事实**（初始 agentId / 创建时间 /
  创建时 workspaceId 记入 agents 侧 header 行）。只放不可变事实，可变属性绝不双写。
- **conv-settings 不合并文件、只统一父目录**：保持单写者（D12 纪律），
  生命周期不同步反而是优点（它连死会话都留着，1123 > 1020）。

## 四、收敛后的目标形态

```
workspace/home/
├── agents/                  第一层：真值账本
├── meta/                    第二层：小而珍贵、不可重建
│   ├── sessions/<sid>.json       （自 viewer 迁出）
│   ├── conv-settings/            （自根级挪入）
│   ├── groups/                   （自根级挪入）
│   ├── timer/state.json          （自根级挪入）
│   ├── remote/                   （自根级挪入——配对身份/设备绑定）
│   ├── workspaces.json           （自根级挪入）
│   └── profile/                  （仅用户编辑件，如 webui-custom.patch.yml）
├── credentials/             第二层特殊成员：独立隔离（加密/备份策略不同）
├── viewer/                  第三层：整树可删，boot 对账自愈
├── usage/                   派生流水（半可重建）
├── files/ file-snapshots/ sap-adt/   工作产物（第一层附件）
├── profile/                 装配文档（生成物，用户编辑件迁走后剩生成物）
├── outbox/                  durable 队列（勿清！）
├── .runtime/                运行态（随时可丢，. 前缀自解释）
└── config.json              全局配置（留根级）
```

物理重组仅限 meta/（它直接对应操作规则），其余分类**契约化而非物理化**：
数据根分类表 + 三条操作规则写成 `docs/design/data-root-layers.md`，
boot 时 doctor 扫顶层未知目录 warn。不深挪（usage/files 等）——不改任何
操作规则，却付全部行代码路径迁移成本，且可能破坏 mobile/remote 写死的路径。

## 五、待办清单（下一会话开工项，按优先级）

1. **boot 对账自愈**（最便宜收益最大）：宿主启动跑一次 `projectUserLedgers`
   （幂等只补缺席；现仅 importRoot 调用）。落点：apps/host/boot.ts web 面装配后，
   或 ac-host-webui/host-web.ts。做完"清 viewer"降级为"丢属性不丢消息"。
2. **session.json 迁居**：singles 行（packages/ac-host-rows/src/singles-row.ts）
   读写点改 `meta/sessions/`；读侧兼容旧位置（viewer/sessions/<sid>/session.json），
   写侧只写新位置，旧文件不搬（读旧写新兼容窗，等版本后清理）。registry
   （.singles-registry.json）是派生缓存，留在 viewer 不动。
3. **conv-settings / groups / timer / remote / workspaces.json 挪入 meta/**
   （第二批）：各读方分散在对应行（timer 行、remote-link 行、workspace 行），
   每处"改路径 + 兼容读旧"，触点多于第一批。
4. **data-root-layers.md 契约文档 + boot doctor**（零迁移成本，可先行）：
   分类表 + 三条操作规则 + 未知顶层目录 warn。
5. **（远期）账本 header 加创建事实字段**（格式演进，需兼容旧 header）；
   **（远期）localStorage 草稿正文迁服务端第二层**。

## 六、附带的环境事实（下一会话可能用到）

- dev 形态：`pnpm dev`（supervisor，web 3830）；单数据根单宿主（IPC 锁），
  dev:fg 与 dev 不能并存；数据根 = workspace/home。
- 宿主未接 `watch: true`（webui-row-v3 的产物重建探测），通道产物重建后
  wire rev 不更新——**dev 期重建通道/壳后需重启 pnpm dev**（本次反复踩）。
- 重建通道：`node apps/ui/scripts/build-channel.mjs`；壳：`pnpm webui:build`；
  全量验证：`node scripts/run-tests.mjs unit`（384 文件）+ `pnpm typecheck`
  + `pnpm webui:typecheck`。
- 投影重建器用法（幂等）：
  `import { projectUserLedgers } from 'packages/ac-import/src/user-projection.ts'`，
  传数据根绝对路径。只补缺席（viewer 侧已有 messages.jsonl 即跳过），
  入投影条件：kind=user 或 agent-pair 且 participants 含 user。
- WS RPC 探针（数据面验证）：连 ws://127.0.0.1:3830/ws 发
  `{type:'rpc/call',data:{method,requestId,params}}`，收 rpc/result。
  singles/list / session/history 可直接打。
```
