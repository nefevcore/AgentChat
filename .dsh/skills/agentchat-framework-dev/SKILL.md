---
name: agentchat-framework-dev
description: 开发 AgentChat 框架本身（preview/ 轨道）：新增或修改能力域服务、契约与事件目录、注册中心、组合根。面向"造插槽"的人——决定什么成为 Service、什么成为事件、什么留在纯库。
whenToUse: 任务涉及修改 preview/ 下的能力域服务、契约与事件目录（ac-llm/ac-tools/ac-agents/ac-router/ac-agent-loop/ac-conversation/ac-session/ac-plugin-registry 等）、cordis.yml 组合根、新增一个能力域、或实施 M24/M25 方案（词汇收口/全局默认层/事件治理/行树治理）时使用。若只是写一个消费已有服务/事件的插件行，改用 agentchat-plugin-dev 技能。
---

# AgentChat 框架开发（preview/ 轨道）

## 心法：元框架思维

Cordis 是**用于构建框架的框架**。AgentChat 框架的开发不是"写一个类库"，而是
**交付一组可独立摘除的插件行 + 一份契约**。每次改动前先问：

> 摘掉这一行（或换掉实现方），依赖它的其他行能否由 cordis 自动回滚重载、零改动地恢复工作？

- 能力域 = 一个服务包（`ctx.<key>`）+ 若干生态薄行。服务是插槽，薄行是插头。
- 旧轨（`src/`）的教训：有了 cordis 的壳（Service 类、apply 函数），但能力间仍靠
  直接 import 实例、手动编排顺序、跨插件传引用——这些全是本轨道红线。
- 本轨道事实源是 `preview/README.md`；改动涉及布局或链路时同步更新它。

## 仓库地图（事实源索引）

