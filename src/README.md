# src/ —— AgentChat 正式轨（cordis 第一性原理）

AgentChat 框架的正式实现轨道：不学习、不延用旧轨设计，把 cordis 基座与生态插件
用到极致——核心四件套（`declare module` 类型声明 / `apply` 行激活 /
`on/emit/waterfall` 事件系统 / `effect/dispose` fiber 归属可逆副作用）+ 生态四件套
（plugin-loader 配置驱动装配 / plugin-hmr 模块热重载 / plugin-timer fiber 定时器 /
plugin-logger-console 控制台输出）。

> **轨道历史**：2026-08-31 preview/ 轨道整体部署为本 src/ 轨道（82 项 git mv
> 原地保留历史）；旧 src/（agent-* 包族）删除并打 `legacy-src-final` tag 留档。
> 历史文档中的 "preview" 即本轨道；`src/vendor/`（cordis 框架行）为运行时基座。

**本文件是本轨道的事实源**，只记现状：三层架构 / 端到端链路 / 契约归属总表 /
纯库清单 / 布局 / 装配与运行时分层。历史决策、裁决点与踩坑档案住 `docs/`
（见[设计档案索引](#设计档案索引)）；开发姿势与新增能力域 checklist 住
`.dsh/skills/agentchat-framework-dev`。

## 心法

cordis 是用于构建框架的框架。本轨道交付的是**一组可独立摘除的插件行 + 一份契约**。
每次改动前先问：摘掉这一行（或换掉实现方），依赖它的其他行能否由 cordis 自动
回滚重载、零改动地恢复工作？能力域 = 一个服务包（`ctx.<key>`）+ 若干生态薄行；
服务是插槽，薄行是插头。三条红线：能力间禁止直接 import 实例、禁止手动编排
激活顺序、禁止跨插件传引用——一律换服务方法、`inject` 声明、事件。

## 三层架构

```
入口  ac-conversation        会话状态机：串行化门（handle=runAddress）+ inbox 双队列
                             （steer / next-turn 链跑）+ MAX_AUTO_WAKES 防自激 + 待投持久化
L3    ac-router + ac-agents  信封投递（纯转发，零会话状态）；Agent 是数据不是插件
                             （+ ac-group 群拓扑 / ac-singles 独立会话）
L2    ac-agent-loop          ReAct 编排：turn=run → [step → 推理/工具 → 收束]×N；
                             三档装配链 + steer 注入 + 语义化中断
L1    ac-llm + ac-llm-pool   模型会话（stream/chat 聚合）；纯路由 + 配置驱动连接池
                             （协议住纯库 ac-openai-completions；连接池 = 唯一事实源，
                             未配置即不注册）
```

**信封拓扑（身份/拓扑分离）**：`conversationId` = 会话归属键——一切双端会话都是
对桶 `pairKey(a, b)`（排序 `~` 连接；自会话 = `a~a` 对角线；群 = 组 id；独立会话 =
sid）；`sender` = 发送方端点 id（user 也只是端点之一）；`source` = 拓扑词
`'user' | 'agent' | 'event'`。一切会话态按 conversationId 寻址，存储文件名即
conversationId，群/1v1 差异只在视图层。

**模型引用语法**：`name@model`（如 `deepseek@deepseek-v4-pro`）——router 边界
拆分为 provider + model，`LoopRunRequest.model` 恒裸名（usage/delta/前缀快照不被
引用语法污染）；左段非已注册 provider 回退整串按裸模型路由。Agent 未声明 model
时投递侧回落 defaultPoolConnection（无默认连接 fail-closed）。

## 命令

```bash
pnpm dev              # 官方启动器（vendor cordis bin.js + cordis.yml；web 3830）
pnpm dev:supervised   # supervisor.mjs 宿主监护（42/78/0 协议 + 退避熔断）
pnpm dev:demo         # 演示 boot（include patches 启用 hmr + 热重载）
pnpm chat             # 对话 REPL（真实 provider 手测；CHAT_MODEL/CHAT_AGENT 可调）
pnpm typecheck        # tsc --noEmit（src 全轨；webui 走 webui:typecheck）
pnpm test             # vitest run（全仓）
pnpm smoke            # tsx 冒烟（程序化树）
pnpm webui            # WebUI dev server（vite 3831 → proxy 3830）
pnpm webui:build      # WebUI 生产构建（→ src/webui/dist，boot 后 127.0.0.1:3830）
pnpm webui:typecheck  # 前端 vue-tsc
```

> `preview:*` 前缀脚本保留为兼容别名（preview:boot ≡ dev 等）。

## 端到端链路

```
ctx.conversation.deliver(agentId, msg, {sender, source, conversationId, lane, placement})
  ├─ 空闲 → 开新 run ┐
  ├─ 忙 + steer → ctx.agentLoop.steer(handle, msg)    handle = runAddress(agent, convId)
  ├─ 忙 + next-run → 等空闲后独立 run                  │
  └─ 忙 + next-turn → 入队（run 后链跑；MAX_AUTO_WAKES=3 防自激：
      source='event' 与群桶内 source='agent'（互答回声链）计预算不重置，
      真人 source='user' 重置）                        ┘
        ▼  每 run 经 router（纯转发，零会话状态）
ctx.router.send(agentId, msg, {history, sender, source, conversationId, signal})
  ├─ waterfall 'router/before-deliver'   投递边界决策 seam（信封可变异/veto；
  │                                      委托权限闸门/审计/内容过滤的预留落点）
  ├─ emit 'router/message-received'      通知通道（ac-session 按 convId 分桶积累）
  ├─ ctx.agentLoop.run(envelope)
  │    ├─ 三档装配链 waterfall：'loop/before-run-first' → 'loop/before-run'
  │    │   （主档）→ 'loop/before-run-last'（尾档）——同一载体贯穿，任一档
  │    │   veto 即无 run；三档封顶（waterfall 无优先度，故拆三事件）。
  │    │   主档住户：ac-persona <persona> 块 / ac-system-prompt 静态块
  │    │   （系统环境→术语约定→指引，条目级工具门控）/ ac-memory <memory> 块 /
  │    │   ac-skill <available_skills> / ac-datetime（singles 日快照行）/
  │    │   ac-mcp 懒建连 / ac-group 群聊行为契约（群桶，历史尾部决策点）。
  │    │   尾档住户：ac-system-prompt 对话信息块（prepend 恒居前）→
  │    │   ac-datetime 日期行（push 绝对收尾；新住户需裁决）
  │    ├─ emit 'loop/run-started'        （三档全过后才发；veto 不发）
  │    ├─ 每步：消费 steer → waterfall 'loop/before-step' → emit 'loop/step-started'
  │    ├─ ctx.llm.chat(...)              纯路由；llm/before-chat waterfall
  │    │                                 （凭据注入/路由改写请求级 seam）；
  │    │                                 llm/delta-* 流式细分事件
  │    ├─ ctx.tools.execute(...)         执行身份随 call；同步工具并发 mapLimit(5)；
  │    │                                 ToolResult.interrupt → 语义化中断
  │    ├─ waterfall 'loop/transform-step'  步记录安全审查/脱敏（入档前终值）
  │    ├─ emit 'loop/after-step'          （通知变换后终值）
  │    ├─ waterfall 'loop/transform-run'   轮结果安全审查/脱敏（入账前终值）
  │    └─ emit 'loop/after-run'            （signal 中止 → finish='interrupted'）
  └─ emit 'router/reply-completed'      ac-session 入账（群桶终稿不入账——
                                        群内容 = 群本体 post 唯一口）
```

**事件模式完整形**：`before-*`（决策/改写，waterfall）→ `started`（通知，emit）→
主体 → `transform-*`（塑造记录，waterfall）→ `after-*`（通知终值，emit）。
变换落 transform、观察落 after、否决落 before——模式是公开约定，新事件必须归位
并写进 owning 包事件目录（`@mode` + `@scope run|host`，emit 末参永不为函数；
event-catalog 静态测试锁定）。

**工具执行面**（tool/* 拦截链上的标准装配件）：

```
tool/before-execute（waterfall 决策）
  ├─ ac-session   fail-closed checkpoint（按 conversationId 定向 flush 后放行）
  └─ ac-security  requiredTags 能力门禁 → per-Agent 沙箱 → bash 命令扫描
tool/transform-result（waterfall 变换）
  └─ ac-security  输出脱敏（凭据明文 + sk-/api_key= 通用模式，结构化深走）
```

工具体返回 `{ok, output}`；宿主级行为（reload/restart/插件装卸）经
`ToolResult.interrupt` 上报 → loop 收束 → 宿主半边执行。

**群拓扑**（单通道 v3）：

```
ctx.group.send(gid, from, content)
  = post 入流（群本体唯一入账口 + group/message-posted 事件；本体落盘
    sessions/groups/<gid>/messages.jsonl，超阈值轮转——配属主走整理 run 亲写概要，
    无属主走机械摘要）
  → 逐参与者 conversation.deliver(member, <msg>包装+时间, {sender: from,
    conversationId: gid, history: historyFor(gid, member)}——viewer 视角投影
    [own=assistant 保示范密度 / peer=user 包装] 作首跑种子）
  + GroupFeed：readSince(锚点)/currentAnchor（busy 参与者免重复增量）
```

**会话历史**（ac-session，"事件积累 + 回放"模式）：订阅 `router/*` +
`conversation/steered` 按 conversationId 分桶入账（中性行：真实发言 =
`role:'agent'` + `agent_id`，机制触发 = `role:'event'`，错误收束 = `role:'error'`
一等行）→ writer 队列落盘；`history(conv, {viewer})` 按读者投影回放。
ac-conversation 的上下文视图 = 同一事件的内存增量投影（与文件派生字节等价）。

## 契约归属（谁 emit 谁声明）

**没有独立的契约包**（`ac-contracts` 与旧轨 `@agentchat/contracts` 均已废弃）。
契约归属 owning package：谁提供 `ctx.<domain>`，谁声明本域服务接口、域类型和
`domain/*` 事件，靠 cordis 声明合并分布式注册。

- 每域 `contract.ts` 放域类型（含 waterfall 可变载体接口），`events.ts` 放事件
  目录；小域可直接进 `service.ts`。`index.ts` 契约出口固定两行：
  `export type * from './contract.ts'` + `export type {} from './events.ts'`。
- 消费方一行 `import type {} from 'ac-llm'` 即获得类型增强（type-only，运行时零依赖）。
- 跨域词汇（如 loop 用 `LlmMessage`）type-import 自 owning 包，记 devDependencies。
- 防撞靠 `domain/action` 命名约定（param-case、`before-xxx` 配对），不靠集中式
  唯一文件；`domain/*` 事件禁止在非 owning 包里声明合并。

| 域（ctx 键） | 域类型（owning 包） | 事件目录 |
|---|---|---|
| llm | `ac-llm/src/contract.ts`（+ `refs.ts`：name@model 拆分纯函数） | `ac-llm/src/events.ts`（llm/*，含 delta-* 流式细分） |
| tools | `ac-tools/src/contract.ts`（执行身份 + requiredTags 门禁） | `ac-tools/src/events.ts`（tool/*） |
| agentLoop | `ac-agent-loop/src/contract.ts`（transform-step/run seam） | `ac-agent-loop/src/events.ts`（loop/*，三档装配链） |
| agents | `ac-agents/src/service.ts`（AgentConfig + settingsOf/displayNameOf） | `ac-agents/src/events.ts`（agents/updated） |
| router | `ac-router/src/service.ts`（RouterInbound 信封） | `ac-router/src/events.ts`（router/*） |
| conversation | `ac-conversation/src/contract.ts` | `ac-conversation/src/events.ts`（conversation/*） |
| session | `ac-session/src/index.ts`（append/records/history/compact/setShelf） | —（积累订阅 router/* + conversation/steered） |
| group | `ac-group/src/contract.ts` + `view.ts`（`<msg>` 包装） | `ac-group/src/events.ts`（group/*） |
| singles | `ac-singles/src/contract.ts`（引用 + 覆盖模型） | `ac-singles/src/events.ts`（singles/updated） |
| convSettings | `ac-conv-settings/src/contract.ts`（会话级模型覆盖） | `ac-conv-settings/src/events.ts`（conv-settings/updated） |
| memory | `ac-memory/src/index.ts` | — |
| config | `ac-config/src/service.ts` | `ac-config/src/events.ts`（config/*） |
| credentials | `ac-credentials/src/service.ts` | — |
| agentStore | `ac-agent-store/src/service.ts`（+ 文档实体 saveDoc/readDoc） | — |
| agentPresets | `ac-agent-presets/src/index.ts`（预设数据定义） | — |
| subagents | `ac-subagent/src/service.ts`（持久多轮实体） | — |
| jobs | `ac-jobs/src/contract.ts`（JobStartSpec/JobHooks/JobSnapshot） | `ac-jobs/src/events.ts`（job/started·settled） |
| browser | `ac-web-tools/src/browser.ts`（守护进程命令配置） | — |
| durableInteraction | `ac-durable-interaction/src/types.ts` + `store.ts` | `ac-durable-interaction/src/service.ts`（durable-interaction/{opened,replied,closed}） |
| timers | `ac-timer/src/service.ts`（TimerRowOptions） | — |
| archive | `ac-archive/src/service.ts` | `ac-archive/src/events.ts`（archive/completed） |
| usage | `ac-usage/src/index.ts`（双轨聚合桶） | — |
| backup | `ac-backup/src/index.ts` | — |
| workspace | `ac-workspace/src/index.ts`（agentWorkdir/sandboxWorkdir 唯一事实源） | — |
| webServer | `ac-web-server/src/contract.ts`（RouteCall/RpcHandler/RpcCaller） | `ac-web-server/src/events.ts`（ws/ack + ws/connection-*） |
| webui | `ac-webui/src/service.ts` | 同文件（webui/extensions-changed） |
| uiExtensions | `ac-webui-extensions/src/service.ts`（slot 白名单 + 超时守护） | — |
| pluginRegistry | `ac-plugin-registry/src/service.ts` | 同文件（plugin/before-load(W) + installed·reloaded·catalog-changed(E)） |
| eventPolicy | `ac-event-policy/src/service.ts`（停用键/清扫/行聚合） | —（治理 seam = internal/listener bail，非公开事件） |
| agentAdmin | `ac-agent-admin/src/service.ts`（AdminUpdateResult） | — |
| skills | `ac-skill/src/index.ts`（三源技能发现） | — |
| mcp | `ac-mcp/src/index.ts`（全局服务器注册，懒建连） | — |
| goals | `ac-goal/src/index.ts`（会话桶目标 + goal-round 驱动） | — |
| todos | `ac-todo/src/index.ts`（会话桶工作清单） | — |

## 纯库清单（零 cordis 依赖）

协议实现与重算法住纯库，薄行只留 inject + register 胶水；纯库可被多个薄行共用、
可独立单测。

| 纯库 | 职责 |
|---|---|
| `ac-core-utils` | 跨行共享基础纯函数/协议常量（GROUP_HINT_META/isGroupHint、maxSeqOf——只收会成运行时环/反向依赖的最小词汇） |
| `ac-openai-completions` | OpenAI 兼容协议：SSE 流式 + tool_calls 分片 + chat 聚合 + listModels + 无进展超时（缺省 180s）+ 多模态附件物化（visionModels 门控，非视觉模型 fail-closed 剥离） |
| `ac-config-merge` | deepMerge/computeDiff 差异配置 |
| `ac-edit-core` | 编辑引擎：三级模糊匹配/增量 diff/行尾保留/文件突变队列 |
| `ac-sandbox-core` | createSandboxResolver/bash 命令扫描/输出脱敏/agentSpaceRoots（读写侧基准分叉并根） |
| `ac-text-budget` | token 估算/代理对安全截断 |
| `ac-glob-core` | glob→RegExp + 有界 walk |
| `ac-web-search-core` | 搜索 provider 特型（tavily/deepseek 在册） |
| `ac-archive-core` | 归档阈值/尾部截断（不拆工具对）/二次归档去重分割 |
| `ac-timer-core` | 间隔解析/目标时间/5 模式标签/节假日（农历+调休）/时区 ISO/hint 模板 |
| `ac-backup-core` | zip 打包/周期轮转/到期间隔（路径全显式） |
| `ac-ws-protocol` | WS 帧编解码 + rpc/ack 控制帧 + 后台源判定 |
| `ac-plugin-core` | manifest 校验/权限授予策略/契约版本兼容/staging 人审文件域/fsx 原子写/审计流水/保留字常量表/熔断存档/cordis.patch.yml 文件域 |
| `ac-supervisor-core` | 42/78/0 退出码协议 + 退避熔断纯函数 + .runtime 单写者锁 |
| `ac-skill-core` | SKILL.md frontmatter 解析/发现/`<available_skills>` 渲染/白名单过滤 |
| `ac-mcp-core` | MCP 客户端（官方 SDK 包装，HTTP/stdio 双传输；describeError 自 ac-error-core re-export） |
| `ac-memory-core` | 记忆注入 token 预算截断（尾部近期保留 + 截断标记） |
| `ac-gate-core` | agentGate 门控：waterfall 停用机械 next()/emit 停用跳过/facet 子键覆盖回落行为级 |
| `ac-error-core` | describeError（cause 链展开单行诊断）+ isTransientNetworkError（瞬时网络故障判定） |
| `ac-extension-core` | ExtensionMeta 契约（可配置行入口自述 `export const extension`） |

## 布局（扁平，每行一包，`ac-*` 前缀）

```
src/
│ ── 组合根与进程层 ──────────────────────────────────────────────
├── ac-app/                  组合根：TREE/bootTree（程序化）与 ecosystem.ts/cordis.yml
│                            （配置驱动）双路径；boot.ts = 官方启动入口
├── cordis.yml               配置驱动装配文件（行集与 ac-app TREE 保持一致）
├── supervisor.mjs           宿主监护进程：spawn worker + 42/78/0 协议 + 退避熔断 +
│                            .runtime 单写者锁（进程层脚本，不经组合根）
├── vendor/                  cordis 框架行（@agentchat/cordis-*：loader/include/
│                            timer/logger/hmr，本轨运行时基座）
├── templates/               插件开发模板骨架（tool-row / provider-row / event-row）
├── docs/                    设计档案与里程碑规划（见文末索引）
├── scripts/                 迁移与验证脚本（migrate-workspace / migrate-session-neutral /
│                            unify-group-storage / migrate-hooks-to-settings / usage-baseline）
│ ── L1 模型域 ──────────────────────────────────────────────────
├── ac-llm/                  LLM 纯路由（ctx.llm）：注册工厂懒实例化 + provider/model
│                            路由 + stream/chat + /models 发现 + 瞬时网络错误退避重试
│                            （首块产出前，缺省 2 次；已产出不重试）；LLM 域契约
├── ac-llm-pool/             配置驱动 provider 注册行：config llmProviders 连接池 =
│                            唯一事实源（未配置即不注册；config/changed 热更 diff 重挂）；
│                            defaultPoolConnection 缺省回落口；vision 并集门控 +
│                            媒体物化；凭据注入（pool:<provider> apiKey）
├── ac-openai-completions/   OpenAI 兼容协议纯库（见纯库清单）
├── ac-llm-openai/ · ac-llm-deepseek/ · ac-llm-glm/
│                            退役适配行空壳（provider 注册面已收敛至 ac-llm-pool）
│ ── L2 编排 ────────────────────────────────────────────────────
├── ac-agent-loop/           ReAct 循环（ctx.agentLoop）：run → [step → 推理/工具 →
│                            收束]×N；边界全事件化（三档装配链/before-step/
│                            transform-*/after-*）；steer() 注入 + finish='interrupted'
│                            语义化中断；maxSteps 双模式（>0 = trigger 上限
│                            finish='max-steps'；缺省/0 = 不限步）
│ ── L3 会话与路由 ──────────────────────────────────────────────
├── ac-conversation/         会话状态机（ctx.conversation）：串行化门 + inbox 双队列 +
│                            MAX_AUTO_WAKES 防自激 + 待投持久化（崩溃/42 重启不丢）+
│                            排队数据面（queue/removeQueued/steerQueued +
│                            queue-changed 权威快照）+ 上下文视图派生
│                            （router 事件按读者投影，与 history 文件派生字节等价）
├── ac-router/               纯转发（ctx.router）：agents 解析 AgentConfig 构建信封
│                            投递 agentLoop + 事件通知双通道；router/before-deliver
│                            决策 seam；模型缺省回落 defaultPoolConnection
├── ac-agents/               Agent 注册中心（ctx.agents）：AgentConfig +
│                            settingsOf(id, name?)（全局默认层 ∪ 差异层合成口）+
│                            displayNameOf；Agent 是数据不是插件
├── ac-agents-dir/           数据驱动行：<root>/agents/ 目录扫描物化进 ctx.agents
├── ac-agent-presets/        预设 Agent 目录（ctx.agentPresets）：__standard__/
│                            __dsh_minimal__ 数据定义物化；skip-if-present；
│                            无记忆语义 = 预设软停用 memory/skill/datetime 等行
├── ac-agent-store/          Agent 数据目录 owning（ctx.agentStore）：config.json +
│                            机制 entries（timer/skills 等唯一写口）+ 文档实体
│                            （AGENT.md 等）；getAgent 读边界归一（旧 hooks→settings）
├── ac-singles/              独立会话元数据（ctx.singles）：会话 = 引用 + 覆盖而非
│                            拷贝；自动标题（after-run LLM 一句话）；[system+tool
│                            schema] 前缀快照（修订键锚定，漂移对拍告警）
├── ac-conv-settings/        会话级覆盖域（ctx.convSettings）：按 conversationId 的
│                            模型覆盖（name@model）；deliver 边界单点生效
├── ac-group/                群拓扑（ctx.group）：成员表 + 单通道内容流（post = 群
│                            本体唯一入账口）+ GroupFeed 锚点增量 + historyFor
│                            viewer 投影 + 群聊行为契约注入 + 记忆属主共享注入 + 轮转
│ ── 系统提示装配行（loop/before-run* 落点，见端到端链路）─────────
├── ac-persona/              人设注入：<persona> 块（file 优先 text 回退；裸名走
│                            agentStore 文档、路径走文件系统）
├── ac-system-prompt/        系统提示词分块装配器：静态块（系统环境/术语约定/指引
│                            ——条目级工具门控）落主档 + 对话信息块落尾档（prepend
│                            居前）；override 全量覆盖静态块
├── ac-memory/               长期记忆（ctx.memory）：键 = 对键/群 id（singles 重定向
│                            对用户对桶）；文件 = files/<agentId>/memory/<会话键>.md，
│                            LLM 经 fs 工具亲自维护；token 预算截断注入
├── ac-datetime/             日期注入：singles 走日快照行（主档）；其余会话 system
│                            尾部仅日期行（尾档绝对收尾）——KV 前缀跨轮稳定
├── ac-skill/                技能目录（ctx.skills）：全局/本 Agent 专属/会话工作区
│                            三源发现 + <available_skills> 注入 + load_skill 工具 +
│                            /name 用户显式调用手势（步级注入正文）
│ ── 任务追踪（状态经消息面到达模型，不改写 system）──────────────
├── ac-goal/                 长期目标（ctx.goals)：goal-round 驱动（after-run 续投
│                            <goal_round>，error/上限自动暂停）+ goal 工具；
│                            agentStore entry 'goal' 持久化
├── ac-todo/                 待办清单（ctx.todos）：会话桶工作清单 + todo 工具
│                            （write 全量重写/read；上限 50 条）
│ ── 工具基建与安全 ─────────────────────────────────────────────
├── ac-tools/                工具注册中心（ctx.tools）：fiber 归属注册
│                            （listWithOwner 目录视图）+ waterfall 拦截链 +
│                            requiredTags 能力门禁
├── ac-jobs/                 后台任务注册中心（ctx.jobs）：owner 分桶 + 并发上限 +
│                            settle first-wins + job/started·settled（登记即发）
├── ac-security/             安全行：requiredTags 能力门禁 + per-Agent 沙箱（加严层，
│                            基线随各工具行自带）+ 控制面黑名单 denyPaths +
│                            bash 命令扫描 + 输出脱敏
├── ac-subagent/             子 Agent（ctx.subagents）：持久多轮实体（spawn/send
│                            [async·sync·steer·next-run 四投递语义]/await/list/stop/
│                            delete）；落盘 <root>/subagents/ 跨重启续聊；每 run job
│                            登记（usage 记账落 subId 名下）
├── ac-durable-interaction/  持久化交互（ctx.durableInteraction）：write-ahead 状态机
│                            （open/reply/close 幂等）+ ask_questions 工具
├── ac-mcp/                  MCP 行（ctx.mcp）：全局服务器注册（懒建连）+ 工具发现
│                            注册进 ctx.tools（撞名 `${server}__${name}` 前缀）；
│                            放行走行 config，per-Agent 暴露走 AgentConfig.tools
│ ── 工具行（行组合决定装载；描述约定一句话由 owner 行教语法）─────
├── ac-fs-tools/             文件读写：read（行号分页 + token 截断）/write（突变队列
│                            串行）/edit + @<路径> 引用约定
├── ac-fs-search/            检索：glob（mtime 排序/上限 100）+ grep（正则/include
│                            过滤/二进制跳过/上限 250）
├── ac-str-replace-editor/   四合一编辑器：view/create/str_replace/insert（写经突变
│                            队列；requiredTags ['fs_minimal'])
├── ac-shell-tools/          命令执行：bash 前台超时/流式 onProgress + 后台 job 登记
│                            + Unix→PowerShell 翻译（requiredTags ['shell']）
├── ac-math/                 数学：纯表达式解析求值（白名单常量/函数 + BigInt 混算 +
│                            资源护栏；无 node:vm）
├── ac-web-tools/            网络：web_search（requiredTags ['web']）+ browser 守护
│                            进程（ctx.browser：请求队列/dispose 杀进程；
│                            observe⊂manipulate⊂inject 动作分层门禁）
├── ac-sap-adt/              SAP ABAP ADT 工具行（46 个 adt_* 工具；引擎 =
│                            @nefevcore/abap-adt-core 纯内核；requiredTags
│                            ['sap-adt']；demo 目的地默认开启，零 SAP 端到端可用）
├── ac-collab-tools/         协作：send_agent（经 conversation，busy=steer/wait=
│                            next-run）/send_group/list_*/read_agent_info/
│                            update_agent_profile + @<名称> 引用约定
├── ac-dev-tools/            开发辅助：read_logs（环形缓冲）/reload/reload_modules
│                            （语义化中断）
├── ac-restart/              system_restart 工具（中断上报 + after-run 宿主半边：
│                            优雅关闭 → exit 42 → supervisor 重拉）
├── ac-session-query/        会话查询门面：grep_history/read_history（复用
│                            ctx.session.history()）+ #<标题>(<会话id>) 引用约定
├── ac-timer-tools/          定时任务工具：timer set/list/disable（映射 ctx.timers；
│                            owner=执行身份）
│ ── 持久化与服务编排 ───────────────────────────────────────────
├── ac-config/               全局配置（ctx.config）：<root>/config.json 原子读写 +
│                            热重载 + config/changed
├── ac-credentials/          凭据（ctx.credentials）：AES-256-GCM 机器绑定加密 +
│                            Agent→全局解析链 + listValues 脱敏清单
├── ac-session/              会话历史 owning（ctx.session）：中性行入账 → writer 队列
│                            落盘（append+fsync/幂等/失败回队首）+ history(conv,
│                            {viewer}) 投影回放 + records/append/compact/setShelf +
│                            steps[] 步记录持久化 + 工具前 fail-closed checkpoint
├── ac-usage/                用量统计（ctx.usage）：after-run 双轨记账（覆盖 = 当次
│                            上下文/累加 = 总用量 + cache + steps）→ 多维查询
│                            （byAgent/byModel/byDay/byDayModel/byConversation/byPair）
│                            + 日 jsonl 审计流水 + boot 回读重建
├── ac-archive/              归档编排（ctx.archive）：after-run 阈值检测 → 同桶整理
│                            run（Agent 亲写概要；meta 标记三处不落盘；maxSteps 128
│                            硬闸/超时 abort/步级观测三道防线）→ 分段 + compact 重建
├── ac-timer/                定时任务（ctx.timers）：5 模式调度（time/delay/random/
│                            workday/holiday）+ 限定次/永久 + 停机补偿 + 懒心跳；
│                            触发 = deliver(source:'event') 落 Agent 自会话桶；
│                            机制任务直调服务（archive-all/backup-all）
├── ac-backup/               数据备份（ctx.backup）：run（force/间隔检查）+ list——
│                            zip 全量（含归档）+ 轮转保留 4 份
├── ac-workspace/            工作区（ctx.workspace）：目录布局 + browser 守护脚本分发
│                            + 默认 user(virtual)/admin Agent + agentWorkdir/
│                            sandboxWorkdir/sandboxAllowedPaths/
│                            conversationWorkspaceRoot 唯一事实源 + 本机目录浏览
├── ac-job-wakeup/           job/settled → deliver(source:'event') 通知 owner（与
│                            ws-bridge 同事件两订阅方）
│ ── 传输与可视化（核心域零 UI 知识）────────────────────────────
├── ac-web-server/           传输基座（ctx.webServer）：HTTP 路由注册中心 + WS 广播/
│                            心跳 + rpc/call 显式分发表 + requestId 幂等去重 +
│                            静态托管/SPA（Node 原生 http，零 express）
├── ac-ws-bridge/            WS 事件桥接订阅行：emit 面（router/*/loop/*/llm/delta-*
│                            等）→ WS 帧（type=事件名直转）；后台会话过滤；群 hint
│                            帧不广播（群内容唯一源 = group/message-posted）
├── ac-web-api/              WS RPC 业务方法注册薄编排行：conversation/session/
│                            agents/group/singles/usage/timer/backup/config/llm/
│                            plugin/events/system 全套 + 扩展目录聚合
│                            （collectExtensionCatalog）
├── ac-agent-admin/          Agent 管理面（ctx.agentAdmin + 写侧 RPC）：CRUD（白名单
│                            fail-closed + deepMerge 补丁 + 变更报告）+ 装配视图
│                            （agents/assembly）+ system-prompt dry-run（三档干跑）
├── ac-webui/                Web UI 表面（ctx.webui）：插件 UI 扩展 entries 清单 +
│                            /ui-plugin/ 静态 + extensions-changed
├── ac-webui-extensions/     UI 扩展 slot 注册表（ctx.uiExtensions）：宿主先开口
│                            （内置 slot 白名单）+ 插件后填空（fail-closed）+
│                            install 15s 超时守护 + isolated 档
├── webui/                   前端本体（Vue；UI 直连 RPC/事件协议——api/ 各域模块 +
│                            stores；适配器防腐层已随契约换血收口整体退役）
│ ── 插件域与治理 ───────────────────────────────────────────────
├── ac-plugin-registry/      插件注册中心（ctx.pluginRegistry）：staging 人审 +
│                            installFromDir 免审安装复合口（同 hash 幂等/保留字护栏）
│                            + 装载管道（before-load → 动态 import）+ 熔断
│                            .load-health.json + 安全模式 + 行偏好层 patch-rpc +
│                            审计流水；register/install 插件工具（中断通道）
├── ac-plugin-gates/         装载 gate 策略行：权限 + 契约双 gate（import 之前
│                            fail-closed，代码不进进程）
├── ac-plugin-market/        插件市场行：market/search（npm+github 双源，opt-in
│                            发现门槛）+ market/stage（tarball 下载解包 + manifest
│                            校验 + 来源锚定暂存人审）
├── ac-event-policy/         事件治理策略行（ctx.eventPolicy）：(插件×事件) 停用集
│                            events.disabled（吞注册≠veto）+ boot 末一次性清扫 +
│                            fiber→顶层行聚合
│ ── 样例 ──────────────────────────────────────────────────────
└── ac-hello/                链路验证最小样例（inject/apply/effect/on）
```

## 装配与运行时

### 两条装配路径

| 路径 | 入口 | 说明 |
|---|---|---|
| **官方（生产）** | `pnpm dev` | boot.ts 内联官方 bin.js 的 16 行（Context → Loader → include 读 `./cordis.yml`；装载前读 `<数据根>/cordis.patch.yml` 行偏好层注入 patches——不存在/损坏 warn + 空数组 fail-soft） |
| 测试/演示辅助 | `ac-app/src/ecosystem.ts` 的 `bootFromConfig()` | 官方路径之外的 initial 物化 / include patches / 独立测试 yml（vitest 用） |

### 装载态四层

1. **`cordis.yml` 出厂态**：git 管理，永不运行时写入（F10 写回守卫测试锁定）。
2. **`cordis.patch.yml` 本机行偏好层**：声明式 patch `{id, disabled}`；id = yml
   裸行 id（namespaced entry.id 永不命中）；`setPatch` hot 态即时生效（include
   热通道，cordis.yml 字节不变）；停用级联含 ac-web-api 时 UI 升级警告 + 急救
   通道；批量还原 `plugin/patch-reset {factory|minimal}`。
3. **`plugins/registry.json` 安装态**：动态插件；boot 扫描恢复。
4. **`settings[具名]` per-Agent 启用表达**：全局默认层 ∪ 差异层（settingsOf 合成）。

### Agent 插件开发分工

| 目录 | 用途 | 装载方式 |
|---|---|---|
| `<数据根>/files/<agentId>/<name>/` | **Agent 自开发**（调用方沙箱，install_plugin 缺省约定位置） | `register_plugin` 临时试跑 / `install_plugin` 永久安装 |
| `<数据根>/plugins/<agentId>/<name>/` | 用户手工开发扫描面（devScan） | 宿主 UI 装载 / stage → 人审 approve |
| `<数据根>/plugins/<name>/` | 已安装态（install/approve 的落位） | boot 扫描自动恢复 |

模板骨架与规约：`templates/`；开发姿势见 `.dsh/skills/agentchat-plugin-dev`。

### 数据根约定

持久化目录 = **启动文件夹**（敲 `pnpm dev` 时所在的目录，不套 `data/` 壳）。
boot.ts/supervisor.mjs 在 chdir 前锚定它写入 `AGENTCHAT_DATA_ROOT`（已设则尊重），
各持久化行缺省读它，回退 `./data`（测试兼容）。在哪个文件夹启动，数据
（sessions/agents/singles/…）就落在那个文件夹。

### 配置驱动要点

- **行 name = 裸包名**（workspace 链接解析）或 `'./相对路径.ts'`；每行必须带稳定
  `id`（无 id 的行在 yml 编辑时被当作先删后加整体重挂）。
- **可配置插件导出 Config schema**（Schemastery）：loader 在 apply 前校验并填默认值，
  非法配置 = 行 FAILED、boot 拒绝。
- **可配置行入口自述** `export const extension: ExtensionMeta`（契约住
  ac-extension-core）——扩展目录随行声明自动生长，不改消费方。
- hmr 行默认 `disabled`（构造需 `--expose-internals`）；运行时启用走 include
  patches，不写回 yml。
- 配置热刷新：`include.refresh()` 事务性增删行；运行时 patch 不落盘。
- **兼容性红线**（Node 原生 TS strip-only 加载器）：包内相对导入写显式 `.ts`
  扩展；类字段不用参数属性；纯类型导入 `import type`；运行时依赖在 package.json
  显式声明（禁止靠 hoisting）；插件行声明 `"agentchat": {"plugin": true}` +
  `"keywords": ["agentchat"]`（纯库不加，fail-closed）。

## 设计铁律

1. **能力调用 → Service 方法**：要返回值、要依赖保证，做成 `ctx.<domain>` 方法，
   消费方 `inject` 声明依赖。
2. **拦截/改写/否决 → waterfall 事件**：变异载体后 `next()` 委托，或不调
   `next()` 短路（veto）；`next()` 不携带参数——改写输入唯一方式是变异载体，
   实现侧在 waterfall 返回之后才读载体字段（路由发生在拦截之后）。
3. **纯通知 → emit 事件**：多方订阅、发送方不关心谁在听；emit 与 waterfall
   二选一并写进目录。
4. **协议实现/重算法 → 纯库包**：零 cordis 依赖，薄行只留胶水。
5. **实例 → 数据，不是插件**：Agent 是注册表里的数据；会话历史不归 router。

推论与红线：

- **注册即归属**：注册中心方法内用 `this.ctx.fiber.effect`（tracker 指向调用方
  插件），插件作者零 dispose 代码；重资源懒实例化。
- **持久化 owning service**：每个持久化域归 owning 服务，禁止跨域越权写；
  跨服务读取走服务方法或 type-import。
- **机制任务不过 LLM**：归档/备份直调服务方法；"触发 Agent 干活" 统一
  `source:'event'` 信封投递。
- **服务体内访问其他服务**：构造器/事件闭包用 `static inject`；跨服务方法调用
  一律 `this.ctx.get('<name>')`（root-traced 无限制解析）；常驻定时器懒拉起。
- **治理面**：per-Agent 门控 = agentGate（ac-gate-core）+ owning 包 agentOf 读取器；
  进程级治理 = ac-event-policy 的 internal/listener bail seam（仅策略行可用）；
  单监听器粒度/优先度重排永不做。
- 应用层零 `EventEmitter`、零跨插件实例传递、零 `if (ctx.xxx)` 探测注册副作用。

## 设计档案索引

历史决策、裁决点与事故档案住 `docs/`（多数"新"能力已有踩坑沉淀——动手前先查）：

| 分组 | 档案 |
|---|---|
| 总览与对账 | `src-to-preview-map.md`（四域深度审查 + ADR-1~7）· `m15-reconciliation.md` · `m24-m25-review.md` · `m24-m25-handoff.md` |
| 会话与 LLM 域 | `session-design.md` · `m21-replay-prefix-cache-plan.md`（回放正确性 + KV 前缀）· `llm-provider-model-plan.md`（池 v2 + name@model）· `llm-protocol-extensibility.md`（备忘未实施）· `multimodal-vision-input.md`（多模态视觉输入） |
| WebUI | `m7-webui-plan.md` · `m16-native-webui-plan.md` · `m17-ui-parity-plan.md` · `m18-layout-style-parity-plan.md` · `webui-adapter-plan.md` + `webui-adapter-notes.md`（同源迁移，已收口）· `webui-portb-issues.md` · `webui-src-alignment.md` · `webui-slot-tree.md`（未实施）· `webui-plugin-ownership.md`（未实施） |
| 系统提示词 | `system-prompt-optimization-plan.md`（v3 逐块裁决）· `system-prompt-assembled-example.md`（最终装配示例） |
| 治理与插件域 | `m22-ext-plugin-ui-plan.md` · `m23-agent-plugin-plan.md` · `m24-global-defaults-plan.md` · `m25-event-governance-plan.md` |
| 审计与精简 | `t0-audit-2026-08-31.md`（安全与健壮性加固）· `simplify-audit-2026-08-31.md` · `simplify-audit-fulltrack.md` |
| 专项 | `tavern-interop-plan.md`（SillyTavern 互通，待实施）· `sap-adt-config-layer-bug.md` · `polish-backlog.md` |

### 里程碑一览

| 里程碑 | 主题 |
|---|---|
| M0-M3 | llm 纯路由链 + tools + agent-loop（ReAct）+ agents/router + 组合根；生态接入（loader/include/timer/logger/hmr） |
| M4-M6.5 | 扩展四件套（persona/system-prompt/session/memory）· 信封拓扑 · 流式细分 delta-* · tool/transform-result |
| M7 | WebUI/可视化：ac-web-api + ac-agent-admin + 前端移植 |
| M8 | src 语义对齐：maxSteps 双模式 · transform-* · settings[具名] |
| M9 | L3 补全：ac-conversation 会话状态机 · ac-group · steer/中断 |
| M10 | 持久化基座：session writer 队列 · agent-store · config · credentials |
| M11 | 工具面：执行身份 · jobs · 纯库五件 · 工具九行 · security · subagent · durable-interaction |
| M12 | 服务编排：usage 双轨 · archive 整理漏斗 · timer · workspace · backup |
| M13 | 宿主与可视化：web-server · ws-bridge · webui/slot · 插件域 · supervisor |
| M14 | 扩展补全：datetime · skill · mcp · memory · collab-tools · persona 文件装载 |
| M15 | 对账收官（六轴对照 + 补齐 13 项，见 m15-reconciliation.md） |
| M16-M18 | WebUI 原生重写 → UI 对账补齐 → 布局风格对齐（M16 后经同源迁移回滚，分支 archive/webui-native-m16 留档） |
| M19 | user 去特殊化——全对键桶模型（pairKey 对桶 + sender/source 分离） |
| M20 | 归档分支回归——会话内整理 run + 失控防线（maxSteps 128 硬闸） |
| M21 | 回放正确性与 KV 前缀稳定——中性行格式 · 视图派生 · 前缀快照 · 群存储统一 |
| M22 | 扩展与工具/插件库 cordis 原生化 |
| M23 | Agent 自开发插件——免审安装闭环 · 熔断/安全模式 · 行偏好层 |
| M24 | 全局默认层与目录信息架构——settings 收口 · 目录 IA · 市场首期 · 能力收敛 · audit 轮转 |
| M25 | 事件治理与行树治理——agentGate · 事件清单 · ac-event-policy · include 热通道 |
| M26 | 群聊行为对齐——群契约注入 · 终稿不入群本体 · 角色投影 · MAX_AUTO_WAKES 群桶语义 |
| T0 | 安全与健壮性加固（传输面/math 逃逸/凭据链/重写窗口/JSONL 自愈/熔断双缺陷等，见 t0-audit） |
| 2026-09/10 增量 | subagent 多轮重构 · 群记忆收敛（记忆属主）· 写侧对齐读侧（基准分叉并根）· 多模态视觉输入 · A1 注册制目录 · 瞬时网络重试 · 引用约定一句话（@/#/技能名） |
