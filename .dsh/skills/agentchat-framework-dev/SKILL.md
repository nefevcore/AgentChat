---
name: agentchat-framework-dev
description: 开发 AgentChat 框架本身（src/ 轨道）：新增或修改能力域服务、契约与事件目录、注册中心、组合根（cordis.yml/ac-app/vendor 基座）——决定什么成为 Service、什么成为事件、什么留在纯库。只写消费已有能力的插件行时改用 agentchat-plugin-dev。
---

# AgentChat 框架开发（src/ 轨道）

## 心法：元框架思维

Cordis 是**用于构建框架的框架**。AgentChat 框架的开发不是"写一个类库"，而是
**交付一组可独立摘除的插件行 + 一份契约**。每次改动前先问：

> 摘掉这一行（或换掉实现方），依赖它的其他行能否由 cordis 自动回滚重载、零改动地恢复工作？

- 能力域 = 一个服务包（`ctx.<key>`）+ 若干生态薄行。服务是插槽，薄行是插头。
- 三条红线（框架腐化的起点）：能力间直接 import 实例、手动编排激活顺序、
  跨插件传引用。一律换服务方法、`inject` 声明、事件。
- 本轨道事实源是 `src/README.md`；改动涉及布局或链路时同步更新它。

## 仓库地图（事实源索引）

| 内容 | 文件 |
|---|---|
| **全域能力地图（事实源：契约归属总表 + 纯库清单 + 端到端链路 + 工具执行面 + 布局 + 装载态四层）** | `src/README.md` |
| 各域契约与事件目录 | `src/ac-<domain>/src/{contract,events}.ts`（llm/tools/agent-loop/router/conversation 等，README 总表逐域列路径） |
| 注册中心范例（fiber 归属 + 懒实例化 / waterfall 执行链） | `src/ac-llm/src/service.ts`、`src/ac-tools/src/service.ts` |
| 纯库范例（零 cordis 依赖） | `src/ac-openai-completions/src/index.ts` |
| 组合根 | `src/cordis.yml`（行集与 `src/ac-app/src/index.ts` TREE 保持一致）；boot 入口 `src/ac-app/src/boot.ts` |
| 设计档案（历史决策与裁决存档） | `src/docs/`（session-design、llm-provider-model-plan、security-access-tier-plan、tag-system-report、m30-slot-semantics-refinement-plan 等；收官过程文档冻结于 docs/archive/ 与仓库外归档根 docs-stale-2026-12——被取代的裁决不是待办，勿"顺手恢复"） |

改对应域前先查 `src/docs/` 的设计档案——多数"新"能力已有踩坑沉淀与显式
裁决点（含显式接受的缩水，勿"顺手恢复"）。

## 链路速览（完整形见 README「端到端链路」）

```
conversation.deliver（会话状态机：串行化门 + inbox 双队列〔steer / next-turn 链跑〕
  + MAX_AUTO_WAKES 防自激 + 待投持久化——崩溃/42 重启不丢）
  → router.send（纯转发，零会话状态）：waterfall 'router/before-deliver'（投递
    边界决策 seam）→ emit 'router/message-received'
  → agentLoop.run：三档装配链（before-run-first → before-run 主档 → before-run-last，
    任一档 veto 即无 run）→ [before-step → llm.chat（llm/before-chat seam +
    delta-* 流式细分）→ tools.execute（执行身份随 call；interrupt 语义化中断）
    → transform-step → after-step]×N → transform-run → after-run
  → emit 'router/reply-completed'（ac-session 按 conversationId 入账）
```

- 事件模式完整形：**`before-*`（决策/改写）→ started → 主体 → `transform-*`
  （塑造记录）→ `after-*`（通知终值）**。变换落 transform、观察落 after、
  否决落 before——新事件必须归位。
- 信封拓扑：conversationId = 对桶 `pairKey(a,b)`（自会话 = `a~a`；群 = 组 id；
  独立会话 = sid）；sender = 端点 id；source = 'user'|'agent'|'event'。一切
  会话态按 conversationId 寻址。
- 工具执行面（ac-session fail-closed checkpoint + ac-security 双轴门禁/脱敏/
  唆使防御 + elevation 穿线〔deliver → router → LoopRunRequest → ToolCall，
  只升不降〕）、工具调用模式（tc-* 会话开关——conv-settings toolMode 覆盖 ??
  toolModeOf(agent)，tc-programmatic ⇒ LLM 工具面收窄为 run_code 单工具）、
  可视化层（web-server → ws-bridge → web-api → webui）的完整装配见 README 对应节。
