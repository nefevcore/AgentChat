# 多表面与单会话改造实施指引（next session 用）

> 产出于 2026-08-18 深夜的设计 session（dsh 比对完成后）。
> 本文是**实施计划**，不含已完成工作。背景见 `docs/architecture.md` §3（组合）、
> `docs/plugins/market.md`（市场）。上一 session 末提交：`7303c9d`。
>
> 三个目标按依赖序排列：**P1 profile 拆分 → P2 共享后端 → P3 单会话**。
> P1 最小无风险先做；P3 最大（前端为主）最后做。每个目标独立可交付、可提交。

---

## P1. profile 拆分：`npx agentchat web` 成立的前提

### 动机

当前 bundle（`src/boot/boot/src/composition.base.yml`）把 `webui` 行焊死在宿主组合里。
P2 要引入 tui/headless 表面，它们不该 boot HTTP 服务器。参照 dsh 的
`PROFILE_TEMPLATES`（tui/web/headless 各自的 bundle 集合），把"表面"从 bundle 里拆出来。

### 改动清单

1. **拆 bundle 文件**：
   - `composition.base.yml`：移除 `webui` 行；`boot-finalize` 的 `enableWebUI: true`
     改为缺省（保留 webuiPort 缺省 3830）。
   - `composition.web-app.yml`（新增）：一条 insert——`webui` 行 + （如需要）
     `boot-finalize` 的 `enableWebUI: true` config 覆盖。
2. **组合引擎**（`src/boot/boot/src/composition.ts`）：
   - `ComposeOptions` 增加 `profile?: 'base' | 'web-app'`（后续扩展 tui/headless）；
   - `composeLayers` 按 profile 叠 bundle 层（base → surface bundle → market → 用户层…，
     bundle 内多文件保持数组序）；
   - `bootComposed` / `dumpComposedYaml` 透传 profile。
3. **CLI 接线**：
   - `loader-boot.ts`：`--profile` 旗标（缺省 web-app，向后兼容）；
   - `bin/agentchat.js`：`agentchat web` → dev 场景回退 tsx 直跑
     `loader-boot.ts --profile web-app`（P2 再接 connect-or-boot）；
   - `package.json` dev 脚本不动（cwd 即 profile 目录的语义不变）。
4. **codegen 跟进**（`scripts/gen-bundle-rows.mjs`）：
   - 接受多个 bundle 文件（base + web-app），行 id 全局唯一校验跨文件；
   - `bundle-rows.gen.ts` 消费方（register-core/bootstrap）不需要变——dist 路径
     仍按全量行取用（webui 行进生成物；dist 是 web 形态发布）。
5. **测试**：composition.test.ts 补 profile 语义（base 无 webui 行 / web-app 有）；
   gen 一致性测试适配多文件。
6. **文档**：architecture.md §3 组合图加 surface 层；plugin-system.md §2 补 profile。

### 边界与注意

- **不要**为不存在的 tui/headless 预建 bundle 文件（克制；P2 落地时加）。
- `--dump-config` 的 default 模式语义 = "当前 profile 的宿主出厂态"，profile 进参数。
- cordis.yml 空根注释里提示可用的 profile 名。

---

## P2. 多入口共享一个后端（实例唯一）

### 语义设计（先想清楚再写码）

`agentchat web`（owner）启动后端并写实例注册表；`agentchat tui/headless`（client）
读注册表、连 WS、**不 boot 组合树**。dsh 没有做这件事（它的多 profile 是多进程
多树）；这是 docker daemon/cli 模式，比 dsh 走得远，但对 AgentChat 顺理成章——
**WebUI 本来就是后端的 WS 客户端，tui 只是第二个客户端**。

```
agentchat web        → bootComposed(profile=web-app) → 监听 :3830
                        → 写 workspace/instance.json { pid, port, profile, workspaceHash, startedAt }
agentchat tui        → 读 instance.json → pid 活着？ → 连 ws://127.0.0.1:<port>
                        pid 死了/无文件 → 报错提示先起 web（不做隐式 boot）
agentchat headless   → 同 tui + 「提交一轮 → 流式打印 → 退出」
```

### 现状锚点（都确认过）

- **单实例锁已有先例**：`timer-instance.lock`（`src/svc/timer/src/timer.ts:323`）
  当前语义是"锁住不调度"（告警噪音）。升级为实例注册表后，第二实例不再 boot
  （P2 语义下根本不会有第二个树），该告警自然消失——**顺带清理**，不要保留双轨。