| 内容 | 文件 |
|---|---|
| **全域能力地图（本轨道事实源：25+ 域契约归属总表 + 纯库清单 + 端到端链路 + 装载态四层）** | `preview/README.md` |
| LLM 域契约（域类型 + llm/* 事件目录，含 delta-* 流式细分） | `preview/ac-llm/src/{contract,events}.ts` |
| 工具域契约（域类型 + tool/* 事件目录，含 transform-result 变换） | `preview/ac-tools/src/{contract,events}.ts` |
| 循环域契约（域类型 + loop/* 事件目录；sender/conversationId 信封拓扑） | `preview/ac-agent-loop/src/{contract,events}.ts` |
| AgentConfig / RouterInbound+RouterSendOptions + router/* 事件 | `preview/ac-agents/src/service.ts`、`preview/ac-router/src/{service,events}.ts` |
| 扩展四件套（事件化插件标杆） | `preview/ac-{persona,system-prompt,session,memory}/src/index.ts` |
| 注册中心范例（fiber 归属 + 懒实例化 + 路由） | `preview/ac-llm/src/service.ts` |
| 注册中心范例（waterfall 执行链：before → 实现 → transform → after） | `preview/ac-tools/src/service.ts` |
| 循环服务（边界全事件化） | `preview/ac-agent-loop/src/service.ts` |
| 纯转道路由（agents 信封投递 + 事件通知，零会话状态） | `preview/ac-router/src/service.ts` |
| 纯库范例（零 cordis 依赖） | `preview/ac-openai-completions/src/index.ts` |
| 配置驱动组合根 | `preview/cordis.yml` |
| 程序化组合根（测试用，行集须与 yml 一致） | `preview/ac-app/src/index.ts`（TREE/bootTree） |
| boot 入口（官方路径：内联 bin.js；M23 patch 层注入；M25 boot 末清扫触发认领点） | `preview/ac-app/src/boot.ts` |
| **src 能力全景 → preview 重写地图**（逐包映射/ADR/事件演进/里程碑 M9-M15） | `preview/docs/src-to-preview-map.md` |
| 会话域深设计（消息定义/落盘/三种会话形态/KV 缓存/回放正确性） | `preview/docs/session-design.md`、`preview/docs/m21-replay-prefix-cache-plan.md` |
| M23 Agent 自开发插件方案（✅ 已落地；P7 热通道后置归 M25 收编） | `preview/docs/m23-agent-plugin-plan.md` |
| **M24（✅ 已实施）**：X1 词汇收口 / A1 全局默认层 / X2 目录 IA / X3 市场首期 / X4 能力收敛 / X5 audit 轮转 | `preview/docs/m24-global-defaults-plan.md`（+ 审查档案 `m24-m25-review.md`、UI 原型 `m24-m25-ui-prototype.html`） |
| **M25（✅ 已实施）**：@scope 作用域 / agentOf 读取器 / agentGate 门控 / ac-event-policy 治理 / 行树治理（热通道 setPatch hot 态） | `preview/docs/m25-event-governance-plan.md`（vendor 落点：`src/vendor/cordis/src/events.ts`[internal/listener + EventOptions.description 监听器自述]、`src/vendor/loader/src/config/{group,tree}.ts`[并发模型]、`src/vendor/include/src/index.ts`[热通道]） |

## 三层架构（目标蓝图）

AgentChat 核心框架分三层，外加插件扩展与可视化（源自 src 轨道经验的
再设计；src 参考 `src/core/agent-loop`、`src/agent-*`）：

```
L3  ac-agents + ac-router   信封投递：user⇄agent / agent⇄agent / group / event⇄agent
L2  ac-agent-loop           编排：turn（本轮）→ [step（本步）→ 推理/工具 → 收束]
L1  ac-llm (+三个适配薄行)   一次 step 会话：stream/chat 聚合
```

- **L1 llm**：一个 step 的模型会话（reasoning_content / tool_calls / content
  聚合）。纯路由 + 懒实例化；协议住纯库（ac-openai-completions）。
- **L2 agent-loop**：编排序列 `turn 开始 → [step 开始 → reasoning/tool_calls/
  content → 工具执行 → step 结束]×N → turn 结束`。preview 事件词汇映射：
  **run ≡ turn**（`loop/before-run`/`after-run`）、step（`loop/before-step`/
  `after-step`）、工具执行复用 `tool/*` 拦截链。src 的流式细分事件
  （thinking/message/toolcall token 级）是 UI 层的前置需求，尚未引入。
- **L3 agents + router**：Agent 是数据（ac-agents），router 纯转发——按
  **信封**投递。信封已含 agentId + messages + history；拓扑扩展方向：
  发送方身份（user/agent/event）+ 会话键（group 共享），支撑四种会话形态
  （user⇄agent 直答、agent⇄agent 委托、group 共享会话、event⇄agent 触发）。

### 插件扩展钩面（src hooks → preview 事件映射，已全部落地 M4）

四个标杆扩展插件在 preview 中的落点全部是事件监听，**无需给 loop 加任何
专有 hook 机制**（已实证）：

| 扩展插件 | src 钩子 | preview 落点 | 姿势 |
|---|---|---|---|
| ac-persona（人设注入） | runStartHook 改 systemPrompt | `loop/before-run` waterfall | 从 `AgentConfig.hooks['persona']` 读取（经 ctx.agents 按 request.agent 查询），前置 `<persona>` 块后 `next()` |
| ac-system-prompt（框架块） | runStartHook 装配 systemPrompt | 同上 | 追加 `<framework>` 块；与 persona 顺序无关收敛 |
| ac-session（历史/概要） | runStart 加载 + stepEnd/runEnd 落盘 | `router/message-received`/`reply-completed` emit 积累（按 conversationId 分桶）+ `history()` 回放 | "事件积累 + history 回放"模式 |
| ac-memory（记忆注入） | runStartHook 追加 memory | `loop/before-run` waterfall | `<memory>` 块追加到 system 末尾；记忆存 `ctx.memory`（set/get） |

**hooks[具名]（per-Agent 扩展管控，src hooks/命名空间配置的 preview 形态）**：
`AgentConfig.hooks?: Record<string, unknown>`——键 = 扩展插件名（如
`'persona'` / `'memory'`），值 = 该插件在本 Agent 上的配置（形状由插件自定）。
分工铁律：**行组合（cordis.yml/TREE）决定装哪些插件；hooks 决定已装插件
在该 Agent 上的行为**。核心 AgentConfig / LoopRunRequest 不为任何扩展插件
设专属字段（防提前耦合）；扩展插件经事件按 `request.agent` 查
`ctx.agents.get(id)?.hooks?.['<name>']`。

词汇预告（M24 X1 未实施）：配置面概念保留、`hooks` 词汇全链退役改名
**`settings`**（键承载锚点不变 = 行名 / 动态插件 manifest.name，容器零本体
承诺）；落地时从 `AgentConfig` **类型删除旧字段**强制迁移。详见
「M24/M25 前瞻」。

工具侧：src toolExecutionStartHook（拦截/改参）≡ `tool/before-execute`
waterfall；**toolExecutionEndHook（结果变换）≡ `tool/transform-result`
waterfall**（变换载体 `payload.result`，after-execute 通知变换后终值）。

循环侧（M8）：**src 的"事后审查/变换" ≡ `loop/transform-step` /
`loop/transform-run` waterfall**——步记录与轮结果的安全审查/脱敏 seam
（变换载体 `payload.step` / `payload.result`；after-step/after-run 保持
emit 纯通知且通知变换后终值，观察者无法破坏事实值）。模式统一为
`before-*（决策）→ 主体 → transform-*（塑造记录）→ after-*（通知）`。

maxSteps 双模式（对齐 src）：`>0` = trigger 上限（finish='max-steps'）；
缺省/`0` = receive 不限步（靠"无工具调用"自然收束）。

流式细分：`llm/delta-start` / `llm/delta`（正文/推理/工具分片同一通道）/
`llm/delta-end`（finally 保证）——ac-llm 在 stream/chat 产出 chunk 时
发射（谁流谁发），loop 不重发。

信封拓扑（M5 已落地）：`LoopRunRequest.sender`（'user'|'agent'|'event'）
+ `conversationId`（1v1 缺省 agentId；group 共享组键——ac-session 按
conversationId 分桶，组内消息 name 标注来源 agent）。`hooks[具名]`
**不进信封**——扩展插件自行经 agents 查询。

### 可视化层

UI/Web 对接（M13 已落地）仍是"事件订阅 + RPC 面"，核心域零 UI 知识：
ac-web-server 传输基座（HTTP 路由注册 + WS 广播 + RPC 显式注册）→
ac-ws-bridge 把 emit 面（`router/*`、`loop/*`、`llm/delta-*`）桥接成 WS 帧
→ ac-web-api 薄编排行注册业务 RPC → webui/ 前端。桥接/编排行不 inject
核心服务内部态。

## 重写规约（src→preview 地图提炼，全文见 preview/docs/src-to-preview-map.md）

对齐 src 功能时的五条铁规（四域审查收敛）：

1. **持久化 owning service**：每个持久化域归 owning service（ac-session 拥有
   会话文件格式、ac-memory 拥有记忆存储、ac-timer 拥有自身状态文件、
   ac-agent-store 拥有 Agent 数据目录）。**禁止跨域越权写**（src 教训：
   timer 直写 config.json、workspace 直写会话文件）。跨服务读取一律走
   服务方法或 type-import。
2. **conversationId 寻址不变量**：一切会话态按 conversationId 寻址
   （src 三次串台 bug 的教训）。存储文件名即 conversationId，淘汰
   chat~lo~hi 排序魔法与 group~ 前缀判别；群/1v1 差异在视图层。
3. **机制任务不过 LLM**：归档/备份等机制任务直调服务方法（淘汰
   `__xxx_all__` 字符串协议）；"触发 Agent 干活"统一 `sender:'event'`
   信封投递，事件痕迹自然进会话流。
4. **hooks[具名] 软停用约定**：行摘除是进程级的；per-Agent 关闭已装插件
   = `hooks['<名>'].enabled = false`（插件须自查）。per-Agent 插件启停
   缩水（资源型插件无法 per-Agent 不装载）是 **ADR-4 显式接受的代价**。
5. **变换落 transform，观察落 after**：安全审查/脱敏/结果改写必须落
   `transform-*` waterfall（after 是纯通知，改了没人消费）；策略拦截落
   `before-*`。事件模式完整形：`before-*（决策）→ started（通知）→
   transform-*（塑造）→ after-*（通知终值）`。

新增能力域前先查重写地图 §3 逐域映射表与 §6 里程碑——多数"新"能力
在 src 已有踩坑沉淀（地图 §4 资产清单），形态按地图落点走。

## 五个设计决策（改框架前必须过一遍）

1. **能力调用 → Service 方法**。要返回值、要依赖保证、要同步可用：做成
   `ctx.<domain>` 上的方法，消费方 `inject` 声明依赖（如 `ctx.llm.chat()`）。
2. **拦截/改写/否决 → waterfall 事件**。可变载体（`XxxCall` 对象）沿链传递，
   监听器变异载体后 `next()` 委托，或不调 `next()` 短路（veto）。参照
   `loop/before-run`、`llm/before-chat`、`tool/before-execute`。
3. **纯通知 → emit 事件**。多方订阅、发送方不关心谁在听（历史/审计/WS 广播）。
   参照 `router/message-received`、`loop/after-step`、`tool/after-execute`。
   emit 与 waterfall 是事件公开约定的一部分，**新增事件必须二选一并写进目录**。
4. **协议实现/重算法 → 纯库包**。零 cordis 依赖（如 `ac-openai-completions`），
   薄行只留 inject+register 胶水。纯库可被多个薄行共用、可独立单测。
5. **实例 → 数据，不是插件**。Agent 是注册表里的数据（`ac-agents`），
   不是每实例一个插件行。会话历史不归 router（纯转发、零会话状态）：
   调用方经 `options.history` 提供此前消息，跨插件积累走 `router/*`
   事件（已落地 = ac-session，按 conversationId 分桶）。

推论：**禁止**在 apply 里 `if (ctx.xxx)` 探测可选服务再注册副作用——用
`inject`（硬依赖）或运行时 `ctx.get('xxx')`（可选能力），部分功能依赖独立成
子插件行。

## 契约归属纪律（谁 emit 谁声明）

**没有独立的契约包**（`ac-contracts` 已删除；旧轨 `@agentchat/contracts` 同款
教训——类型中立包让契约所有权倒置、每域契约被切成两半）。契约归属 owning
package：谁提供 `ctx.<domain>`，谁声明本域服务接口、域类型和 `domain/*` 事件，
靠 cordis 声明合并分布式注册（DSH 同款形态）。

- 每个能力域包内：`src/contract.ts` 放域类型（含 waterfall 可变载体接口），
  `src/events.ts` 放本域事件目录；单一类型的小域可直接进 `service.ts`。
- `index.ts` 契约出口固定两行：`export type * from './contract.ts'` +
  `export type {} from './events.ts'`——消费方 `import type {} from '<pkg>'`
  一行拿到服务类型、域类型与事件增强（type-only，运行时零依赖）。
- 跨域词汇（如 loop 用 `LlmMessage`）type-import 自 owning 包，记
  devDependencies——类型层认识，运行时仍按服务 key 解耦。
- 防撞靠 `domain/action` 命名约定（param-case、`before-xxx` 配对），
  **不靠**集中式唯一文件；声明合并本就是为分布式设计。
- 每个事件 JSDoc 必须标注 `@mode waterfall` 或 `@mode emit`，并写明：
  - waterfall：载体的哪个字段可变异、不调 `next()` 的短路语义是什么；
  - emit：载荷含义、谁该订阅。
- 新增事件同时预写 `@scope run | host`（M25 目标态，P1 将对全部 owning 包
  全量补标）：判定式 = "**这次分发发生在谁的执行里**"——答得出唯一 Agent
  的为 run 域（loop/*、tool/*、router/*、llm/*、conversation/steered），
  答不出的为 host 域（config/changed、plugin/*、webui/*、ws/*、
  job/settled、agents/updated、group/*、singles/updated…）。**载荷提到
  agentId ≠ run 域**（agents/updated 带 agentId 但发生在宿主上下文）。
  run 域才有 agentOf 读取器——门控可用性由作用域结构性编码。
- emit 事件**末参永不为函数**（M25 agentGate 末参函数判定的前提锁定，
  目录静态检查测试随 P1 落地）。
- **观察/标注型 waterfall 监听器必须调 `next()`**——不调就是静默吞掉下游全部
  默认行为。这条写进每个 waterfall 事件的 JSDoc。
- 本 cordis 的 `next()` **不携带参数**：改写输入的唯一方式是变异载体
  （`call.input = { ...call.input, model }`），实现侧必须在 waterfall 返回
  **之后**才读载体字段（路由发生在拦截之后）。

## 注册中心实现规范

照 `ac-llm/src/service.ts` / `ac-tools/src/service.ts` 的形态：

```ts
export class XxxService extends Service {
  private items = new Map<string, Def>();
  constructor(ctx: Context) { super(ctx, 'xxx'); }

  register(def: Def) {
    if (this.items.has(def.name)) throw new Error(`xxx "${def.name}" 已注册`);
    // 注册即归属：this.ctx 经 cordis tracker 指向【调用方插件】的 context，
    // 该插件卸载时 effect 逆序执行，自动回收——插件作者零 dispose 代码。
    return this.ctx.fiber.effect(() => {
      this.items.set(def.name, def);
      return () => { this.items.delete(def.name); };  // 有外部资源时 async 清理
    }, `xxx.register(${def.name})`);
  }
  // get/has/list 只读方法；重名注册抛错而非静默覆盖。
}

declare module '@agentchat/cordis' {
  interface Context { xxx: XxxService; }
}
```

要点：

- **注册即归属**是本框架核心卖点：注册中心方法内必须用 `this.ctx.fiber.effect`
  （不是调用方 ctx.effect），返回 disposer 给需要手动撤的数据驱动场景。
- **懒实例化**重资源：register 只存工厂，首次使用才构造；disposer 里对已实例化
  对象调 `close?.()`（参照 ac-llm）。
- 执行链统一形态：`waterfall before → 真实现 → emit after`；真实现抛错收敛为
  结果对象 + after 事件带 error 参数（参照 `ToolsService.execute`）。
- 服务名占扁平命名空间，取有辨识度的域词（已占用：llm/tools/agents/router/
  agentLoop/conversation/group/session/singles/memory/config/credentials/
  agentStore/jobs/timers/archive/usage/backup/workspace/webServer/webui/
  uiExtensions/pluginRegistry/agentAdmin/skills/mcp/durableInteraction/
  browser——全量见 README 契约归属总表）。
- 包内 index.ts 是薄行：`export function apply(ctx) { ctx.plugin(XxxService) }`，
  再 re-export 服务类型。

**服务体内访问其他服务（M12 踩坑沉淀，三条铁律）**：

1. **构造器/事件闭包要访问 ctx 依赖**（raw `this`，无 traceable 包装）→ 服务类
   声明 `static inject = ['<dep>', ...]`：fiber 依赖等待 + own-fiber store 填充，
   构造期即可安全 `this.ctx.<dep>`（本 cordis 属性解析按 fiber 链 walk，raw ctx
   只认自己 inject/provide 的服务；官方 cordis-timer 的 `ctx.timeout/interval`
   混入面同样要 inject `'timer'`）。
2. **跨服务方法调用**（尤其目标是 conversation/agentLoop 这类内部还要访问别的
   服务的深链服务）→ 一律 `this.ctx.get('<name>')`：`ctx.get` 走 root-traced
   无限制解析，方法体看到的 ctx 是 root（深链依赖全部可达）。直接
   `this.ctx.<dep>.method()` 在受限调用方（另一个服务的 fiber）下会在目标的
   传递依赖处断链（"cannot get property without inject"）。
3. **常驻定时器（心跳/扫描）一律懒拉起**：有工作才 `ctx.interval`，收敛即
   dispose——空闲零定时器，`preview:boot` 才能自退（参照 ac-timer 心跳 /
   ac-archive 扫描的 syncHeartbeat/syncScan）。

## 新增能力域 checklist

1. 契约：新包 `src/contract.ts` 声明域类型（含 waterfall 可变载体接口）。
2. 事件：新包 `src/events.ts` 声明 `domain/*` 事件 + `@mode` + `@scope
   run|host` + 姿势说明（谁 emit 谁声明，跨域词汇 type-import 自 owning 包）。
3. 服务：新包 `src/service.ts` 实现注册中心；`index.ts` 加契约出口两行
   （`export type * from './contract.ts'` + `export type {} from './events.ts'`）。
4. 组合根：`preview/cordis.yml` 加行（`id` + 裸包名）；同步
   `ac-app/src/index.ts` 的 TREE，两表行集保持一致；行包 package.json
    声明 `"agentchat": { "plugin": true }` + `"keywords": ["agentchat"]`
    （目录内置组判据——纯库不加，fail-closed）。
5. 测试：`ac-<domain>/tests/*.test.ts` 覆盖注册/回收/拦截/重名。
6. 验证：`pnpm preview:typecheck && pnpm preview:test`，冒烟 `pnpm preview:smoke`。
7. 更新 `preview/README.md` 的布局图与链路图。

## M24/M25 已落地（以下各条已从前瞻转为现状 API——可直接使用）

事实源：M24 = `preview/docs/m24-global-defaults-plan.md`（✅ 已实施，原
定稿 v8：词汇收口 / 全局默认层 / 目录 IA / 市场首期 / 能力收敛 / audit
轮转）；M25 = `preview/docs/m25-event-governance-plan.md`（✅ 已实施，原
定稿 v6：事件治理 + 运行时行树治理）；审查档案 `preview/docs/m24-m25-review.md`；
UI 原型 `preview/docs/m24-m25-ui-prototype.html`。

### 现在就守的纪律（常态生效）

- **新事件预写 `@scope` + emit 末参禁函数**（见「契约归属纪律」；
  event-catalog.test.ts 静态锁定）。
- **per-Agent 配置读取收拢**：X1 已落地——`AgentConfig` 无 `hooks` 字段
  （差异层键 = `settings`；双读归一在 agent-store 加载边界）；RPC 线格式
  （`agents/assembly`·`assembly/update`·`update-config` 的
  `patch.settings`）；`ac-agent-admin` 的 `ALLOWED_FIELDS` 与 `ac-web-api`
  的 `CONFIG_KEY_PREFIXES`（含 `settings` 键）已同步。
- **行名 / manifest.name = 配置键锚点**：settings 键承载锚点是稳定单元名，
  行名即公开承诺——改名 = 破用户配置。
- **不碰 `internal/listener` seam**：该 bail 单链仅 ac-event-policy
  策略行可用（其余行注册即红灯；vendor 自带消费者除外；policy.test 静态断言）。

### M24 关键落点（✅ 已实施——照方案 §2/§3 的批次语义）

- **A1 全局默认层**：config.json 新白名单域 `settings`（`{ '<行名>': 全局
  默认 }`，`enabled` 合法且 Agent 差异层可覆盖回 true）+ 合成口
  `AgentsService.settingsOf(id, name?)` =
  `deepMerge(config.settings[name] ?? {}, agent.settings?.[name] ?? {})`——
  与 `agents/update-config` 同源语义（对象递归、数组整体替换、差异层键
  优先）；preset/未知 id 回落全局层；`get()` 保持差异层原样；冻结坑守卫 =
  合成 → get-config → update-config 回写后差异层不出现仅存于全局层的键。
- **X2 目录 IA**：`plugin/catalog` RPC——内置组 = **包源清单**（dev 扫描
  `preview/ac-*/` 的 package.json 元数据[参照 rowMetaOf]，非 cordis.yml——
  yml 只答"装了什么"答不了"有什么可装"；仅收声明 `agentchat.plugin:
  true` 的行包——纯库/组合根 fail-closed 出局，行包 npm 发布时 keywords
  加 "agentchat" 承接发现面；生产 bundle 首期内置组为空 + UI
  注明）；本地组 = registry ∪ devScan ∪ 会话装载（待审暂存并入徽章态）；
  配置弹窗双实例（插件库·全局默认层写 `config/set` → `settings.<configNs>`
  [CONFIG_KEY_PREFIXES 加 `settings` 键]；Agent 装配·差异层写
  `agents/update-config` 只存差异项）。
- **X3 市场首期**：`ac-plugin-market` 行复活——npm（keywords:
  agentchat-plugin 限定）/ github（topic:agentchat-plugin）opt-in 搜索 +
  暂存 **人审**安装流（复用 M23 staging：只读代理/哈希/权限快照/来源
  锚定）；第
  三方供应链维持人审，与 Agent 自开发免审流分立。
- **X4 能力收敛**：事实源 = `AgentConfig.tags`；有效能力集 =
  `{base, agent:<id>} ∪ tags ∪ settings.security.capabilities`（后者退位为
  追加覆盖层，只加不减；收窄出口仍是 tools include/exclude）；tags 双写与
  双轨对账告警退役。
- **X5 audit 轮转**：appendAudit 写前查大小，超 5 MiB 轮转（保留 2 份，
  串行队列内 rename）。

### M25 关键落点（✅ 已实施——P1 契约与门控 → P2 清单与治理 → P3 行树）

- **before-step 补 agent**：`LoopStepCall.agent: string | undefined`（域内
  唯一身份缺口；现状消费者 0，纯加法；不加 envelope——各按真实需要出生）。
- **agentOf 命名读取器住 owning 包**（ac-agent-loop×5 / ac-tools×2 /
  ac-router×1 / ac-llm×2[meta.agent 通道] / ac-conversation×1）：签名直接用
  自家 contract 类型——载荷变形在**定义处** typecheck 红，而非散落消费者
  静默漂移；防御性短路 undefined → 门控 fail-open。无身份的事件不出读取器
  （agentGate 签名强制传 agentOf → 无身份事件编译期不可门控）。
- **ac-gate-core（新纯库包）**：`agentGate(ctx, pluginName, agentOf, inner,
  {facet?})`——软依赖 `ctx.get('agents')`（无 agents 服务的组合恒放行；
  事件闭包不用裸 `ctx.agents`，M12 铁律 2）；waterfall 停用 =
  `return next()`（末参函数判定——"忘调 next()"反模式从根上消灭）；emit
  停用 = 跳过；facet 切面子键 `settings[名][facet].enabled ??
  settings[名].enabled`（子键覆盖回落行为级；facet = 作者命名的稳定行为
  承诺，**非事件名**——不引入事件名键：治理键 stale = 良性 no-op，
  per-Agent 事件键 stale = 行为静默回退，后果不对称）。
- **ac-event-policy 策略行（进程级治理）**：`internal/listener` bail 吞
  注册（`this.fiber?.name` 定位注册方；键 `` `${owner}::${name}` `` 命中
  停用集 → 返回替代注册 `() => true`，监听器从未进 `_hooks`；**吞注册 ≠
  veto**——剩余监听器自动构链照常跑）。boot 覆盖三件套：拦截（管就位后
  的一切注册）+ **boot 末一次性清扫**（行序 ≠ 激活序——loader 并发创建行、
  fiber 各自激活无屏障；触发 = `ac-app/src/boot.ts` 组合根收敛后调用，
  bootTree 测试路径直调）+ 策略行 reload 自追清扫（幂等，窗口极窄）。
  `internal/*` 恒放行防自锁；停用键存 config `events.disabled: string[]`
  （owner 原文；P3 聚合只改呈现不改键、匹配对 fiber 名与行名双命中）；
  热更只影响后续注册（已注册条目等重载/重启）。新 RPC
  `events/descriptions`·`policy-list`·`policy-set`；事件/监听器描述声明制
  （**A1 注册制目录已落地 2026-08-31**：EXTENSION_CATALOG 静态表退役——
  行包入口模块自述 `export const extension: ExtensionMeta`（契约住纯库
  `ac-extension-core`），ac-web-api `collectExtensionCatalog` 扫 cordis
  registry 聚合（vendor `Runtime.plugin` 检视面）；监听器级
  `{event, 描述, 角色, facet, respectsEnabled?}`；manifest provides.events 扩展
  `Array<string | {name, description}>`）；全量事件清单以声明目录为准
  （events/listeners 天然漏零监听器事件）。**新增可配置行 = 入口加
  extension export，不改消费方**。
- **行树治理（M23 P7 收编）**：fiber→顶层行聚合（匿名 fiber 继承父名的
  假边归并；只改呈现不改键）/ 反依赖图（fiber 名 × `fiber.inject` 键集
  传递闭包）+ 停用承重行级联警告 + 保护行（security/plugin-gates 二次确认
  特殊文案）/ yml 行熔断（`internal/status` 订阅，FAILED ≠ 级联 PENDING；
  失败 ≥3 写 patch disable，setPatch 再启用清计数）/ include 热通道
  （`fiber.update` 事务化行树变更、失败回滚 + `setPatch` 返回 hot 态；
  **F10 写回守卫维持**——patch-set + 树操作后 cordis.yml 字节不变）。

缩水红线（两案显式接受，勿"顺手恢复"）：监听器优先度/重排不做；**单个
监听器粒度永不做**（监听器无稳定 id，治理面 (插件 × 事件) 是最小稳定粒度）；
签名形态统一不做；治理面不按 Agent 细分（per-Agent 细分归 agentGate 的
行为/facet，两层不混）；注册制目录已按 A1 落地（模块自述 export 形态——
apply 时注册 schema 的重机制仍不做）；capabilities 不做减法语义。

## 兼容性红线（Node 原生 TS strip-only 加载器）

- 包内相对导入**必须写显式 `.ts` 扩展**（`from './service.ts'`）。
- 类字段**不用参数属性**（`constructor(private x: X)` 禁止；显式赋值，参照 `LlmError`）。
- `verbatimModuleSyntax`：纯类型导入必须 `import type` / `import type {}`。
- cordis.yml 的 `name` 支持裸包名（经根 node_modules workspace 链接解析，
  `pnpm-workspace.yaml` 已含 `preview/*`）与 `'./相对路径.ts'` 两种。
- 每行**必须带稳定 `id`**：无 id 的行在 yml 每次编辑时被当作先删后加整体重挂。
- **运行时依赖必须在 package.json 显式声明**——禁止靠 workspace hoisting 隐式
  生效（src 教训：composition.ts 用 js-yaml 未声明，换包管理器/隔离安装即断）。
- hmr 行默认 `disabled: true`（构造需 `--expose-internals`）；运行时启用走
  include patches，不写回 yml。

## 反模式（发现即改）

- 应用层出现 `EventEmitter` / 自建 listener 数组 —— 一律换 `ctx.on`。
- 插件 A import 插件 B 的实现类/实例 —— 一律换服务方法或事件。
- 注册中心方法自己管理生命周期（要求调用方传 dispose 回调、忘了 fiber.effect）。
- waterfall 实现在拦截**之前**读载体字段（改写失效）。
- 用行序/启动顺序表达依赖 —— 一律 `inject` 声明，行序仅是装配一览。
- 在 emit 事件上收集返回值，或在 waterfall 上做无返回值广播（模式是约定）。
- 集中式契约包（域类型/事件声明中立于 owning 包之外）——契约归属
  owning package（`ac-contracts`、旧轨 `@agentchat/contracts` 均已废弃）。
- 事件在非 owning 包里声明合并（`domain/*` 必须住在提供 `ctx.<domain>` 的包）。
- 跨域越权写文件（A 域服务直写 B 域的数据文件）——持久化归 owning
  service，跨域走服务方法（src 教训：timer 直写 config.json）。
- 脱敏/结果改写落 `after-*`（纯通知，改了没人消费）——变换必须落
  `transform-*` waterfall。
- 读取 per-Agent 扩展配置仍用旧 `hooks` 词汇（X1 已退役——读配置一律
  `ctx.agents.settingsOf(id, '<名>')`，直读差异层用 `get(id)?.settings`）；
  自造门控壳不用 `agentGate`（ac-gate-core 现为正式 API）。
- 新增事件不判作用域（run/host 编码门控可用性）；emit 事件末参出现函数
  （破坏 agentGate 末参判定前提——event-catalog.test.ts 静态锁定）。
- 抢用 `internal/listener` bail seam（仅 ac-event-policy 策略行可用，
  其余行注册即红灯）。