- 抉择组（2026-12 标签配置语义）：目录条目挂 `exclusive` 元数据（access-tier
  / tool-mode 预注册组 + browser-tier 声明组）——Agent 配置 UI 把同组 tag
  合一为下拉单选（含 exclusiveNone 缺省词——选它不落词，缺席即语义）。
  纯前端落词规则（ac-client-ui-agents/client/tagExclusive.ts 单源）；判定面
  （tierOf/toolModeOf/browser 层级门禁）全部基于「tags 含某词」原语，不动。
- `AgentConfig.settings[具名]` 管 per-Agent 行为（见 plugin-dev 技能）；核心
  AgentConfig / LoopRunRequest 不为任何扩展插件设专属字段，扩展插件经事件按
  `request.agent` 查询配置。

### 可视化层

UI/Web 对接 = "事件订阅 + RPC 面"，核心域零 UI 知识：ac-web-server 传输
基座（HTTP 路由 + WS 广播 + RPC 显式注册）→ ac-ws-bridge 把 emit 面
（`router/*`、`loop/*`、`llm/delta-*` 等）桥接成 WS 帧 → ac-web-api 薄
编排行注册业务 RPC → webui/ 薄壳 + ac-client-ui-* 前端行全族（浏览器
ClientContext——类型身份不 augment 服务端 Context，防 TS2717 撞型；
SlotRegistry 席位贡献 + boot graph 随行下发，行卸载级联收缩；与服务端
经 RPC 契约面耦合，双向可独立摘除）。桥接/编排行不 inject 核心服务内部态。

## 五个设计决策（改框架前必须过一遍）

1. **能力调用 → Service 方法**。要返回值、要依赖保证、要同步可用：做成
   `ctx.<domain>` 上的方法，消费方 `inject` 声明依赖（如 `ctx.llm.chat()`）。
2. **拦截/改写/否决 → waterfall 事件**。可变载体沿链传递，监听器变异载体后
   `next()` 委托，或不调 `next()` 短路（veto）。参照 `loop/before-run`、
   `llm/before-chat`、`tool/before-execute`。
3. **纯通知 → emit 事件**。多方订阅、发送方不关心谁在听（历史/审计/WS 广播）。
   参照 `router/message-received`、`loop/after-step`、`tool/after-execute`。
   emit 与 waterfall 是事件公开约定的一部分，**新增事件必须二选一并写进目录**。
4. **协议实现/重算法 → 纯库包**。零 cordis 依赖（如 `ac-openai-completions`），
   薄行只留 inject+register 胶水。纯库可被多个薄行共用、可独立单测。
5. **实例 → 数据，不是插件**。Agent 是注册表里的数据（`ac-agents`），不是
   每实例一个插件行。会话历史不归 router（纯转发、零会话状态）：跨插件积累
   走 `router/*` 事件（ac-session 按 conversationId 分桶）。

推论：**禁止**在 apply 里 `if (ctx.xxx)` 探测可选服务再注册副作用——用
`inject`（硬依赖）或运行时 `ctx.get('xxx')`（可选能力），部分功能依赖独立成
子插件行。

## 契约归属纪律（谁 emit 谁声明）

**没有独立的契约包**（`ac-contracts` 与旧轨 `@agentchat/contracts` 均已
废弃——类型中立包让契约所有权倒置）。契约归属 owning package：谁提供
`ctx.<domain>`，谁声明本域服务接口、域类型和 `domain/*` 事件，靠 cordis
声明合并分布式注册。

- 每个能力域包内：`src/contract.ts` 放域类型（含 waterfall 可变载体接口），
  `src/events.ts` 放本域事件目录；单一类型的小域可直接进 `service.ts`。
- `index.ts` 契约出口固定两行：`export type * from './contract.ts'` +
  `export type {} from './events.ts'`——消费方 `import type {} from '<pkg>'`
  一行拿到服务类型、域类型与事件增强（type-only，运行时零依赖）。
- 跨域词汇（如 loop 用 `LlmMessage`）type-import 自 owning 包，记
  devDependencies——类型层认识，运行时仍按服务 key 解耦。
- 防撞靠 `domain/action` 命名约定（param-case、`before-xxx` 配对），
  **不靠**集中式唯一文件；声明合并本就是为分布式设计。