- **WS 并发客户端已支持**：WSHandler 按连接管理（"共 N 个"日志），会话键
  `connId:agentId`（`src/host/server/src/ws/handler.ts:264`）。
- **客户端协议现成**：`@agentchat/protocol` + RPCBridge（WebUI 在用）。
  headless 缺的只是 CLI 侧消费（连 WS、chat 流端点、stdout 渲染）。

### 改动清单

1. **实例注册表**（新，建议放 `src/boot/boot/src/instance.ts`）：
   - boot 成功后写 `workspace/instance.json`（原子写 tmp+rename）；
   - 字段：pid / port / profile / workspaceDir 绝对路径 / startedAt / node 版本；
   - 退出时（gracefulShutdown 钩子）删除；残留文件由"pid 活性检查"兜底
     （`process.kill(pid, 0)`，Windows 上 ENOENT/EPERM 语义注意）。
2. **connect-or-boot 客户端工具**（新，`src/boot/boot/src/connect.ts`）：
   - `findInstance(workspaceDir)` → { alive, port, pid } | null；
   - WS 连接重用现有协议握手（agent.list 等已有方法名见 `core/api/endpoints`）。
3. **CLI 接线**：`bin/agentchat.js` 分发——
   - `web` → boot（owner）；
   - `tui` / `headless`（先做 headless，tui 需要选 TUI 框架，单独决策）→ connect；
   - 连不上：明确报错 + 提示 `agentchat web`（**不做隐式 boot**，避免双 owner）。
4. **多客户端并发语义（产品决策，实施前问用户）**：
   - 两个客户端同时向同一 Agent 发消息：允许（消息按到达序处理，会话快照
     按连接隔离——现状 WSHandler 已如此）还是互斥？
   - 建议第一版：允许并发读、写不互斥（最简单，与现状 WebUI 多标签页一致）。
5. **测试**：instance.ts 单测（写/读/活性/残留清理）；connect.ts 用迷你 WS 服务
   模拟；e2e：boot → instance.json 存在 → kill → headless 报错路径。

### 边界与注意

- **不要**一上来做独立 `agentchat daemon`（三进程生命周期管理是过度设计；
  web=owner 够用到 tui 真实使用出现瓶颈）。
- headless 的"跑完即退"要处理：后端 Agent 会话仍在进行时的客户端退出语义
  （后台任务中断？— 对齐现有 WebUI 关闭标签页行为）。
- 注册表按 workspace 区分（不同 workspace 可各有一个实例；workspaceHash 入文件）。

---

## P3. 单会话（single session）：会话成为一等实体

### 语义设计

现状：会话 = 二元组通道 `sessions/chat~<lo>~<hi>`（93 个目录；群组
`group~<gid>~<aid>`）。Agent 持久、模型引用焊在 `agents/<id>/config.json`。
用户痛点：想要"每次开一个独立会话"——创建时选 Agent + 选模型，互不污染。

**三条设计边界（本 session 已论证，实施时不要推翻）：**

1. **Session = 引用 + 覆盖，不是拷贝**：
   ```
   workspace/singles/<session-id>/
     session.json   { id, agentId, model: "<池引用 或 内嵌覆盖>", title, createdAt, status }
     messages.jsonl
   ```
   - 不动 Agent 的 config.json；presets/工具集/钩子跟随 Agent 原定义；
   - 只有模型是会话级覆盖。**运行时解析白捡**：`resolveLLMPool` 已支持
     池引用字符串 / 内嵌配置 / 引用+覆盖三形态（`src/boot/boot/src/loader.ts`，
     五来源解析），session.model 直接走同一函数。
   - 反例警示：拷贝式（clone agent config）会把 presets 漂移问题引进来，不做。
2. **隔离诚实分级**——本次交付的是**历史/上下文隔离**（独立目录 + 独立会话键），
   **不含插件实例隔离**（单平面架构下所有行是宿主全局的；那需要 dsh 的 realm
   机制，明确 out of scope，写进 docs 防误解）。
3. **前端是主要工作量，后端是小活**（约 1 天 vs 3-5 天）。

### 后端改动清单

1. **会话键扩展**（`src/agents/agents/src/paths.ts`）：新增
   `single~<sessionId>` 键形态（与 chat~/group~ 并列）；history-service /
   sessions API 路径解析支持第三形态（`src/host/server/src/history-service.ts:30`
   一带的路径工厂集中改，别散改）。
