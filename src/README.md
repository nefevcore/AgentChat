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

纯库清单 / 布局 / 装配与运行时分层。历史决策、裁决点与踩坑档案住 `src/docs/`

（见[设计档案索引](#设计档案索引)；注释时间标记（YYYY-MM = 批次代号非日历月）

读写规范见 `docs/epoch-marking-convention.md`；收官过程文档冻结于 `src/docs/archive/` 与

仓库外归档根 `Dev\Note\AgentChat\docs-stale-2026-12\`）；开发姿势与新增能力域

checklist 住 `.dsh/skills/agentchat-framework-dev`。

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
pnpm test             # 全量测试（scripts/run-tests.mjs all；CI/发布门用，~45s）
pnpm test:unit        # 快循环：仅非集成件（~21s，日常改动后跑这个）
pnpm test:integration # 仅集成件（限流 8 路；追 flake / 验重活路径时跑）
pnpm test:watch       # 快循环 watch 模式
pnpm smoke            # tsx 冒烟（程序化树）
pnpm webui            # WebUI dev server（vite 3831 → proxy 3830）
pnpm webui:build      # WebUI 生产构建（→ src/webui/dist，boot 后 127.0.0.1:3830）
pnpm webui:typecheck  # 前端 vue-tsc
```

> `preview:*` 前缀脚本保留为兼容别名（preview:boot ≡ dev 等）。

### 测试分档约定

测试文件按**成本**分两类，靠文件名区分（无需登记清单，新用例作者自行归类）：

- `*.test.ts` —— 纯逻辑用例（亚秒级，占多数）。默认档位。
- `*.integration.test.ts` —— 真起子进程 / HTTP 服务器 / 整树 boot 的用例。
  单独成档是因为它们既是**时长大头**（实测 37 个文件占 79% 执行时长），
  又是**争用源**（并发过高会互相挤占：子进程冷启动被拖过就绪窗口等），
  需要限流跑。

定向跑单个包/文件用路径过滤（不必进包目录，包内 `vitest run` 会因
include 模式相对根解析而找不到用例）：`npx vitest run src/ac-session`。

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
  │    │   [引用约定] 三条（ac-fs-tools @路径 · ac-session-query #会话 ·
  │    │   ac-collab-tools @名称；owner 行条件安装）/ ac-skill
  │    │   <available_skills>（收敛式插入：锚定 [引用约定] 词形恒居其前——
  │    │   Loader 路径行并发创建，行序 ≠ 激活序，位置不靠行序保证）/
  │    │   ac-datetime（singles 日快照行）/ ac-mcp 懒建连 / ac-group 群聊行为契约（群桶，历史尾部决策点）。
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

**工具执行面**（tool/* 拦截链上的标准装配件；access-tier 双轴门禁）：

```
tool/before-execute（waterfall 决策）
  ├─ ac-session   fail-closed checkpoint（按 conversationId 定向 flush 后放行）
  └─ ac-security  双轴门禁（access-tier）：
       1. 能力轴 requiredTags（AND，tags 单源——capabilities 覆盖层已删除）
       2. 权限轴 needPermission × 档位（full/sandbox/缺省 base = tags 判定）：
          full 自由（跳过路径复检与 bash 扫描）· sandbox 白名单内自由
          （越界视同 base）· base+有人桶经 durableInteraction 询问提权
          （批准两档：仅本次 = call.elevation 注入 'full-access' 单次有效；
          本轮全部 scope='run' = 内存授权表按 agent+conversation 维度记
          载，本轮 run 内后续 needPermission 调用免询问，after-run 清除）
          · base+无人桶拒绝并说明 · 无身份 fail-closed；专属空间
          files/<id> 写免询问（D1）
       3. 双黑名单复检：accessDenyPaths（读+写双禁——控制面 + 持久化域树
          agents/sessions/subagents/usage/backups，不随档位跳过）/
          readDenyPaths（仅读禁——.env 系/密钥，full 跳过）
       4. bash 命令扫描（heredoc 剥离 + 段级启发式；full 跳过）
tool/transform-result（waterfall 变换）
  └─ ac-security  输出脱敏（凭据明文 + sk-/api_key= 通用模式，结构化深走）
loop/before-run（主档）
  └─ ac-security  唆使防御注入：source='agent' 且 tierOf(sender) < tierOf(接收方)
       → <security-notice> system 块（软缓解非边界；steer 落点在
       ac-conversation deliver 的注入分支——同 run 同 sender 去重）
```

工具行基线与加严层分层（§9.3）：fs 工具行读基线 = 读不设防（脱离工作区
沙箱，只过双黑名单）；写基线 tierOf 感知（full/审批 elevation 跳过白名单，
accessDeny 不跳过）；glob/grep 结果集过滤双黑名单；bash 工具行基线同款
tierOf 感知（full 跳过命令扫描与 workdir 白名单——"不做任何限制"的字面义，
与 ac-security 加严层同口径防漂移）。elevation 穿线：
`ConversationDeliverOptions.elevation`（deliver 边界按 source 判定——
user 信封两档直达[webui 输入框快捷提权，持续武装直到改回]、event 信封
上限 sandbox-access、agent 信封恒剥除；**只升不降**——Agent 自有 tags
档位恒为底座，不高于自有档位即剥除，缺省按自有档位执行）→ router →
`LoopRunRequest.elevation` → 每步 `ToolCall.elevation`；合法装配方 =
归档整理 run（source:'event'）、子 Agent 档位继承（ac-subagent 直调装配
tierOf(parentId)）与宿主 API 人工快捷提权（web-api deliver RPC → webui
提权按钮）。

工具体返回 `{ok, output}`；宿主级行为（reload/restart/插件装卸）经
`ToolResult.interrupt` 上报 → loop 收束 → 宿主半边执行。

**AgentConfig.tools 的 tag 引用**（条目词形 `'tag:<tag>'`，include/exclude
通用）：`resolveToolNames`（ac-agents 单源，router 信封构建时展开）把
引用条目展开为 requiredTags 含该 tag 的全部工具名——白名单不必点名
工具，工具集增删自动跟随；与精确名可混排，无匹配展开为空。注意：tag
引用只做**点名**不做**解锁**——能力面仍由 `tags` 单源裁决（requiredTags
缺标签的工具不在可见宇宙，include 引用条目也展开不出来）；预设声明
工具面的主形态 = 只写 tags（标准/ABAP 开发模式同构），tools 白名单与
tag 引用是收窄/混排的补充手段（极简模式的 include、批量排除的
exclude）。落空可观测（fail-fast）：tag: 引用展开为空与字面名不在
可见面（拼写错/平台拆分改名，如 Windows 上的 'bash'）都经 router
logger.warn 告警——不静默。「**tags 即工具面**」的准确边界：对**出厂
工具**成立（全量标签化 2026-09-16，一切出厂工具挂具体标签）；第三方/
动态插件工具若不声明 requiredTags 仍默认人人可见（toolAllowedFor
短路）——生态作者请自觉挂标签，否则该工具游离于 tags 门禁之外。

**工具调用模式（tc-* 标签轴，2026-09-17 统一重构：与提权档位同构）**：
模式词 `tc-none` / `tc-programmatic`（AgentConfig.tags 词汇；缺省 = tc-base），
`toolModeOf(agent)` 单源判定（ac-agents——对标 tierOf）；生效档 = 会话覆盖
（conv-settings `toolMode`，三值全暴露，无键 = 跟随）?? toolModeOf(agent)。
tc-programmatic ⇒ LLM 面合成 mode 工具集（投影源从能力面直取
`resolveEffectiveTools(…, 'projection')` 跳过 include 收窄）；tc-none ⇒ LLM
工具面清空（纯聊天）；tc-base ⇒ 常规工具面（mode 工具不在其中）。
**injection 注入轴（2026-12 重构）**：`ToolDefinition.injection`——
`'capability'`（缺省，能力轴门禁）| `'mode'`（模式合成：不挂
requiredTags、不进常规工具面，tc-programmatic 档经 narrowToolsByMode
从注册面直接合成，与 tags 无关、行在装即生效）。先例 run_code——
「授权词 = infra」旧语义随之退役。tc-programmatic 但无 mode 工具
（run-code 行未装）⇒ 空面 + warn（形同 tc-none，不回落常规面——语义
突变防护）。收窄判定单源 `effectiveToolMode` + `narrowToolsByMode`
（ac-agents——2026-12 估算失真修复）：router dispatch 与估算面
（agents/system-prompt 干跑、agents/tool-defs 的 conversationId 形态）
共用，Token 仪表固定开销估算随会话开关同口径收窄（程序化会话注入
SDK 投影块、仅 run_code schema）。**PTC 门控面单源（2026-12 基线段
丢失修复）**：`isModeToolFace`（请求面恰等于 mode 工具集判定——
run_code 投影注入条件单源化）+ `widenToolsForGating`（系统提示门控
行的「工具在场」依据在程序化 run 换成能力面展开——PTC 下
request.tools 已收窄成 ['run_code']，直读会误伤指引块/宿主环境行/
@ 与 # 引用约定全部基线段；消费方：system-prompt/fs-tools/
session-query/collab-tools 的 owner 行）。无用户参与的 Agent 会话（机制唤醒/子 Agent 派生）按 tags 档
执行（子 Agent 继承父 tags——STRIPPED_TAGS 不剥模式词；传播语义同
router）。UI = 输入框工具栏「工具调用模式」下拉（跟随 Agent/标准/程序化/
无工具，选择即写 conv-settings；无 tc-programmatic 标签时程序化项禁选）。
**抉择组（2026-12 标签配置语义）**：tag-registry 目录条目挂 `exclusive` 元数据
（同组互斥）——access-tier（base/sandbox/full-access，base-access 显式进目录）、
tool-mode（tc-none/tc-base/tc-programmatic）、browser-tier（observe/manipulate/
inject，ac-web-tools 声明）。Agent 配置 UI（AgentPane）把组内 tag 合一为「启停胶囊 +
换档弹层」（TagChoice 组件：左半启停开关、右半 chevron 弹层换档）：落词规则
（ac-client-ui-agents/client/tagExclusive.ts 单源）保证同组至多一词——exclusiveNone 缺省词
（base-access/tc-base）选它/停用均不落词（缺席即语义，wire 形态不变）；
browser-tier 选高层词连带写齐全部低层词（requiredTags AND 地板）。判定面（tierOf/toolModeOf/browser 层级门禁）不消费抉择元数据——落词
一致即语义等价，纯展示/配置层升级。
「新会话跟随上次选择」（composePrefs.toolMode + toolModeInherit 登记，
2026-09-17 恢复）：ChatInput 挂载回读时，目标会话无显式 toolMode 键 →
回放偏好并写该会话（覆盖必须落存储才生效）；'' 跟随态无需写；Agent
无 infra 时程序化不继承（跟随态兜底）。存量旧 `programmatic` 布尔键
读侧失效（不迁移）。存量 `__programmatic__` 预设
会话前端防御性禁止续聊（输入框禁用 + 迁移提示，历史只读保留）。ac-run-code
工具行 + SDK 投影纯库 ac-run-code-core：模型写一段可擦除 TS 程序经
`tools.<name>(args)` 编排成批工具调用，最终结论经复合返回协议回上下文
（return 有值 → value=valueVia'return'〔null 视为无值〕；无值有 log →
按序合成 valueVia'logs'；失败/中止附 logsTail）。步记录 = 摘要 + trace 子调用时间线 + programHash，程序体
全文入 host 日志。**投影注入**
（loop/before-run 主档）：仅程序化调用（互斥形态——LLM 生效面单

schema 仅 run_code）时 system 尾部追加投影块（SDK 声明 + 程序书写

纪律——字典序稳定，KV cache 前缀友好）；形态
判定读 run 级 request.tools 终值（开关收窄不落 Agent 配置）。子调用带
`runCodeSubcall` 标记（ToolCall 开放词汇 + ac-session 补行 `subcall`
字段，2026-09-17 方向 B 补 `name`/`arguments` 随行落盘）。**子调用
平铺**（方向 B 重构）：编辑类子调用此前只在 run_code 卡的 trace 摘要里
——文件编辑追踪/diff 全盲。现在：① `records({subcalls:true})` 投影把
subcall 补行注入宿主步 `steps[].toolCalls`（按 `<runId>#<seq>` 前缀定位，
subcall 标记；UI 历史面开启，LLM 回放面 history() 纯净不受污染）；②
直播面 feed-core 按 `runCodeSubcall` 直接平铺建独立工具卡；③ 渲染层
subcall 卡片带缩进样式（紧跟 run_code 卡、复用各工具结果卡片组件）。同源纪律：`resolveEffectiveTools`
（ac-run-code/src/tool.ts，scope 两口径——'llm' 与 router 可见面合成
同链、'projection' 能力面授权真理），递归防护 = 投影排除 run_code
自身。安全：子调用一律 `ctx.tools.execute`（能力轴/档位/黑名单/扫描/
脱敏/事件面全自动生效）；worker = containment 非 boundary（只做资源
约束 computeMs/maxWallMs/
maxOutputBytes + unref + 中止）。并发纪律：写路径（WRITE_PATH_TOOLS）∪
命令（COMMAND_TOOLS，单源 import 自 ac-security）按提交序串行，其余
并行。worker 引导（2026-09-17 实验结论）：esbuild 单入口 bundle 对
`new Worker(new URL('./worker.ts'))` 类引用原样保留字符串、文件不进
bundle——bundle 形态走 build-bundle.mjs 第二入口产物 `dist/worker.mjs`
（运行时存在性探测：dev `./worker.ts` → bundle 同目录 `worker.mjs`）。

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

ac-conversation 的上下文 = 每 run 经 history 从文件重派生（2026-11 视图
增量层退役——增量投影两次漂移后退役，S3 由构造保证）。

run 周期走 **journal（partials.jsonl，2026-11 泛化）**：步行/注入行/直调补行

按消费点真序落台账（messages.jsonl 在 run 期间静默——单一写面）；run 收束

（全终态）→ settlement 同步入队（切段物化：注入行是切分点，

`[user, 段行(steps), 注入行, 段行(steps), ..., run-settled]`）+ 异步 durable 与 journal

剔除（收束即清）——提升批成员统一携带 run 键〔组存在性 = settled 判定，无单点锚〕；收束行已退役（切分形态终文本在尾段末步，无切分 = 整 run 单行直落），注入行 timestamp 还原 journal 落行时刻；崩溃窗口/孤儿 run 由 recoverJournal 惰性幂等收口

（records()/run-started 触发）。subcalls.jsonl 是子调用永久档案（UI 回放

数据源，不清理——与 journal 生命周期相反）。

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
| tools | `ac-tools/src/contract.ts`（执行身份 + requiredTags 能力轴 + needPermission 权限轴 + injection 注入轴〔capability/mode〕 + requiresInteraction 交互轴〔self 会话排除，判定单源 conversationFormOf——ac-agents〕 + elevation 机制提权） | `ac-tools/src/events.ts`（tool/*） |
| agentLoop | `ac-agent-loop/src/contract.ts`（transform-step/run seam） | `ac-agent-loop/src/events.ts`（loop/*，三档装配链） |
| agents | `ac-agents/src/service.ts`（AgentConfig + settingsOf/displayNameOf + tierOf 档位单源） | `ac-agents/src/events.ts`（agents/updated） |
| router | `ac-router/src/service.ts`（RouterInbound 信封） | `ac-router/src/events.ts`（router/*） |
| conversation | `ac-conversation/src/contract.ts` | `ac-conversation/src/events.ts`（conversation/*） |
| session | `ac-session/src/index.ts`（append/records/history/compact/setShelf） | —（积累订阅 router/* + conversation/steered） |
| group | `ac-group/src/contract.ts` + `view.ts`（`<msg>` 包装） | `ac-group/src/events.ts`（group/*） |
| singles | `ac-singles/src/contract.ts`（引用 + 覆盖模型；fork 会话分支——消息切片经 session 服务方法拷贝） | `ac-singles/src/events.ts`（singles/updated） |
| convSettings | `ac-conv-settings/src/contract.ts`（会话级模型覆盖） | `ac-conv-settings/src/events.ts`（conv-settings/updated） |
| memory | `ac-memory/src/index.ts` | — |
| config | `ac-config/src/service.ts` | `ac-config/src/events.ts`（config/*） |
| credentials | `ac-credentials/src/service.ts` | — |
| agentStore | `ac-agent-store/src/service.ts`（+ 文档实体 saveDoc/readDoc） | — |
| agentPresets | `ac-agent-presets/src/index.ts`（预设模式注册中心：register/list/defaultPreset + 物化语义） | — |
| subagents | `ac-subagent/src/service.ts`（持久多轮实体） | `ac-subagent/src/events.ts`（subagents/updated——spawn/started/settled/stopped/removed 统一通知，前端子Agent 清单帧驱动刷新，2026-12 持久化清单主源化） |
| jobs | `ac-jobs/src/contract.ts`（JobStartSpec/JobHooks/JobSnapshot） | `ac-jobs/src/events.ts`（job/started·settled） |
| browser | `ac-web-tools/src/browser.ts`（守护进程命令配置） | — |
| durableInteraction | `ac-durable-interaction/src/types.ts` + `store.ts` | `ac-durable-interaction/src/service.ts`（durable-interaction/{opened,replied,closed}；核领域无关——ask_questions 工具住 ac-ask-questions，approval 语义住 ac-security） |
| timers | `ac-timer/src/service.ts`（TimerRowOptions；条目级 activeHours 活动窗口 + gate 预检门——静默判定前置调度层，LLM 零 token 跳过） | — |
| archive | `ac-archive/src/service.ts` | `ac-archive/src/events.ts`（archive/completed） |
| usage | `ac-usage/src/index.ts`（双轨聚合桶 + bySelfSession 自会话成本观测） | — |
| backup | `ac-backup/src/index.ts` | — |
| workspace | `ac-workspace/src/index.ts`（agentWorkdir/sandboxWorkdir 唯一事实源 + pickFolder 原生选择·纯模块 native-dialog.ts） | — |
| webServer | `ac-web-server/src/contract.ts`（RouteCall/RpcHandler/RpcCaller） | `ac-web-server/src/events.ts`（ws/ack + ws/connection-*） |
| remoteLink | `ac-remote-link/src/contract.ts`（RemoteDevice/PairingSession/RemoteLinkStatus；Noise 纯库 `ac-noise-core`——XK/KK 握手 + AEAD 帧，M1） | `ac-remote-link/src/events.ts`（remote/device-paired · device-revoked · device-online · device-offline） |
| webui | `ac-webui/src/service.ts` | 同文件（webui/extensions-changed） |
| （退役）uiExtensions | ~~`ac-webui-extensions/src/service.ts`~~ M30 D7 退役：生产链路零消费（第三方 UI 走 manifest.ui → webui.addEntry → 浏览器 SlotRegistry）；词汇表 slotCatalog 留包转纯库 | — |
| pluginRegistry | `ac-plugin-registry/src/service.ts` | 同文件（plugin/before-load(W) + installed·reloaded·catalog-changed(E)） |
| eventPolicy | `ac-event-policy/src/service.ts`（停用键/清扫/行聚合） | —（治理 seam = internal/listener bail，非公开事件） |
| agentAdmin | `ac-agent-admin/src/service.ts`（AdminUpdateResult） | — |
| skills | `ac-skill/src/index.ts`（三源技能发现 + 注入三通道：手势 before-run 判定落账 / run_code 子调用登记+收束落账 / 直调 steps 回放） | — |
| mcp | `ac-mcp/src/index.ts`（全局服务器注册，懒建连） | — |
| goals | `ac-goal/src/index.ts`（会话桶目标 + goal-round 驱动） | — |
| todos | `ac-todo/src/index.ts`（会话桶工作清单） | — |
| bench | `ac-bench/src/contract.ts`（套件/用例/对拍规格/报告） | `ac-bench/src/events.ts`（bench/run-started·case-settled·run-completed） |

**客户端服务面（浏览器运行时，M27 起）**：类型身份 = `ClientContext`
（`ac-client-runtime` 导出；声明合并目标为该包，**不 augment
'@agentchat/cordis' 的 Context 接口**——防与服务端服务名 TS2717 撞型，
`ac-client-runtime/tests/client-context-identity.test.ts` 静态锁定交集
为空）：

| 域（ctx 键） | owning 包 | 事件目录 |
|---|---|---|
| slots（浏览器） | `ac-client-runtime/src/slots.ts`（SlotRegistry：declare/register/entries + 渲染器 install boot-once；声明轴 kind/scope/factory/public/highRisk + M30 elect〔keyed 选举席〕/data〔数据席位，免 component〕；纯核 SlotCore 住 ac-client-slots） | `ac-client-runtime/src/events.ts`（slots/changed，emit·host） |
| objects（浏览器） | `ac-client-runtime/src/objects.ts`（层 2 跨切只读对象层骨架：define/get/keys） | — |

## 纯库清单（零 cordis 依赖）

协议实现与重算法住纯库，薄行只留 inject + register 胶水；纯库可被多个薄行共用、
可独立单测。

| 纯库 | 职责 |
|---|---|
| `ac-core-utils` | 跨行共享基础纯函数/协议常量（GROUP_HINT_META/isGroupHint、maxSeqOf——只收会成运行时环/反向依赖的最小词汇） |
| `ac-openai-completions` | OpenAI 兼容协议：SSE 流式 + tool_calls 分片 + chat 聚合 + listModels + 无进展超时（缺省 180s）+ 多模态附件物化（visionModels 门控，非视觉模型 fail-closed 剥离） |
| `ac-config-merge` | deepMerge/computeDiff 差异配置 |
| `ac-edit-core` | 编辑引擎：三级模糊匹配（trim 级只定位不替换 + 三级交叉唯一性）/写回前语法预检（配平失败报错带「第 N 行第 C 列 + 行预览」定位）/readback 回显/增量 diff/行尾保留（old/new 自动 LF 归一化匹配 + CR 双写损伤修复——2026-11-19 画像 Ⓑ）/失配定位线索（最接近行 + 行尾统计）/文件突变队列 |
| `ac-sandbox-core` | createSandboxResolver/bash 命令扫描/输出脱敏/agentSpaceRoots（读写侧基准分叉并根） |
| `ac-text-budget` | token 估算/代理对安全截断 |
| `ac-glob-core` | glob→RegExp + 有界 walk（SKIP_BASE/SKIP_DIRS 分层缺省——产物目录缺省跳过，skipDirs 整表覆盖 + skippedRoots 透出） |
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
| `ac-client-slots` | 浏览器侧 SlotCore 纯核（M27 S0）：string key 声明账本 + order/single-list/disabled + 装载校验 + 卸载级联；注册面签名按 D2 终态形状占位（cell/priority/store/children）——零 cordis、零框架依赖 |

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
├── ac-agent-presets/        预设模式目录（ctx.agentPresets）：注册中心——数据行
│                            注入预设定义（register 即归属）→ ctx.agents 物化 +
│                            默认池模型解析（config/changed 热更）；skip-if-present
├── ac-agent-presets-builtin/ 内置预设模式数据行：__standard__/__dsh_minimal__/
│                            __creator__（标准/极简/创造）注入预设目录——插件注入
│                            自有模式走同一注册面；无记忆语义 = 预设软停用
│                            memory/skill/datetime 等行（创造模式例外保留 skill——
│                            用户技能照常加载；插件开发指南经 system 提示词内置）
├── ac-agent-store/          Agent 数据目录 owning（ctx.agentStore）：config.json +
│                            机制 entries（timer/skills 等唯一写口）+ 文档实体
│                            （AGENTS.md 等）；getAgent 读边界归一（旧 hooks→settings）
├── ac-singles/              独立会话元数据（ctx.singles）：会话 = 引用 + 覆盖而非
│                            拷贝；自动标题（run-started 暂存 → 首步 after-step
│                            结合 Agent 思考生成，after-run 兜底；update(title)
│                            手改覆盖）；[system+tool schema] 前缀快照（修订键
│                            锚定，漂移对拍告警）
├── ac-conv-settings/        会话级覆盖域（ctx.convSettings）：按 conversationId 的
│                            模型覆盖（name@model）；deliver 边界单点生效
├── ac-group/                群拓扑（ctx.group）：成员表 + 单通道内容流（post = 群
│                            本体唯一入账口）+ GroupFeed 锚点增量 + historyFor
│                            viewer 投影 + 群聊行为契约注入 + 记忆属主共享注入 + 轮转
│ ── 系统提示装配行（loop/before-run* 落点，见端到端链路）─────────
├── ac-persona/              人设注入：<persona> 块（file 优先 text 回退；裸名走
│                            agentStore 文档、路径走文件系统）
├── ac-system-prompt/        系统提示词分块装配器：静态块（系统环境/术语约定/指引
│                            ——条目级工具门控；独立会话形态不注入多 Agent 协作/
│                            主动安排/系统管理条目）落主档 + 对话信息块落尾档（prepend
│                            居前）；override 全量覆盖静态块
├── ac-memory/               长期记忆（ctx.memory）：键 = 对键/群 id（singles 重定向
│                            对用户对桶）；文件 = files/<agentId>/memory/<会话键>.md，
│                            LLM 经 fs 工具亲自维护；token 预算截断注入
├── ac-datetime/             日期注入：singles 走日快照行（主档）；其余会话 system
│                            尾部仅日期行（尾档绝对收尾）——KV 前缀跨轮稳定
├── ac-skill/                技能目录（ctx.skills）：全局/本 Agent 专属/会话工作区
│                            三源发现 + <available_skills> 注入 + load_skill 工具 +
│                            /name 用户显式调用手势（每条消息至多服务一次——同 run
│                            多步不重复注入，新 run 重新服务）
│ ── 任务追踪（状态经消息面到达模型，不改写 system）──────────────
├── ac-goal/                 长期目标（ctx.goals)：goal-round 驱动（after-run 续投
│                            <goal_round>，error/上限自动暂停）+ goal 工具；
│                            agentStore entry 'goal' 持久化
├── ac-todo/                 待办清单（ctx.todos）：会话桶工作清单 + todo 工具
│                            （write 全量重写/read；上限 50 条）+ **client/
│                            半边**（M27 S3-1a 行包双半边首例——todo 工具卡
│                            + 任务 dock 卡 + 数据管线随行走，行卸载即
│                            前端消费面一并消失）
│ ── 工具基建与安全 ─────────────────────────────────────────────
├── ac-tools/                工具注册中心（ctx.tools）：fiber 归属注册
│                            （listWithOwner 目录视图）+ waterfall 拦截链 +
│                            requiredTags 能力门禁 + injection 注入轴
│                            （capability 常规 / mode 模式合成——不进常规面）+
│                            requiresInteraction 交互轴（self 自会话 a~a 排除，
│                            conversationFormOf〔ac-agents〕，list_tools/
│                            run_code 投影同口径）
├── ac-jobs/                 后台任务注册中心（ctx.jobs）：owner 分桶 + 并发上限 +
│                            settle first-wins + job/started·settled（登记即发）
├── ac-security/             安全行（access-tier）：双轴门禁（requiredTags
│                            能力轴 + needPermission×档位权限轴，含有人桶
│                            询问提权 durableInteraction approval）+ 双黑名单
│                            （accessDenyPaths 读+写双禁 / readDenyPaths 仅读
│                            禁）+ bash 扫描 + 输出脱敏 + 唆使防御注入
├── ac-subagent/             子 Agent（ctx.subagents）：持久多轮实体（spawn/send
│                            [async·sync·steer·next-run 四投递语义]/await/list/stop/
│                            delete）；落盘 <root>/subagents/<subId>/ 三文件（2026-12
│                            对齐 sessions 域 run journal 裁决：messages=定稿流+run
│                            键 / partials=journal 收束即清+崩溃恢复 / subcalls=
│                            run_code 子调用档案）跨重启续聊；跨 run 上下文轨迹
│                            复放（expandSteps——探查型 run 不失忆）+ 展示面
│                            journal 活投影（运行中 partials 可见）；每 run job 登记（usage
│                            记账落 subId 名下）；会话行 = SessionRecord 中性格式
│                            兼容形（settlement 切段物化；historyRecords 展示投影
│                            墓碑可读；回放口径不变——steps 不进子上下文）
├── ac-durable-interaction/  持久化暂停点核（ctx.durableInteraction）：write-ahead 状态机
│                            （open/reply/close 幂等，领域无关）+ 一周保留期
│                            sweep（终态过期清理 + 多代行折叠；pending 永不清；写口后
│                            懒触发一次性定时器，空闲零定时器）——kind 词汇由各行认领
├── ac-ask-questions/        ask_questions 工具行：批量提问等待决策（kind='ask_questions'
│                            认领者；选项归一化防模型不守 schema）+ late-reply 唤醒
│                            （run 已死作答回投 + backfillToolResult 补记）；
│                            requiresInteraction:true——自会话桶（机制 run）无人
│                            应答，不投放
├── ac-mcp/                  MCP 行（ctx.mcp）：全局服务器注册（懒建连）+ 工具发现
│                            注册进 ctx.tools（撞名 `${server}__${name}` 前缀）；
│                            放行走行 config，per-Agent 暴露走 AgentConfig.tools
│ ── 工具行（行组合决定装载；描述约定一句话由 owner 行教语法）─────
├── ac-fs-tools/             文件读写：read（行号分页 + token 截断；读不设防
│                            §9.1——只过双黑名单）/write（突变队列串行；tierOf
│                            感知基线）/edit + @<路径> 引用约定
├── ac-fs-search/            检索：glob（mtime 排序/上限 100）+ grep（正则/include
│                            过滤/二进制跳过/上限 250/fixed 字面量直通/近邻目录
│                            建议）；结果集过滤双黑名单；walk 缺省跳构建产物目录
├── ac-str-replace-editor/   四合一编辑器：view/create/str_replace/insert（写经突变
│                            队列；requiredTags ['fs_minimal']）
├── ac-shell-tools/          命令执行（平台拆分 2026-09-16）：pwsh（Windows；
│                            Unix→PS fail-closed 翻译 + UTF-8 前缀）/ bash
│                            （Unix 纯透传）+ job 管理。前台流式 onProgress +
│                            超时处置 timeoutAction（handoff 缺省：超时自动转
│                            后台 job 继续执行不杀进程；kill = 树杀旧行为；
│                            settings.shell-tools 分层）+ 后台 job 登记
│                            （requiredTags ['shell']；needPermission——档位门）
├── ac-run-code/             程序化模式 PTC 内核（2026-09-17 P0）：run_code
│                            工具行（requiredTags ['code-exec']）——模型写
│                            可擦除 TS 程序编排成批工具调用；主线程桥接
│                            （ctx.tools.execute 全安全面）+ worker containment
│                            （资源约束；引导双入口：dev worker.ts / bundle
│                            worker.mjs）。程序化 = 会话级开关（conv-settings
│                            programmatic + router 收窄 LLM 面——research §十
│                            开关化，__programmatic__ 预设已退役）
├── ac-run-code-core/        run_code SDK 投影纯库：生效工具集 → 可擦除 TS
│                            声明文本（字典序稳定——KV cache 前缀不变量；
│                            零 cordis 依赖）
├── ac-math/                 数学：纯表达式解析求值（白名单常量/函数 + BigInt 混算 +
│                            资源护栏；无 node:vm）
├── ac-web-tools/            网络：web_search（requiredTags ['web']，needPermission
│                            ——非 LLM 出口通道 D2）+ browser 守护
│                            进程（ctx.browser：请求队列/dispose 杀进程；
│                            observe⊂manipulate⊂inject 动作分层门禁）
├── ac-sap-adt/              SAP ABAP ADT 工具行（46 个 adt_* 工具；引擎 =
│                            @nefevcore/abap-adt-core 纯内核；requiredTags
│                            ['sap-adt']；demo 目的地默认开启，零 SAP 端到端可用）+
│                            preset.ts 子行：ABAP开发模式（__abap_dev__）注入
│                            预设目录（tags 即工具面：sap-adt/shell/web，与
│                            标准模式同构）——工具面与预设面独立装配
├── ac-collab-tools/         协作：send_agent（经 conversation，busy=steer/wait=
│                            next-run；空闲投递回复文本随结果直返 reply 字段；
│                            子 Agent 发信对桶归一到父 pairKey(parent, to)——
│                            防幽灵 sub~to 桶，用户在父口径会话可见）/
│                            send_group/list_*/read_agent_info/
│                            update_agent_profile + @<名称> 引用约定
├── ac-dev-tools/            开发辅助：read_logs（环形缓冲）/reload/reload_modules
│                            （语义化中断）
├── ac-restart/              system_restart 工具（中断上报 + after-run 宿主半边：
│                            优雅关闭 → exit 42 → supervisor 重拉；正常工具
│                            无会话形态限制）
├── ac-session-query/        会话查询门面：grep_history/read_history（复用
│                            ctx.session.history()）+ #<标题>(<会话id>) 引用约定
│ ── 评测域 ─────────────────────────────────────────────────────
├── ac-bench/                评测跑批（ctx.bench）：套件注册中心 + 单会话跑批——
│                            逐用例合成临时工具（用后即焚）→ agentLoop 机制 run
│                            （ARCHIVE_REVIEW meta：不入会话账/不记 usage）→
│                            实际调用对拍（多重集回溯匹配）→ 报告聚合；BFCL
│                            单轮适配器先行（v1/v3 双数据形态宽容解析）；
│                            CLI = pnpm bench（缺省脚本化冒烟零 LLM）
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
│                            上下文/累加 = 总用量 + cache + steps + elapsedMs API
│                            计时〔token/s 速率分母，不含工具/编排〕）→ 多维查询
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
│                            conversationWorkspaceRoot 唯一事实源（singles 挂载
│                            工作区 = 会话级工作目录：基准/提示词 [工作目录] 指向
│                            工作区根，白名单并面冗余保留）+ 本机目录浏览
│                            （browse-dirs）+ 原生文件夹选择（pick-folder；
│                            纯模块 native-dialog：win32 IFileDialog/darwin
│                            osascript/linux zenity→kdialog，10 分钟超时兜底）
├── ac-job-wakeup/           job/settled → deliver(source:'event') 通知 owner（与
│                            ws-bridge 同事件两订阅方）
│ ── 传输与可视化（核心域零 UI 知识）────────────────────────────
├── ac-web-server/           传输基座（ctx.webServer）：HTTP 路由注册中心 + WS 广播/
│                            心跳 + rpc/call 显式分发表 + requestId 幂等去重 +
│                            静态托管/SPA（Node 原生 http，零 express）
├── ac-ws-bridge/            WS 事件桥接订阅行：emit 面（router/*/loop/*/llm/delta-*
│                            等）→ WS 帧（type=事件名直转）；后台会话过滤；群 hint
│                            帧不广播（群内容唯一源 = group/message-posted）
├── ac-remote-link/          远程链路核心端行（ctx.remoteLink，M1）：出站 relay + Noise
│                            E2E 壳 + 设备注册表（known_devices.json）+ 配对状态机
│                            （二维码/SAS）+ scopes 闸门 + deliver 恒剥 elevation
├── ac-noise-core/           Noise 协议纯库（零 cordis 依赖）：XK/KK 握手状态机 +
│                            ChaCha20-Poly1305 帧封装 + SAS 派生（纯 node:crypto）
├── ac-client-ui-remote/     远程设备设置节前端行（P1）：设备列表/吊销 + 配对
│                            向导（二维码 URI + SAS 比对）——remote/* RPC 消费
├── ac-web-api/              WS RPC 业务方法注册薄编排行：conversation/session/
│                            agents/group/singles/usage/timer/backup/config/llm/
│                            plugin/events/system 全套 + jobs/list·kill（运行
│                            跟踪清单）+ subagents/list·stop·history（子Agent
│                            面：注册表清单跨重启 + 停止推理 + 消息全形读，
│                            墓碑可读）
│                            + 扩展目录聚合（collectExtensionCatalog）
├── ac-agent-admin/          Agent 管理面（ctx.agentAdmin + 写侧 RPC）：CRUD（白名单
│                            fail-closed + deepMerge 补丁 + 变更报告）+ 装配视图
│                            （agents/assembly）+ system-prompt dry-run（三档干跑）
├── ac-webui/                Web UI 表面（ctx.webui）：插件 UI 扩展 entries 清单 +
│                            /ui-plugin/ 静态 + extensions-changed + **boot graph
│                            下发**（declareClient 行声明 + /api/ui/boot-graph，
│                            M27 S3/D7——行卸载级联收缩）
├── ac-webui-extensions/     第三方 UI 插件声明词汇表（纯数据面，M30 D7）：
│                            LEGACY_SLOT_CATALOG 永久别名目录（旧 8 UISlotId →
│                            新席位键）+ 高危名单；服务端 slot 注册表已退役
├── ac-client-slots/         浏览器侧 SlotCore 纯核（M27 S0；纯库见上表）
├── ac-client-runtime/       客户端运行时（M27 S0）：ClientContext 类型身份
│                            （D22）+ SlotRegistry（caller-fiber 级联回收 +
│                            'slots/changed' 事件桥 + install(renderer)
│                            boot-once）+ 层 2 对象层骨架 + 组件级 fiber
│                            （useContext/wrapComponent）+ **ctx.rpc/sessions
│                            契约面**（行 client 半边调宿主 RPC/会话协调的
│                            统一面，含 onEvent 事件帧订阅）+ lastContext
│                            小件 + **isolated-runtime**（iframe 档运行时，
│                            D21 迁入——webui 侧留入口 shim）
├── ac-client-ui-{runview,     **前端行全族**（M27.1 + M27.2-2 + M28 P0/P1/P2，
│   todo,jobs,workspace,       D19 改裁：前端插件一律 ac-client-ui-* 独立包
│   singles,group,agents,      ——包名即身份；cordis.yml/TREE 各占一行、
│   goal,usage,skill,          各自可独立摘除）：**二十七行** = runview（S3
│   system,timer,shell,        首例改名）+ 六域（todo/jobs/workspace/
│   fs,web,browser,            singles/group/agents）+ **四+一域行**
│   subagent,search-pool,      （M28 P1 §4.1 原案：goal 工具卡+dock 条 /
│   llm-pool,plugin-registry,  usage 用量面板 / skill 技能读面 / system
│   theme,renderer,tool,       版本弹窗+系统小 API / timer 定时视图）+
│   sidebar,conversation,      **五工具卡行**（M28 P2 §2.2 镜像表：
│   settings,layout}/          shell/fs/web/browser/subagent——tool 宿主
│                              退化零卡；subagent 行兼营**子 Agent 会话
│                              只读视角**〔main:perspective 贡献 order 9，
│                              运行跟踪面板点击进入——历史回放复用
│                              conversation 渲染内核，session-view-plan〕）
│                              + **settings 退化三行**
│                              （M28 P2：llm-pool 连接池〔2026-11 收窄
│                              llm 单节〕+ search-pool 搜索引擎池〔2026-11
│                              拆行〕+ plugin-registry 插件库四件——
│                              settings 壳经 settings:section 选举席消费）+
│                              **基础七件**（M27.2-2 出包，phase:'base'
│                              封印前批次：theme 主题 / renderer 渲染
│                              地基+markdown 管线 / tool 工具卡 / sidebar
│                              活动栏+三面板壳 / conversation 会话视图族+
│                              ctx.sessions / settings 设置面板族 /
│                              layout 应用壳 root+六 seat 声明——webui
│                              零基础件残留；M28 P1 起四视角/文件预览/
│                              建群/用量/版本/矩阵/工作区树 = 域行席位
│                              贡献，AppFrame 退化为近零内联壳）。
│                              宿主半边仅声明 boot graph（派生名 ui-<名>
│                              = 行 id = ExtensionMeta name 三处同名）；
│                              client 半边 = 域投影 + slot 贡献 + 视图
│                              资产；包间消费走服务面/inject/包内门面
│                              （rpc 经 RpcClientFace 契约面）。与后端行
│                              经 RPC/REST 契约面耦合，**双向可独立摘除**
│                              （卸 UI 行 → 前端消费面消失后端在；卸后端行
│                              → UI 行照常装载 RPC 失败静默空态）；行间
│                              依赖走 inject fiber 等待（ui-group/
│                              ui-singles inject roster——ui-agents 行
│                              提供，装载序无关）；**跨席位贡献统一经
│                              slots.inject 声明存活期效应落位**（M28
│                              P0-2：席位在场即注册/缺席即等待/塌缩或
│                              卸载即回收）
├── webui-kit/                **@agentchat/webui-kit 设计原语库**（M27 S4/D0
│                            基建三包之三）：tokens/row/badge 三 css + Icon/
│                            Button/Avatar/Modal 基础原语 + StatusDot/Tooltip/
│                            RingProgress 工具组件 + StarAvatar/StarCard/
│                            PulseTrace 组合件 + 思维链图标族（纯库不进行）
├── webui/                    前端薄壳（Vue；M27.2-2 终态）：main.ts =
│                            装配序列（createClient → install(vueRenderer) →
│                            rpc 宿主面 → 封印 → applyBootGraph('base'→
│                            'domain')〔含热通道〕→ sessions.init →
│                            initUiExtensionHost → mount(renderSlot('root'))）；
│                            **基础七件全部独立 ac-client-ui-* 前端行**
│                            （M27.2-2 出包——webui 零基础件/零域插件，
│                            clients/ 目录已除役）；剩余 = runtime 胶水
│                            （bootGraph〔热通道〕/rpcClient/wireFace/
│                            clientRuntime）+ core/extensions bridge
│                            （第三方 UI 插件注册面 + 三注册表 re-export
│                            门面）+ api/wire·extensions 传输面（M28 §4.2
│                            门面层退役——其余 11 域门面已除役，测试族
│                            直连 owning 包）+ utils/shims + 构建入口
│                            + dist（stores/ 门面已除役——组件消费包内
│                            pinia 门面，测试直连核心工厂）；D23-B 视觉
│                            快照零像素回归门（AGENTCHAT_VISUAL=1）
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

历史决策、裁决点与事故档案住本目录（多数"新"能力已有踩坑沉淀——动手前先查）；

**已收官里程碑的过程文档**（计划/评审/交接/复审）冻结于 `archive/` 与仓库外

归档根（见下方注——被取代的裁决不是待办，勿"顺手恢复"）：

| 分组 | 档案 |
|---|---|
| 总览 | `architecture-diagram.html`（架构图可视化） |
| 会话与 LLM 域 | `session-design.md`（域深设计事实源）· `llm-provider-model-plan.md`（池 v2 + name@model）· `llm-protocol-extensibility.md`（备忘未实施）· `multimodal-vision-input.md`（多模态视觉输入） |
| WebUI | `m24-m25-ui-prototype.html`（目录 IA 原型稿）· `ui-descriptive-text-inventory.md`（描述性文本清单 · tooltip 改造素材）· **`ui-rows-and-slots.md`（现行行/席对照事实源）** · **`webui-slot-tree.md`（调研树 + 实施注记）** · **`webui-component-tree.md`（前端 Vue 组件组合关系树——与 slot 树分工：席位语义 vs 组件父子/复用）** · `webui-plugin-ownership.md`（配对表事实源；物理落点已被 D19 改裁为行包 client/ 半边）· `webui-koishi-console-research.md`（Koishi Console 源码研究——root 即 slot 生态实证）· **`m30-slot-semantics-refinement-plan.md`（席位语义收口裁决——elect/data 轴 + D6 装饰批次容器裁决 + D8 翻盘条件）** · `archive/`（M27-M29 过程档案冻结） |
| 系统提示词 | `system-prompt-optimization-plan.md`（v3 逐块裁决）· `system-prompt-assembled-example.md`（最终装配示例） |
| 治理与插件域 | `event-graphs.html`（事件图谱可视化）· `subagent-session-view-plan.md`（子 Agent 会话展示——2026-12 计划，P0 已随 subagents/history 落地） |
| 审计与精简 | `edit-tool-incident-report.md`（edit 工具事故分析 + 护栏落地实录） · `run-code-usage-profile-2026-09-20.md`（run_code 使用画像三批次：重度开发/journal 泛化/机制验证——失败形态与优化线索纵向对比） · `run-code-hardening-backlog.md`（2026-11-19 DX 五连修后遗留立项：worker 防退化护栏/转义税/lib 注册表自愈 + worker 死锁事故实录） |
| 专项 | `tavern-interop-plan.md`（SillyTavern 互通，待实施）· `remote-client-relay-plan.md`（本地多端远程接入，待实施）· `sap-adt-config-layer-bug.md` · `polish-backlog.md`（打磨残留条目 + 边界备忘） |
| 安全 | `security-access-tier-plan.md`（安全模块重设计：访问档位 tag 三档 + requiredTags×needPermission 双轴门禁 + source:'event' 信封临时提权 + 唆使提权防御注入 + 读黑名单——已实施） |
| 标签系统 | `tag-system-report.md`（词表/机制/归属/守则全貌）· `tags-include-semantics-report.md`（× tools.include 语义裁决） |
| 工程规范 | `epoch-marking-convention.md`（**注释 YYYY-MM 时间标记规范**——标记 = 特性批次代号而非日历月：计划纪元沿计划批次、即兴改动用真实当月；存量超前标记保持原样勿顺手统一） |

> **归档根**（2026-12 起）：收官里程碑终稿（M7-M25 计划、m15/m16/m17 对账套件、
> WebUI 适配器系列、程序化模式三件套、T0/精简审计、src→preview 映射图）已移至
> `C:\Users\xiaofeng\Documents\Dev\Note\AgentChat\docs-stale-2026-12\src-docs\`；
> 更早批次见 `docs-pre-refactor-2026-09\` / `docs-stale-2026-09\`。需要历史决策
> 上下文时按文件名检索归档根。

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
| M15 | 对账收官（六轴对照 + 补齐 13 项；过程档案已归档 `docs-stale-2026-12\src-docs\m15-reconciliation.md`） |
| M16-M18 | WebUI 原生重写 → UI 对账补齐 → 布局风格对齐（M16 后经同源迁移回滚，分支 archive/webui-native-m16 留档） |
| M19 | user 去特殊化——全对键桶模型（pairKey 对桶 + sender/source 分离） |
| M20 | 归档分支回归——会话内整理 run + 失控防线（maxSteps 128 硬闸） |
| M21 | 回放正确性与 KV 前缀稳定——中性行格式 · 视图派生 · 前缀快照 · 群存储统一 |
| M22 | 扩展与工具/插件库 cordis 原生化 |
| M23 | Agent 自开发插件——免审安装闭环 · 熔断/安全模式 · 行偏好层 |
| M24 | 全局默认层与目录信息架构——settings 收口 · 目录 IA · 市场首期 · 能力收敛 · audit 轮转 |
| M25 | 事件治理与行树治理——agentGate · 事件清单 · ac-event-policy · include 热通道 |
| M26 | 群聊行为对齐——群契约注入 · 终稿不入群本体 · 角色投影 · MAX_AUTO_WAKES 群桶语义 |
| M27 | WebUI 纯 Slot 重构（**实施完毕**：S0-S4 全阶段——ac-client-slots/runtime/webui-kit 基建三包 · 壳插件化（root 即 slot）· 域插件化 · 行包双半边拆分 + boot graph 热通道（七行 client 在册）· bridge D8 收窄 + D13 公开子集 · desktop 构建与启动冒烟 ✓） |
| M28 | UI 插件树拆分——域资产归位 + 宿主退化（基础七件退化为席位声明/解析面/壳容器；一切视觉内容成贡献行叶子；stores/api 门面退役 + store 座位实例轴） |
| M29 | 行包依赖纪律修复——check-deps R6/R7 守卫 AST 化 + 数据面四域归域 + 环白名单定谳（复审 F1-F5 收编） |
| M30 | 席位语义收口——elect/data 词汇轴扶正 + 壳宿主条目化统一 + conversation:dock-widget 改名 + 服务端 uiExtensions 退役（D3 useSeatOccupancy 原语随主区/aux 选举化失去消费方，同批除役；`docs/m30-slot-semantics-refinement-plan.md`） |
| T0 | 安全与健壮性加固（传输面/math 逃逸/凭据链/重写窗口/JSONL 自愈/熔断双缺陷等，见 t0-audit） |
| 2026-09/10 增量 | subagent 多轮重构 · 群记忆收敛（记忆属主）· 写侧对齐读侧（基准分叉并根）· 多模态视觉输入 · A1 注册制目录 · 瞬时网络重试 · 引用约定一句话（@/#/技能名） |
| 2026-12 增量 | subagent 双改：run 超时缺省 300s → 不限（研究型长任务；timeout_s 正值仍可设看门狗）；run 身份未注册合成 → 派生注册（父身份编辑：preset 隐藏 + tags 剥 delegation/admin；信封装配补 system/llmParams/能力面终滤；update_agent_profile 拦 preset 自助改档） |