- `domain/*` 事件必须住在提供 `ctx.<domain>` 的包——禁止在非 owning 包里
  声明合并。

每个事件的 JSDoc 必须标注：

- **`@mode waterfall` 或 `@mode emit`**，并写明：
  - waterfall：载体的哪个字段可变异、不调 `next()` 的短路语义是什么；
    观察/标注型监听器必须调 `next()`（这条写进 JSDoc）。
  - emit：载荷含义、谁该订阅。
- **`@scope run | host`**——判定式 = "**这次分发发生在谁的执行里**"：答得出
  唯一 Agent 的为 run 域（loop/*、tool/*、router/*、llm/*、
  conversation/steered），答不出的为 host 域（config/changed、plugin/*、
  ws/*、job/settled、agents/updated、group/*、singles/updated…）。**载荷带
  agentId ≠ run 域**。run 域才有 agentOf 读取器——per-Agent 门控可用性由
  作用域结构性编码（agentGate 签名强制传 agentOf，无身份事件编译期不可门控）。
- **emit 事件末参永不为函数**（agentGate 末参函数判定的前提；event-catalog
  静态测试锁定 @mode/@scope 全量标注与 emit 末参形状）。

`next()` **不携带参数**：改写输入的唯一方式是变异载体
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
- 服务名占扁平命名空间，取有辨识度的域词——新增前查 README 契约归属总表
  防撞名（已占用：llm/tools/agentLoop/agents/router/conversation/session/
  group/singles/convSettings/memory/config/credentials/agentStore/
  agentPresets/subagents/jobs/browser/durableInteraction/timers/archive/
  usage/backup/workspace/webServer/webui/pluginRegistry/eventPolicy/
  agentAdmin/skills/mcp/goals/todos/bench）；另有浏览器侧 ClientContext 服务
  （slots/objects，owning = ac-client-runtime）——不占服务端命名空间。
- 包内 index.ts 是薄行：`export function apply(ctx) { ctx.plugin(XxxService) }`，
  再 re-export 服务类型。

**服务体内访问其他服务（三条铁律）**：

1. **构造器/事件闭包要访问 ctx 依赖**（raw `this`，无 traceable 包装）→ 服务类
   声明 `static inject = ['<dep>', ...]`：fiber 依赖等待 + own-fiber store 填充，
   构造期即可安全 `this.ctx.<dep>`（本 cordis 属性解析按 fiber 链 walk，raw ctx
   只认自己 inject/provide 的服务）。
2. **跨服务方法调用**（尤其目标是 conversation/agentLoop 这类内部还要访问别的
   服务的深链服务）→ 一律 `this.ctx.get('<name>')`：`ctx.get` 走 root-traced
   无限制解析。直接 `this.ctx.<dep>.method()` 在受限调用方（另一个服务的
   fiber）下会在目标的传递依赖处断链（"cannot get property without inject"）。
3. **常驻定时器（心跳/扫描）一律懒拉起**：有工作才 `ctx.interval`，收敛即
   dispose——空闲零定时器，`pnpm dev` 才能自退（参照 ac-timer 心跳 /
   ac-archive 扫描的 syncHeartbeat/syncScan）。

## 持久化与越权红线

- **持久化 owning service**：每个持久化域归 owning service（ac-session 拥有
  会话文件、ac-agent-store 拥有 Agent 数据目录、ac-memory 拥有记忆文件、
  ac-timer/ac-archive 拥有自身状态）。**禁止跨域越权写**；跨服务读取一律走
  服务方法或 type-import。
- **conversationId 寻址不变量**：一切会话态按 conversationId（对桶键）寻址，
  存储文件名即 conversationId。
- **机制任务不过 LLM**：归档/备份等机制任务直调服务方法；"触发 Agent 干活"
  统一 `source:'event'` 信封投递，事件痕迹自然进会话流。

## 新增能力域 checklist

1. 契约：新包 `src/contract.ts` 声明域类型（含 waterfall 可变载体接口）。
2. 事件：新包 `src/events.ts` 声明 `domain/*` 事件 + `@mode` + `@scope
   run|host` + 姿势说明（谁 emit 谁声明，跨域词汇 type-import 自 owning 包）。
3. 服务：新包 `src/service.ts` 实现注册中心；`index.ts` 加契约出口两行
   （`export type * from './contract.ts'` + `export type {} from './events.ts'`）。
4. 组合根：`src/cordis.yml` 加行（`id` + 裸包名）；同步
   `ac-app/src/index.ts` 的 TREE，两表行集保持一致；行包 package.json
   声明 `"agentchat": { "plugin": true }` + `"keywords": ["agentchat"]`
   （插件目录内置组判据——纯库不加，fail-closed）。
5. 可配置行：入口模块自述 `export const extension: ExtensionMeta`（契约住
   纯库 ac-extension-core；监听器级 `{event, 描述, 角色, facet,
   respectsEnabled?}`）——扩展目录随行声明自动生长，不改消费方。
6. 测试：`ac-<domain>/tests/*.test.ts` 覆盖注册/回收/拦截/重名；事件目录
   进 event-catalog 静态检查（@mode/@scope/emit 末参）。
7. 验证：`pnpm typecheck && pnpm test:unit`（日常快循环；整量/集成
   `pnpm test`——集成件按 `*.integration.test.ts` 命名分档）+ 依赖门禁
   `pnpm check:deps`；冒烟 `pnpm smoke`；动 webui 另跑 `pnpm webui:typecheck`。
8. 更新 `src/README.md` 的契约归属总表与布局图。

## 兼容性红线（Node 原生 TS strip-only 加载器）

- 包内相对导入**必须写显式 `.ts` 扩展**（`from './service.ts'`）。
- 类字段**不用参数属性**（`constructor(private x: X)` 禁止；显式赋值）。
- `verbatimModuleSyntax`：纯类型导入必须 `import type` / `import type {}`。
- cordis.yml 的 `name` 支持裸包名（经根 node_modules workspace 链接解析，
  `pnpm-workspace.yaml` 已含 `src/*`）与 `'./相对路径.ts'` 两种。
- 每行**必须带稳定 `id`**：无 id 的行在 yml 每次编辑时被当作先删后加整体重挂。
- **运行时依赖必须在 package.json 显式声明**——禁止靠 workspace hoisting
  隐式生效。
- hmr 行默认 `disabled: true`（构造需 `--expose-internals`）；运行时启用走
  include patches，不写回 yml。
- `cordis.yml` 出厂态永不运行时写入（F10 写回守卫测试锁定）；本机行偏好走
  `cordis.patch.yml`（M25 起 setPatch 热通道即时生效）。

## 治理面（结构性约束，改框架时不得破坏）

- **per-Agent 门控 = agentGate**（ac-gate-core 纯库）+ owning 包导出的
  agentOf* 身份读取器；宿主进程级治理 = ac-event-policy 的
  `internal/listener` bail seam——**该 seam 仅策略行可用**，其余行注册即
  红灯（policy.test 静态断言）。
- 治理面 (插件 × 事件) 是最小稳定粒度；**单个监听器粒度永不做**（监听器无
  稳定 id）；监听器优先度/重排不做；治理面不按 Agent 细分（per-Agent 细分
  归 agentGate 的行为/facet，两层不混）。
- 治理键 = 行名 / manifest.name（稳定单元名，改名 = 破用户配置）；事件名键
  只住进程级停用集 `events.disabled`。

## 反模式（发现即改）

- 应用层出现 `EventEmitter` / 自建 listener 数组 —— 一律换 `ctx.on`。
- 插件 A import 插件 B 的实现类/实例 —— 一律换服务方法或事件。
- 注册中心方法自己管理生命周期（要求调用方传 dispose 回调、忘了 fiber.effect）。
- waterfall 实现在拦截**之前**读载体字段（改写失效）。
- 用行序/启动顺序表达依赖 —— 一律 `inject` 声明，行序仅是装配一览。
- 在 emit 事件上收集返回值，或在 waterfall 上做无返回值广播（模式是约定）。
- 集中式契约包（域类型/事件声明中立于 owning 包之外）——契约归属
  owning package。
- 事件在非 owning 包里声明合并（`domain/*` 必须住在提供 `ctx.<domain>` 的包）。
- 跨域越权写文件 —— 持久化归 owning service，跨域走服务方法。
- 脱敏/结果改写落 `after-*`（纯通知，改了没人消费）——变换必须落
  `transform-*` waterfall；策略拦截落 `before-*`。
- 新增事件不判作用域（run/host 编码门控可用性）；emit 事件末参出现函数。
- 抢用 `internal/listener` bail seam（仅 ac-event-policy 策略行可用）。
- 自建能力集合成/工具可见性判定——单源 capabilitySetOf/toolAllowedFor
  （ac-agents），ac-security 执行复检与之同构，改一处必同步另一处。