2. **SinglesService**（新 cordis 服务行，建议 `src/host/server/src/singles.ts`
   或独立域包——按 §"放哪"决策）：
   - create(agentId, model?, title?) → 校验 agent 存在、model 引用可解析 →
     写 session.json + 建目录；
   - list() → 全部 single（含 lastMessageAt/title 供列表页）；
   - get(id) / archive(id)（软删，状态字段）。
3. **HTTP 路由行**（`/api/singles`，挂 L3；参照 `plugins-http` 行形态）：
   GET list / POST create / GET :id / DELETE :id(archive)。
4. **WS/路由接入**：router 对 `single~<id>` 的投递——from=user（当前登录），
     to=session.agentId，但历史键用 single~id；WSHandler 的会话键
   （connId:agentId）需容纳 sessionId 维度（建议 `connId:single:<id>` 形态，
   与现有一致只是 key 变体）。
5. **协议类型**（`@agentchat/protocol`）：SingleSessionInfo 等前端消费类型。
6. **测试**：paths 键三形态；SinglesService CRUD；HTTP e2e（http-routes-e2e
   模式）；router 投递一round 端到端。

### 前端改动清单（核心风险区）

1. **会话上下文抽象（先做，纯重构）**：ChatView/stores（`src/ui/webui/src/stores/chat.ts`
   等）现在与 from/to 二元组耦合。抽 `ChatContext = { kind: 'pair', from, to } | { kind: 'single', sessionId }`，
   现有 pair 行为零变化（用现有页面回归验证），single 走新分支。
   - **这是本次最大风险点**：先梳理再动手，建议单独一个 commit 只做这个抽象。
2. **新页面**（会话列表同级路由）：
   - 列表页：singles 列表（title/agent/时间）+ "新建会话"入口；
   - 新建弹层：Agent 选择器（吃现有 `/api/agents`）+ 模型选择器（吃
     `/api/config/pools`，显示池名；允许覆盖参数的进阶 UI 后置）；
   - 会话页：复用 ChatView（经 ChatContext 注入 single 上下文）。
3. **导航**：Sidebar/路由表加入口（与现有 pair 会话列表同层级，不替换）。

### 边界与注意

- **放哪**：SinglesService 放 `src/host/server`（复用 http/webui 接线）还是独立
  域包（对称 archive/timer 的"每域一行"惯例）——实施时与用户确认；我倾向
  server 内起（首个版本不必新域包，等第二消费者出现再拆）。
- session-id：uuid v4；目录名即 id（对齐 groups 现状）。
- messages.jsonl 格式与 pair 会话**完全一致**（MessageRecord 不变），保证
  历史渲染组件复用。
- 远期视角（不在本次）：pair/group/single 三形态统一为"会话实体"是自然的
  下一步重构方向，先立 single 再说。

---

## 实施顺序与提交切分建议

```
commit 1  P1 profile 拆分 + gen 多文件 + dump --profile      （半天）
commit 2  P2 instance.ts + connect.ts + headless CLI         （1 天，可与 P3 并行起步）
commit 3  P3 后端：paths 三形态 + SinglesService + /api/singles + 协议类型（1 天）
commit 4  P3 前端重构：ChatContext 抽象（纯重构，零行为变化）    （1 天，风险最高）
commit 5  P3 前端：列表页 + 新建弹层 + 会话页接线               （2-3 天）
```

每个 commit 独立可回滚；commit 4 完成前不动任何页面。

## 实施前需要用户拍板的三个决策点

1. P2 多客户端**写并发**：允许（建议）还是互斥？
2. P2 tui 的 TUI 框架选型（ink / blessed / 自绘）——或第一版只做 headless？
3. P3 SinglesService 放 server 还是独立域包？

## 环境备忘（Windows / 本仓库特有）

- 3830 被占：`netstat -ano | findstr :3830` + `taskkill /PID <pid> /F`
  （用户常有 dev 实例长驻；测试端口用 4831 起）。
- 测试全量：`npx vitest run`（当前 614/614 基线）；typecheck 双跑
  `npx tsc --noEmit && pnpm --filter @agentchat/webui typecheck`。
- 改 .vue 模板结构后必须 `npm run build:frontend`（vue-tsc 不查模板链序，
  曾漏过 v-else 链序错误）。
- dist 双入口打包 `pnpm build:bundle`（agentchat.mjs + cli.mjs）；
  bin/agentchat.js 优先 dist，仓库内回退 tsx。
- 市场测试插件：`nefevcore/agentchat-plugin-market-test`（激活/卸载有控制台标记，
  冒烟可用）。
