# src 能力全景 → preview 重写地图

> 生成于 2026-08-22。基于对 src 轨道 55+ 包的四域并行深度审查（核心运行时 / 工具执行面 / Agent 体验扩展 / 平台宿主）合成。
> 本文是 preview 轨道对齐 src 功能完整性的**主参考**：逐包映射、架构决策记录、事件目录演进、里程碑路线。

## 冷启动指引（新会话开工即读）

- **当前状态**（2026-08-22 M15 收官）：M0-M14 全量落地（详见 §6 各条）+ **M15 对账收官**：六轴逐项对照（工具/事件/配置/粒度/usage 回读/群）后补齐 13 项——ac-usage 持久聚合回读（boot 回读 jsonl 重建聚合 + byDay + conversationId 入账）、ac-timer-tools 工具面（timer set/list/disable）、ac-job-wakeup（job/settled → sender:'event' 唤醒 owner）、**ac-group 持久化**（group.json 成员表 + 本体 jsonl + 500k 轮转/30k 保留 + historyFor viewer 回放 + send 传 history 种子）、ac-conversation 待投持久化（next-turn 落盘/回放——pending-resume 最小闭环）、AgentConfig.tools include/exclude 对象形态（resolveToolNames 统一解析）、AgentConfig.llmParams 采样白名单透传、memory_append 工具 + 归档整理联动、agents.reassign（修覆盖注册 fiber 归属勘误）、system_restart 宿主半边（after-run → 优雅关闭 → exit 42）、插件工具门禁 dev→admin、send_agent virtual 拒绝（M18 改为放行+引导——目标为虚拟端点时投递进发送方 1v1 桶并明示"无自动回复"）、web_search/reload_modules 参数收敛回 src 正典。**显式缩水与理由见 `docs/m15-reconciliation.md` §三**（会话粒度对话级/per-target 印象/WS RPC 业务注册归 M7 等）。验证基线：`pnpm preview:typecheck && pnpm preview:test`（495/495 绿）+ `pnpm preview:smoke` + `pnpm preview:boot` + `pnpm preview:supervised`。
- **下一步 = M7**（可视化/WebUI）：**开工简报 `docs/m7-webui-plan.md`**（已有底座盘点 / WS RPC 业务方法注册表 / 事件面补齐清单 / 前端形态决策点 / src 参考索引 / 验收路径）。核心判断：传输设施全部就绪、缺口在接线层（registerRpc 零注册）与前端本体（src/ui/webui 为 Vue3 全家桶 234+ 文件，可移植或新写最小面）。
- **动工前**：两份技能（`.dsh/skills/agentchat-framework-dev` / `agentchat-plugin-dev`）会自动加载，其中"重写规约"五条铁规与"契约归属纪律"是硬约束；本图 §1 ADR 与 §3 逐域映射表决定形态，§4 资产清单里的 src 踩坑沉淀优先原样继承。
- **验证口径**：每个里程碑收尾跑全量 typecheck + test + smoke + boot；组合根双表（cordis.yml/TREE）保持一致（tree.test.ts 有防漂移守护）。

---

## 0. 方法论：src 机制 → preview 原语的七条通用映射规律

（四域审查独立收敛出同一组规律）

1. **钩子数组按"决策/变换/观察"三分**：src 七类钩子中改写输入的（runStart/stepStart/toolExecutionStart）→ waterfall `before-*`；塑造记录的（toolExecutionEnd）→ waterfall `transform-*`；纯观察的（stepEnd/runEnd）→ emit `after-*`。fallbackHook 收敛进 after-run 的 error 形态。
2. **ctx.emit 字符串事件 → domain/* 事件目录**：chat.* 18 类按域拆分——编排边界归 loop/*、token 流归 llm/delta-*、工具执行归 tool/*。归属标注（dialogId/agentId/correlation_id）从"每事件手工附加"变为信封字段/事件参数。
3. **名字驱动注册中心（hooks.register+collect）整体消解**：注册名→事件监听器（cordis ctx.on 随 fiber 撤销 = owner 过滤+卸载回收）；per-Agent 行为→AgentConfig.hooks[具名]；执行顺序→waterfall 注册序。
4. **Service 保持 Service，协议下沉纯库，实例变数据**：协议差异（DeepSeek/GLM 继承覆写）→ 纯库 provider profile；Agent/会话从"装配实例"变"注册表数据+信封"。
5. **手动装配（AgentAssembly/AgentLoader/bootstrap 固定行序）→ 组合根+inject**：目录扫描类装配变数据驱动行；大对象注入面整体消失。
6. **集中契约包 → owning package**：contracts/types 每块契约随其服务能力走（src 后期 dialog/view 下沉已是自救方向，preview 彻底化）。
7. **横切 util → cordis 生态行**：logger→plugin-logger-console；isSupervised→宿主进程层。不设 util 包。

**事件模式完整形**（平台域报告补全）：`before-*（waterfall 决策）→ started（emit 通知，新增）→ transform-*（waterfall 塑造）→ after-*（emit 通知终值）`。

---

## 1. 架构决策记录（ADR，重写期间有效）

### ADR-1 会话状态归属：新域 ac-conversation
ac-router 坚持"纯转发、零会话状态"；src 的有状态调度（convKey 串行化门、inbox 双队列、placement steer|next-run、MAX_AUTO_WAKES=3 防自激）**全部移入新包 ac-conversation**。steer 注入走 **Service 方法** `ctx.agentLoop.steer(handle, msg)`（能力调用铁律），非事件。router 保持无状态信封投递。

### ADR-2 中断最小方案
src 五类语义化中断（user-abort/tool-interrupt/reload-requested/restart-requested/max-steps）+ continue-patch（reload 后打补丁继续推理）→ preview 采用最小方案：`LoopRunResult.finish` 扩展 `'interrupted'` + `interruptReason` 字段。**放弃 continue-patch**（复杂度高、无 preview 原语；reload 场景由 fiber 回滚重载天然覆盖）。

### ADR-3 消息元数据不进核心契约
MessageSource（9 kind × 5 form）/agent_id/viewer 视角转换**不进 LlmMessage**。`<msg from name group>` 包装归 ac-group（拼接层），viewer 视角转换归 ac-session（history() 回放层）。LLM 层只收已合法的 OpenAI 形消息。

### ADR-4 per-Agent 插件启停缩水：显式接受
src 三层管控（presets allowlist → hooks 启用清单+顺序 → automatic）→ preview 两层（行组合=进程级装哪些；hooks[具名]=已装插件在该 Agent 的行为，含 `.enabled` 软停用）。**代价**：资源型插件（MCP 连接）无法 per-Agent 不装载。缓解：`hooks['mcp'].enabled=false` 只停注入不停连接。记录为已知语义差，不引入"每 Agent 子 context 装行"。

### ADR-5 持久化 owning service 规约
每个持久化域归 owning service，**消灭 src 的跨域越权写**（timer 直写 config.json、workspace 直写会话文件、read_agent_info 直读 memory 文件）：
- ac-session 拥有会话文件（toPersisted 行格式/message_id 幂等/writer 队列语义）
- ac-memory 拥有记忆存储；ac-timer 拥有 timer-state.json（原子写+心跳+停机补偿原样继承）
- 未来 ac-agent-store 拥有 Agent 数据目录（config/persona/skills/timer 条目）
- 会话键统一 conversationId（淘汰 chat~lo~hi 排序魔法与 group~ 前缀判别；群/1v1 差异在视图层）
- 机制任务不过 LLM（`__archive_all__` 字符串协议 → 服务方法直调）；"触发 Agent 干活"统一 `sender:'event'` 信封

### ADR-6 宿主中间层删除
ServiceRegistry/Runtime 单例/L4 聚合门面（ctx.l4）/setShutdownDeps 六依赖接线/PluginEventBus 汇点/SessionSnapshot 手工状态机 **全部删除**。消费行直接 inject 各域 Service；优雅关闭 = root fiber dispose 自动逆序（零接线）；重连恢复 = ac-session.history() 回放 + delta 流重订。

### ADR-7 顺序无关收敛规约
waterfall 执行序 = 监听器注册序（不可配置）。扩展插件必须采用"前置 vs 追加"的顺序无关收敛模式（persona 前置 `<persona>`、其余追加）——升格为编写规约写入插件 JSDoc。真正顺序敏感场景用"固定槽位"约定（块内容自带位置语义）。

---

## 2. 事件目录演进

### 现有（38 个，全部已实现并有测试；M10 新增 config/changed、conversation/steered；M11 新增 job/settled、durable-interaction 三事件；M13 新增 ws/ack、ws/connection-*、plugin 四事件、webui/extensions-changed）
llm/before-chat(W) · llm/chat-error(E) · llm/delta-start|delta|delta-end(E) · tool/before-execute(W) · tool/transform-result(W) · tool/after-execute(E) · loop/before-run(W) · loop/run-started(E) · loop/before-step(W) · loop/step-started(E) · loop/transform-step(W) · loop/after-step(E) · loop/transform-run(W) · loop/after-run(E) · router/message-received(E) · router/reply-completed(E) · **conversation/steered(E)** · group/created|deleted|renamed(E) · group/member-added|member-removed(E) · group/message-posted(E) · **config/changed(E)** · **job/settled(E)** · **durable-interaction/opened|replied|closed(E)** · **ws/ack(E)** · **ws/connection-opened|connection-closed(E)** · **plugin/before-load(W)** · **plugin/installed|reloaded|catalog-changed(E)** · **webui/extensions-changed(E)**

（M10 落地说明：conversation/steered = steer 注入通知——steer 走 agentLoop.steer 能力调用不经 router，ac-session 靠本事件入账；config/changed = 订阅刷新模式（载荷 path），替代 src 原地 mutate 保引用技巧。M11 落地说明：job/settled = 任务终态通知（first-wins 单发；替代 src onJobDone 私有 listener 数组）；durable-interaction 三事件 = write-ahead 时序的公开通知面——opened 落盘后发、replied 落盘后发（late-reply 唤醒依据）、closed 终止通知。M13 落地说明：ws/ack = 投递回执（deduped 传输层幂等命中/busy 会话忙入队或注入/parked 等空闲停靠；requestId 关联，ac-web-server 自有目录）；ws/connection-* = 连接通知（重连恢复订阅面：history() 回放 + delta 重订——ADR-6 恢复路径）；plugin/before-load(W) = 装载管道 gate seam（载体 PluginLoadCall{manifest, grants, sessionOnly}——gates 行变异授予或不调 next() 拒绝，import 前_fail-closed 代码不进进程）；plugin/installed|reloaded|catalog-changed = 安装/重载/目录变化通知（manifest 摘要载荷，替代 src PluginEventBus 汇点）；webui/extensions-changed = UI 扩展清单变更（前端宿主 sync 面，src ui.extensions.changed 同款）。）

### 载荷增强（不新增事件）
- `llm/delta` 补 `kind`（text|reasoning|toolcall）+ partial 累计可选字段——src 9 种 StreamToken 三通道在 preview 是同一事件的三种载荷
- 各事件载荷统一携带 conversationId/correlationId（WS 桥接过滤后台会话需要 source 细分）✅ **M13 落地**：LlmChatInput.meta（agent/conversationId/sender；LlmService.dispatch 剥离——provider 请求体永不携带）+ llm/delta-* 尾参 meta 透传 + loop/step-started·after-step 信封尾参 {conversationId, sender}——ac-ws-bridge 据此零业务状态过滤后台会话（sender='event' 流式抑制、边界事件广播；tool/* 无 sender 载荷经 run 边界登记表兜底）
- LoopRunResult：finish 增 `'interrupted'` + interruptReason ✅（M9：request.signal 在 step 边界检查，类型 'user-abort'；M11 ✅：工具中断通道 'tool-interrupt' 落地——ToolResult.interrupt → loop 收束检测，interruptReason.toolInterrupt 携带工具请求原文（reload/reload-modules/system-restart 等），signal 同时透传进工具调用）；usage 双轨扩展（覆盖=当次上下文、累加=总用量、cache hit/miss、react_steps）✅ **M12 落地**：LlmUsage + cacheHit/cacheMiss（ac-openai-completions 归一化：DeepSeek 顶层 prompt_cache_hit/miss_tokens、OpenAI/GLM 嵌套 cached_tokens 推导 miss）+ LoopRunUsage（覆盖轨 prompt/total=末步、累加轨 promptAccumulated/totalAccumulated/completion/cache、steps=react_steps；src accumulateUsage 双轨语义原样——资产 #10）

---

## 3. 逐域映射总表

### 3.1 核心运行时（8 包 → 4 存 4 消解 3 新）

| src 包 | preview 落点 | 状态/形态 |
|---|---|---|
| core/agent-loop | ac-agent-loop（run/八事件/maxSteps 双模式/transform） | ✅ 已覆盖；run-started/step-started(E)/steer() 方法/finish:'interrupted' 已落（M9）；并发工具执行 mapLimit(5) ✅（M11） |
| core/llm + llm-{openai,deepseek,glm} | ac-llm + 三薄行 + ac-openai-completions | ✅ 已覆盖；**网络健壮性资产下沉纯库**（undici 池/重试退避/预检/[DONE] 校验/错误进流；DeepSeek/GLM 差异从类继承改 provider profile）；usage 双轨进契约 |
| llm-factory | （消失）| 库级调用方直接用纯库 |
| core/agent-config | ac-agents（AgentConfig 数据） | ✅ 部分覆盖；补 virtual 标志（router 遇之只记事件不跑 loop）；tools include/exclude 对象形态；tags/requires 门禁不进核心（独立拦截行） |
| core/hooks | （整体消解）| 行组合 + hooks[具名] + waterfall 注册序（ADR-4） |
| core/contracts + core/types | （整体消解）| 契约随 owning package；source-tag 工厂可提纯库 ac-source-tag |
| core/jobs | **ac-jobs** ✅（M11）| Service：start/list/get/kill/read + job/settled(E)；owner 分桶/并发上限/settle first-wins 原样；完成通知从私有 listener 数组改 ctx.emit |
| agents/agents | ac-agents ✅ + ac-credentials（✅ M10，凭据 AES-GCM）+ ac-config-merge（✅ M10 纯库，diff/merge）+ ac-agent-store（✅ M10 数据目录 owning）+ ac-agents-dir（✅ M10 目录扫描物化行） | AgentAssembly 大对象消解 |
| agents/router | ac-router ✅（纯转发）+ **ac-conversation**（✅ M9，ADR-1：串行化门 handle=runAddress/inbox 双队列/placement/MAX_AUTO_WAKES/abort）+ **ac-group**（✅ M9：成员表/GroupFeed 锚点增量/单通道 v3 内容流/`<msg>` 包装；busy=steer、idle=新 run 经 conversation）+ ac-pending-resume（宿主行，shutdown 落盘重投） | 最大重设计区 |
| boot/boot | cordis.yml/TREE ✅ + supervisor.mjs（进程层脚本，42/78/0 协议原样）+ include patches ✅ | 空根+补丁层（bundle ← 表面层 ← **market/<name> 动态行** ← 用户层 ← 机器层，五层）已由生态承担。boot 精读增量：① 凭据回注链（${VAR} 展开 → Agent 级 → 全局级）在**池解析时点**完成非运行时——迁入池解析纯库一并带走；② `agentScopes` 原型链 per-Agent 服务快照被 preview 无状态信封查询自然消解（"手动作用域管理被无状态查询取代"又一例证）；③ getCatalog 四源合并（内置目录+hooks 注册+manifest.provides+实际注册反查）归 ac-plugin-registry；④ **CONFIG_DEFAULTS 残留旧 maxHops 词汇，迁移时勿照搬**；⑤ watch 热重组合 debounce 300ms（监听 2 patch 文件 + registry.json） |
| util | （消解）| plugin-logger-console + 宿主层 env |

### 3.2 Agent 体验扩展（14 包 → 4 扩展 10 新）

| src 包 | preview 落点 | 状态/关键点 |
|---|---|---|
| agent-datetime | **ac-datetime** ✅（M14 新薄行）| before-run 追加仅日期行（YYYY-MM-DD 周X——KV cache 每日至多重建一次，资产 #12）；无会话键（子 Agent/直连）不注入；hooks['datetime'].enabled |
| agent-persona | ac-persona ✅ | M14 扩展 ✅：hooks['persona'] 形状升级 string→{enabled?,text?,file?}（file 优先 text 回退；裸名走 agentStore 文档 AGENT.md、路径走文件系统；frontmatter 剥离）；SYSTEM.md 覆盖归 system-prompt.override ✅ |
| agent-prompt | ac-system-prompt ✅ | M14 分块装配器 ✅：framework（行 Config ?? hooks）/系统环境（hooks['security'].workdir·allowedPaths + 可选 workspace 根）/术语约定（协作工具门控）/指引（request.tools 门控）/后台任务（job·bash 门控）/对话信息（信封 sender/conversationId + 群经可选 ctx.group）；hooks['system-prompt']={enabled?,framework?,guidelines?,systemEnv?,conversationPartner?,override?}（override=SYSTEM.md 覆盖语义：替换静态块、对话信息仍追加） |
| agent-session | ac-session ✅ | ✅ M10 持久化后端（writer 队列语义原样继承：按文件串行/WeakSet 引用幂等/append+fsync/barrier/失败回队首 + 幂等 message_id 固化）；checkpoint 落 tool/before-execute（fail-closed；M11 执行身份后定向化）；conversation/steered 入账补齐 steer 消息；群视图转换在 history() 回放层；已知语义差：记录粒度为对话级（src 1v1 含思考/工具全量），M15 对账 |
| agent-memory | ac-memory ✅ | M14 扩展 ✅：键=conversationId（1v1 缺省 agentId、群=组 id——与会话桶统一）；<root>/memory/ 文件后端（owning）+ append 累积口；budget/maxTokens 截断纯库 ac-memory-core ✅（尾部近期记忆保留 + 明确截断标记，代理对安全） |
| agent-skill | **ac-skill** ✅（M14）+ ac-skill-core 纯库 ✅ | 发现/解析/渲染纯库（frontmatter/白名单过滤/<available_skills> 渲染）；全局 <root>/skills/ 目录 + hooks['skill'].whitelist 白名单（src per-Agent 目录 → preview 全局共享 + per-Agent 白名单——形态差异）；SkillsService 懒扫描 + refresh |
| agent-presets | **ac-agent-presets** ✅（预设数据薄行，复用 ac-agents）| 内置 __standard__/__dsh_minimal__ 数据定义 + 物化（preset 标志：名册过滤/send_agent 拒收/管理面写口拦截）；默认池模型解析 + config/changed 热更新；无记忆语义 = hooks 软停用 memory/skill/datetime（dsh-minimal 另停 system-prompt）；allowlist 语义由行组合承担（ADR-4 缩水） |
| agent-mcp | **ac-mcp** ✅（M14）+ ac-mcp-core 纯库 ✅（形态重构落地）| 全局注册+**懒建连** ✅（对齐 ac-llm 范式：registerServer 只存定义，首 run before-run 连接发现；重名抛错）；per-Agent 暴露走 AgentConfig.tools 白名单 ✅；servers 放行 Config ✅（进程级授权）；撞名用命名空间前缀 ✅（`${server}__${name}` 回退）；协议住纯库（官方 SDK 包装：HTTP/stdio、insecure per-server dispatcher、describeError cause 链展开）；clientFactory 注入口=测试零网络 |
| agent-tools | 协作工具薄行 ✅（M14 ac-collab-tools）+ ac-router/ac-group 扩展 | send_agent=conversation.deliver(sender:'agent'，wait=true→placement next-run 等独立 run) ✅；list_agents=agents.list() ✅；send_group/list_groups（可选 ctx.group）✅；list_tools（AgentConfig.tools 过滤）✅；read_agent_info（model/hooks 仅自查——src 脱敏语义）✅；update_agent_profile→ac-agent-store ✅（落盘 + ctx.agents 覆盖注册 + persona 写 AGENT.md + admin 门）；来源标签钩子族被信封 sender+name 标注**净删除** ✅；执行身份 call.agentId 取代身份工厂烘焙 ✅。已知语义差：read_agent_info 无 per-target 印象（记忆键=conversationId 桶）——M15 对账 |
| svc/archive | **ac-archive** ✅（M12；M20 回归原设计）| 阈值检测订阅 after-run（触发依据=会话消息估算非 usage——src 大 AGENT.md 误触发教训）；整理 run=conversation.deliver 同桶投递（sender:'event' + placement:'next-run' 串行化门排队不并发；信封 meta[ARCHIVE_REVIEW_META] 标记三处不落盘：session 入账/usage 记账/conversation 上下文视图——对齐 src router.trigger 同会话键 + META_ARCHIVE_REVIEW 三消费方；对桶双侧整理 done 协议收尾；失控防线三闸：maxSteps 128 硬上限/超时 abort/步级日志观测——2026-08-26 4GB OOM 教训）；Agent 亲自 write summary/<会话>.md（服务端读文件作概要，mtime 判新）+ memory_rewrite 重写记忆；截断/去重纯库 **ac-archive-core**（尾部水位截断不拆工具对 + message_id 去重锚，与 ac-session SessionRecord 共享格式）；落盘经 owning 服务（session.records/compact——ADR-5）；超时兜底懒扫描（超时先 abort 再强制归档）+ archiveAll 机制任务口。缩水：群会话归档未做 |
| svc/backup | ac-backup-core 纯库 + 薄行 ✅（M12） | 定时直调（timer entry.task='backup-all'）；显式配置根路径（修 src process.cwd() 怪味）；zip 全量（归档也是记忆不排除）+ 轮转保留 4 份 + 7 天到期间隔 |
| svc/subagent | **ac-subagent** ✅（M11） | spawn=loop 直连（agent:undefined→零会话污染天然成立）✅；受控工具集=request.tools ✅；completed 缓存先于 ac-jobs 交付 ✅ |
| svc/timer | **ac-timer** ✅（M12）+ **ac-timer-core** 纯库 + **ac-timer-tools** 工具行 ✅（M15：timer set/list/disable） | 叠官方 cordis-timer 组合 5 模式（含农历：chinese-lunar + 阳历固定 + 调休配置覆盖）✅；触发=conversation.deliver(sender:'event' + session history 种子)✅；条目持久化归 ac-agent-store（entry 'timer'/'timer-archive'——消灭直写 config.json）✅；timer-state.json 原子写/懒心跳（有排程才跳，空闲零定时器）/停机补偿（先记账后触发，资产 #8）✅；机制任务 entry.task（archive-all/backup-all）直调 ctx.get 服务——**淘汰 __xxx_all__ 字符串协议**（规约 3）✅。缩水：.runtime 单写者判定归 M13 supervisor；per-entry maxSteps 不进信封（AgentConfig.maxSteps 统一管辖） |
| svc/workspace | **ac-workspace** ✅（M12，初始化行） | 默认 user（**AgentConfig.virtual**——router 只记事件不跑 loop）/admin=数据 register（agentStore 持久化 + ctx.agents 物化）✅；首启消息经 ac-session append API（不直写文件）✅；browser 守护脚本随包分发（files/browser_daemon.py → <root>/files/shared/scripts/，ac-web-tools scriptPath 指向）✅；<root> 即各持久化行统一数据根锚点（M11 沙箱基准一致性缺口收敛）✅ |

### 3.3 平台与宿主（6 项 → 大删除 + 5 新行 + 2 纯库；M13 传输面收官）

| src 能力 | preview 落点 | 状态/关键点 |
|---|---|---|
| WebUIServer + HttpRouteRegistry | **ac-web-server** ✅（M13）+ ac-ws-protocol 纯库 | route()/registerRpc() 注册即归属（fiber.effect 改造完成）；RPC 显式注册（弃反射全量）；Node 原生 http 零 express；requestId 幂等去重（deduped ack，#53/#91 教训）+ ws/ack·connection-* 事件；监听失败降级（EADDRINUSE 不炸进程） |
| webui 表面 + UI 扩展宿主 | **ac-webui** ✅ + **ac-webui-extensions** ✅（M13） | slot 白名单（宿主先开口六 slot/插件后填空 fail-closed）/install 15s 超时回滚/isolated 档（不信任扩展不进 slot 注册表）原样移植（与 fiber 语义同构）；entries 清单 + /ui-plugin/ 静态 + extensions-changed(E)；缩水：不做发布期 esbuild 构建（manifest.ui 要求预构建产物） |
| WSHandler 事件桥接 | **ac-ws-bridge** ✅（M13，订阅行） | ctx.on(emit 面 27 事件)→WS 帧（type=事件名直转——机器可读事件目录即协议目录）；零业务状态；后台会话过滤零状态化（delta/step 事件自带 sender 载荷逐事件判定 + tool/* 经 run 边界登记表兜底；边界事件广播） |
| SessionSnapshot 快照状态机 | （**删除**） | conversationId 分桶 + history() 回放 + delta 重订（三次串台 bug 架构性消灭） |
| L4 门面/ServiceRegistry/Runtime/ctx.l4 | （**删除**） | 消费行直接 inject 各域 Service |
| AgentService 管理面 | **ac-agent-admin** 薄行（M14+） | CRUD/差异配置/凭据剥离/热重载；GLOBAL_ONLY_KEYS 白名单语义完整搬迁 |
| GroupService | **ac-group 持久化** ✅（M15：store 并入 owning 服务——root 给定即启用） | 单通道 v3 设计**原样继承**（内容≡会话流、通知≡emit）；GroupFeed 锚点增量作 Service 方法；成员表 group.json + 本体 messages.jsonl + 轮转 archive/[history_N + summary_N]（src maybeArchiveBody 语义）+ historyFor viewer 回放（send 传 history 种子） |
| HistoryService | 算法→纯库（反向迭代/.tidx 轮次索引）+ 门面并入 ac-session | history() 回放已有 ✅；分页/删除/归档触发延后（M15 对账） |
| InteractionBridge + durable-interaction | **ac-interaction** 域 + ask_questions 工具行 | ✅ M11 已落（ac-durable-interaction） |
| ConfigService | **ac-config** ✅（M10）+ config/changed(E) | 订阅刷新替代引用 mutate；<root>/config.json 原子写（tmp+rename）；快照隔离（get/all 深拷贝） |
| PluginHost（权限/契约 gate/回滚/watch） | 生态 plugin-loader + **ac-plugin-registry** ✅ + **ac-plugin-gates** ✅（M13） | owner 手工回收**删除**（装载经 ctx.plugin，fiber 父=本行——注册即归属的机器化推论）；权限/契约 gate 在 import 之前（fail-closed）原样，拆策略行（plugin/before-load(W) seam）；同名替换失败回滚恢复旧实例；watch 轮询哈希自动重载原样；register_plugin/unregister_plugin 工具走 ToolResult.interrupt → after-run 宿主半边 |
| 插件库/市场 | **ac-plugin-registry** ✅ + ac-plugin-core 纯库 ✅（M13）；**ac-plugin-market** 行（延后 M14+） | staging 人审管（哈希/只读代理/权限快照/来源锚定）原样；三层分工：yml=出厂态、registry.json=安装态（永不写回 yml）、hooks=启用表达；market（github/tarball 源拉取）延后 |
| Supervisor + 42/78/0 | supervisor.mjs 进程层脚本 ✅ + ac-supervisor-core 纯库 ✅（M13） | 原样保留（退避熔断策略纯函数搬运）；.runtime 单写者锁（wx 排他——资产 #7，M12 ac-timer 遗留项落点）；worker 空闲自退 → supervisor code=0 一并退出（懒心跳设计的宿主侧闭环） |
| 优雅关闭 setShutdownDeps | （**删除**） | root fiber dispose 自动逆序（ac-web-server dispose 等 stop 完成——端口真正释放）；pending 语义 ✅ M15 落地（ac-conversation 待投持久化最小闭环：next-turn 落盘/回放） |
| sdk/protocol 跨端契约 | （消解）✅ M13 | 拆归 owning package events.ts；WS 帧 type=事件名直转（事件目录文档即协议）；非 TS 端靠事件目录文档（机器可读目录是文档化额外动机） |
| desktop/bin/.runtime | 可移植模式参照 | wx 排他单文件实例标识原样（ac-supervisor-core acquireRuntimeLock）；wx 排他单文件实例标识原样 |

### 3.4 工具执行面（14 包 → 20 工具 + 2 安全钩子 + 1 durable 服务）

**审查修正（src 现状与自述文档的漂移，已核实源码）**：
- `src/edit` 的 hashline DSL/行级定位/快照校验已于 2026-08-20 移除——现状是 old_string/new_string + 三级模糊匹配 + 增量 diff + 行尾保留 + **文件突变队列**。重写以现状为准。
- `src/session-tools` 实际工具是 `grep_history`/`read_history`（query_history 已拆分、inspect_session 已移除）。

**工具清单 → preview 落点**（全部为薄行形态，inject `tools` 注册；算法住纯库）：

| 工具域（src） | 工具 | preview 落点 | 关键点 |
|---|---|---|---|
| fs | read / write / edit | ac-fs-tools ✅（M11）+ ac-edit-core ✅ | 编辑引擎（模糊匹配/增量 diff/突变队列）已提纯库；突变队列跨 read/write/edit/str_replace_editor 共享 ✅（一致性缺口已修）；read 输出 token 预算截断 ✅ |
| fs-search | glob / grep | ac-fs-search ✅（M11）+ ac-glob-core ✅ | DSH dsh-tool-fs-search 语义；walk 口径统一（黑名单同口径/isDenied 参数化）✅ |
| str-replace-editor | str_replace_editor | ac-str-replace-editor ✅（M11） | DSH 语义移植原样；写经突变队列（修 src 无队列缺口）✅ |
| shell | bash / job | ac-shell-tools ✅（M11）+ ac-jobs ✅ | job 接 ctx.jobs 统一任务词汇 ✅；后台任务 owner=执行身份 ✅；bash 超时/signal/流式 onProgress ✅；Unix→PS 翻译原样 |
| math | math | ac-math ✅（M11） | vm 沙箱求值纯函数（Math 白名单 + timeout 兜底）✅ |
| web | web_search / browser | ac-web-tools ✅（M11）+ ac-web-search-core ✅（5 provider 纯库） | browser daemon 独立 Service（ctx.browser，dispose 杀进程；src 模块单例+单飞 pendingCmd 改请求队列 ✅）；key 三源解析链（行配置→ac-credentials→env）✅；守护进程脚本随 M12 workspace 分发 |
| dev | read_logs / reload / reload_modules | ac-dev-tools ✅（M11） | 日志环形缓冲（logger exporter 订阅型）✅；reload/reload_modules 走 ToolResult.interrupt ✅（reload 语义与 fiber 重载对齐——M13 hmr 落地后闭环） |
| plugins | register_plugin / unregister_plugin | 归 ac-plugin-registry 行（M13） | 管理面工具随 owning 域；中断通道已备 ✅ |
| restart | system_restart | ac-restart ✅（M11） | 42 约定宿主层（M13 supervisor）；interrupt type='system-restart' + Supervisor 模式判定 ✅ |
| interaction | ask_questions | ac-durable-interaction ✅（M11，直接平移：Service + opened/replied/closed 三事件 + 纯库 store）+ ask_questions 工具行 ✅ | write-ahead 时序 ✅；correlationId=toolCallId 对账 ✅；late-reply 唤醒走 sender:'event'（宿主接线）✅ |
| session-tools | grep_history / read_history | ac-session-query ✅（M11） | 复用 history() 回放 ✅ |

**安全域 ✅（M11 ac-security 行落地）**：`tool/before-execute`（能力门禁——ToolDefinition.requires AND vs hooks['security'].capabilities，include 不可绕过；per-Agent 沙箱——workdir/allowedPaths/denyPaths；**bash 命令扫描**——heredoc 剥离后按路径段判定，src 明示为纵深防御非完备沙箱——同落此处）+ `tool/transform-result`（输出脱敏——**已落 transform 而非 after**；凭据明文值 ctx.credentials.listValues() + sk-xxx/api_key= 通用模式，结构化深走递归 output）。沙箱路径解析器（`createSandboxResolver({workdir, allowedPaths, denyPatterns})` 参数化，**解除 src toolkit→agent-config 依赖倒挂 ✅**）与 token 估算/安全截断/代理对安全截断已提纯库（ac-sandbox-core / ac-text-budget）。

**ac-tools 契约扩展 ✅（M11 全部落地）**：
1. **ToolCall 执行身份**：loop 调 execute 时附 agentId/conversationId/toolCallId ✅——per-Agent 沙箱、ask_questions 对账、job owner 隔离、hooks 查询全部依赖它。
2. **语义化中断通道（ToolInterrupt）**：reload / reload_modules / register_plugin / unregister_plugin / system_restart 五工具的"请求→loop 收尾→宿主执行→续跑"闭环 ✅。ToolResult.interrupt + loop 收束检测（finish='interrupted' + interruptReason.toolInterrupt）✅。
3. **AbortSignal + 流式输出**：execute 签名扩展 ✅（bash 超时/取消 + signal 透传；onProgress 回调挂 call）。
4. **命名空间配置 → hooks[具名]** ✅：`hooks['web-tools']`（provider/baseURL/model/默认条数）已落地；`hooks['security']`（capabilities/workdir/allowedPaths/denyPaths/enabled）已落地；ConfigField 表单元数据（UI 动态渲染）延后至 web 表面域（M13）。
5. **能力标签门禁** ✅（base/dev/admin/conductor + requires AND，include 不可绕过）→ ac-security 拦截器查 `hooks['security'].capabilities`；AgentConfig.tools 白名单只解决"暴露哪些"。
6. **输出形态归一** ✅：工具体返回 `{ok, output: <src data 形状>}`，展示词汇由 web 表面订阅 tool/after-execute 自取。

**其余缺口**（M11 后残留）：ac-credentials 的 web_search 三源链已接 ✅（行配置→Agent 级/全局级→env）；~~browser 守护进程脚本分发待 M12 workspace~~ ✅ M12 ac-workspace files/browser_daemon.py 分发；~~文件突变队列共享纯库~~ ✅（edit + str_replace_editor 都走 withFileMutationQueue）；read 输出 token 预算截断 ✅；~~walk 遍历口径统一~~ ✅（ac-glob-core.walkFiles，isDenied 参数化注入）；~~会话级 per-Agent 沙箱与工具行级沙箱基准一致性~~ ✅ M12 workspace root 统一锚点。

**核心映射规律**（工具域）：src 的"注册期 per-Agent 烘焙"被 preview 的"**全局注册 + 执行期身份 + hooks[具名]**"取代；owner/always/replace 注册语义被 fiber 归属 + 行组合天然取代；安全检查一律独立成行不进工具体；src 已在向这套模型收敛（ToolsService 本已是 cordis Service、durable-interaction 已是 owning 形态）——重写多是"搬形态、换词汇"，真正的再造点是**执行身份、中断通道、signal/流式**三个执行面契约。

---

## 4. 原样继承资产清单（踩坑沉淀，与 preview 哲学同构）

1. LLM 网络健壮性全套（undici 池参数/瞬时失败重试退避/GET /models 预检/SSE [DONE] 完整性校验/错误进流契约/余额类 fatal 不重试）
2. 会话 writer 队列语义（按文件串行/WeakSet 引用幂等/append+fsync/quiescence barrier/失败批次回队首）
3. 单通道群消息设计 v3（本体文件唯一内容通道 + trigger 纯通知 + GroupFeed 锚点增量——四次消息重复事故的教训）
4. staging 人审管 + 权限/契约双 gate（import 前拒绝、fail-closed）
5. write-ahead 交互时序（先落盘 pending 再通知、先落盘回答再续跑）
6. Supervisor 42/78/0 退出码协议 + 指数退避熔断策略
7. `.runtime` 单文件实例标识（wx 排他创建消灭双启 TOCTOU）
8. timer 状态文件模式（临时文件+rename 原子写/30s 心跳/停机补偿/单写者保护）
9. UI 扩展 slot 白名单机制（宿主先开口插件后填空 + iframe 隔离）
10. usage 双轨累计语义（覆盖=当次上下文供归档判阈、累加=总用量展示）
11. 会话快照防串台教训 → "一切会话态按 conversationId 寻址"不变量
12. KV cache 友好的 system 装配顺序（日期行每日至多重建一次等）
13. src 反面教材（勿重蹈）：composition.ts 使用 js-yaml 但未在 package.json 声明（靠 workspace hoisting 生效的隐式依赖）——preview 纪律：运行时依赖必须显式声明

## 5. 整体净删除项（preview 有更优原语）

core/hooks · core/contracts+types · util · AgentAssembly/AgentLoader 大对象 · L4 门面全层（ServiceRegistry/Runtime/ctx.l4/四 Facade）· PluginEventBus · SessionSnapshot · setShutdownDeps 接线 · PluginHost owner 手工回收 · 来源标签钩子族（被信封 sender+name 取代）· RPC 反射注册 · llm-factory · 旧会话键路径编码（chat~lo~hi 排序魔法）

---

## 6. 里程碑路线（M9 起，依赖排序）

- **M9 ✅ L3 补全**（2026-08-22 收官）：ac-conversation（串行化门/inbox 双队列/steer placement/MAX_AUTO_WAKES）+ loop `steer()` 方法 + run-started/step-started(E) + finish:'interrupted' + ac-group（成员表/GroupFeed/单通道 v3）——群拓扑是下游（协作工具/system-prompt 对话块）的前置。已知缺口（M10 处理）：steer 注入消息不经 router 事件（session 事件流缺段）✅；群 notify 纯通知形态（全文走历史）待持久化后落地，M9 为 tail 形态（通知携带 `<msg>` 全文）
- **M10 ✅ 持久化基座**（2026-08-22 收官）：ac-session 持久化后端（writer 队列/checkpoint/幂等 id）+ ac-agent-store（Agent 数据目录，消灭越权写）+ ac-config + config/changed(E) + ac-credentials + ac-agents-dir（目录扫描物化）+ ac-config-merge 纯库 + conversation/steered(E)（steer 入账通道）+ 类插件 (ctx, config) 构造约定（各持久化行 root 经 yml config 传入）。已知缺口：会话记录对话级粒度（src 1v1 全量，M15 对账）；~~checkpoint 为 flushAll 粗粒度（M11 执行身份后定向化）~~ ✅ M11 定向化完成；agents-dir 热重扫待 M14 管理面
- **M11 ✅ 工具面**（2026-08-22 收官）：ac-tools 契约扩展（执行身份 agentId/conversationId/toolCallId + AbortSignal 透传 + onProgress 流式回调 + ToolResult.interrupt 语义化中断通道 + ToolDefinition.requires 能力门禁）+ loop 工具并发 mapLimit(5)/tool-interrupt 收束（interruptReason.toolInterrupt 携带工具请求原文）+ ac-session checkpoint 按 conversationId 定向 flush（无身份退回 flushAll）+ ac-jobs（job/settled）+ 纯库五件先行（ac-edit-core 三级模糊匹配/增量 diff/行尾保留/突变队列；ac-sandbox-core createSandboxResolver 参数化 + bash 命令扫描 + 脱敏——修正 src 两处 bug：赋值模式尾引号吞吃致 JSON 回环静默失效[改结构化深走]、Windows 反斜杠 deny 模式不可匹配；ac-text-budget；ac-glob-core；ac-web-search-core 5 provider）+ 工具九行（fs-tools read token 预算截断 / fs-search / str-replace-editor 补突变队列 / shell-tools bash 前台超时·流式·signal + 后台 job + Unix→PS 翻译 / math vm 沙箱 / web-tools web_search + ctx.browser 守护进程 Service[请求队列 + dispose 杀进程 + 世代计数] / dev-tools read_logs 环形缓冲 + reload·reload_modules 中断 / restart / session-query）+ ac-security 行（before-execute 门禁 AND + per-Agent 沙箱 + bash 扫描；transform-result 脱敏；hooks['security'].enabled 软停用）+ ac-subagent（spawn=loop 直连 agent:undefined 零会话污染；受控工具集=request.tools；completed 缓存先于 ac-jobs 交付）+ ac-durable-interaction 直接平移（write-ahead/幂等/JSONL torn-tail 恢复 + opened/replied/closed 三事件 + ask_questions 工具 correlationId=toolCallId；late-reply 走 sender:'event'）。输出形态归一：工具体返回 {ok, output:<src data 形状>}。已知缺口：browser 守护进程脚本（src browser_daemon.py）随 M12 workspace 初始化分发；插件管理工具（register_plugin/unregister_plugin）归 M13 ac-plugin-registry；会话级 per-Agent 沙箱与工具行级沙箱基准一致性依赖行配置约定（M12 workspace 根统一）
- **M12 ✅ 服务编排**（2026-08-22 收官）：usage 双轨进契约（LlmUsage + cacheHit/cacheMiss provider 归一化；LoopRunUsage 覆盖轨 prompt/total=末步当次上下文 + 累加轨 promptAccumulated/completion/cache + steps——src accumulateUsage 语义原样[资产 #10]）+ ac-archive（阈值检测订阅 loop/after-run[触发依据=会话消息估算非 usage]；整理 run=sender:'event' 信封 loop 直连不经 router[整理提示词零会话污染]；单方整理单 pending；ac-archive-core 纯库[尾部水位截断不拆工具对/message_id 去重锚/阈值]与 ac-session SessionRecord 共享格式；落盘经 owning 服务 session.records/compact[新增 API]；超时兜底懒扫描 + archiveAll 机制任务口）+ ac-timer（5 模式 time/delay/random/workday/holiday + 农历[chinese-lunar+阳历+调休配置]；叠官方 cordis-timer 的 ctx.timeout 排程；timer-state.json 原子写+懒心跳[有排程才跳，空闲零定时器进程自退]+停机补偿三 case[一次性/首次/周期上限 3]；条目持久化归 ac-agent-store entry 'timer'，完成归档 'timer-archive'；触发=conversation.deliver(sender:'event'+session history 种子)；机制任务 entry.task='archive-all'/'backup-all' 直调——淘汰 __xxx_all__ 字符串协议[规约 3]）+ ac-usage（after-run 双轨记账 + byAgent/byModel/totals 内存聚合 + <root>/usage/usage-<date>.jsonl 审计流水）+ ac-workspace（初始化行：AgentConfig.virtual[user 只记事件不跑 loop]+admin 数据 register；首启消息经 session.append；browser_daemon.py 随包分发[M11 缺口]；<root> 统一数据根锚点[M11 沙箱基准缺口]）+ ac-backup-core/ac-backup（zip 全量+轮转 4 份+7 天间隔；路径全显式修 process.cwd() 怪味）。**服务级依赖新形态**：构造期/服务闭包内访问 ctx 依赖的服务声明 `static inject`（fiber store 驱动）；跨服务方法调用经 `ctx.get()`（root-traced 不受限——受限 fiber 链解析不到目标服务的传递依赖）。已知缩水：ac-archive 整理 run 只做会话总结（记忆整理归 M14 ac-memory 扩展）；群会话归档未编排（M15 对账）；ac-timer .runtime 单写者归 M13 supervisor；usage 持久聚合回读归 M15
- **M13 ✅ 宿主与可视化**（2026-08-22 收官）：载荷增强（LlmChatInput.meta + llm/delta-* meta 尾参 + loop/step-started·after-step 信封尾参——dispatch 剥离 meta 不进 provider body）+ ac-web-server（HTTP 路由注册中心[:param/尾*/注册即归属/重注册抛错] + WS[广播/定向/30s 心跳/2 拍判死] + rpc/call 显式分发表 + requestId 幂等去重[30s 窗口 deduped ack——src #53/#91 重连 flush 重复持久化教训原样] + ws/ack·connection-opened·connection-closed(E) + 静态/SPA + 监听失败降级；Node 原生 http 零 express）+ ac-ws-bridge（零业务状态订阅行：27 emit 事件直转帧[{args} 载荷]；后台过滤零状态化——delta/step 自带 sender 判定 + tool/* run 边界登记表兜底 + 边界事件广播）+ ac-webui + ac-webui-extensions（entries 清单 + /ui-plugin/ 静态 + webui/extensions-changed(E)；slot 白名单[宿主先开口六 slot/插件后填空 fail-closed] + install 15s 超时回滚 + isolated 档——src P5 机制与 fiber 语义同构原样移植）+ ac-plugin-core（manifest 校验/权限授予/契约版本兼容/staging 人审文件域——资产 #4 原样）+ ac-plugin-registry（stage/approve/reject/uninstall + 装载管道[plugin/before-load(W) → 动态 import cache-busting → ctx.plugin——fiber 父=本行全回收；同名替换失败回滚恢复旧实例；watch 轮询哈希自动重载] + plugin/installed·reloaded·catalog-changed(E) + register_plugin/unregister_plugin 工具[ToolResult.interrupt 上报 → after-run 宿主半边执行]）+ ac-plugin-gates（权限+契约双 gate 拆策略行——import 之前 fail-closed 代码不进进程）+ ac-supervisor-core + supervisor.mjs（42/78/0 协议 + 指数退避熔断[资产 #6 原样] + .runtime 单写者锁[wx 排他——资产 #7，M12 ac-timer 遗留项落点]）。**已知缩水**：manifest.ui 不做发布期 esbuild 构建（要求预构建产物）；ac-plugin-market（github/tarball 源）延后 M14+；ac-agent-admin/ac-group-store/ac-pending-resume 归 M14+；reload 语义闭环（dev-tools reload 中断 → 宿主执行 → fiber 回滚重载）待 hmr 行启用场景联调
- **M14 ✅ 扩展补全**（2026-08-22 收官）：ac-datetime（before-run 仅日期行 `[当前时间] YYYY-MM-DD 周X`——KV cache 每日至多重建一次[资产 #12]；无会话键不注入；hooks['datetime'].enabled）+ ac-skill + ac-skill-core 纯库（全局 <root>/skills/ 目录：frontmatter 解析/发现/渲染住纯库；ctx.skills 懒扫描+refresh；before-run 追加 <available_skills>；hooks['skill'].whitelist 白名单——src per-Agent 目录改全局共享+per-Agent 白名单）+ ac-mcp + ac-mcp-core 纯库（形态重构落地：全局注册+懒建连[对齐 ac-llm 范式，首 run before-run 连接发现；重名抛错]；工具注册进 ctx.tools 撞名 `${server}__${name}` 前缀；servers 放行=行 Config 进程级授权；per-Agent 暴露走 AgentConfig.tools；协议住纯库[官方 SDK 包装：HTTP/stdio 双传输、insecure per-server dispatcher、describeError cause 链展开]；clientFactory 注入口=测试零网络零子进程；单服务器失败 warn 不炸行）+ ac-system-prompt 分块装配器（framework[行 Config ?? hooks]/系统环境[hooks['security'].workdir·allowedPaths+可选 workspace 根]/术语约定[协作工具门控]/指引[request.tools 门控：文件工作流/产出物引用/协作流/ask_questions/subagent]/后台任务[job·bash 门控]/对话信息[信封 sender+conversationId；群经可选 ctx.group 解析成员表；无信封不注入]；override=SYSTEM.md 覆盖语义[替换静态块、对话信息仍追加]；hooks['system-prompt'] 六键管控；agents 为可选能力 ctx.get——零硬依赖组合可用）+ ac-persona 文件装载（hooks['persona'] string→{enabled?,text?,file?}；file 优先 text 回退；裸名走 agentStore 文档、路径走文件系统；frontmatter 剥离）+ ac-agent-store 文档 API（saveDoc/readDoc/removeDoc——Agent 目录 Markdown 唯一写口，.md 文档名校验）+ ac-memory 扩展（键=conversationId[1v1 缺省 agentId、群=组 id——规约 2]；<root>/memory/<key>.md 文件后端[ADR-5 owning]+append 累积口；ac-memory-core 纯库[token 预算截断：尾部近期记忆保留+明确截断标记，复用 ac-text-budget 估算]）+ ac-collab-tools 协作七件（send_agent=conversation.deliver[sender:'agent'；wait=true→placement next-run 等独立 run 拿回复]、send_group/list_groups[可选 ctx.group]、list_agents、read_agent_info[model/hooks 仅自查]、list_tools[AgentConfig.tools 过滤]、update_agent_profile[agentStore 落盘+ctx.agents 覆盖注册+persona 写 AGENT.md+hooks['persona'].file 挂载+admin 门]；执行身份 call.agentId 取代 src 身份工厂烘焙——来源标签钩子族净删除）。**已知缩水（M15 对账决定补做与否）**：ac-plugin-market（github/tarball 源）/ac-agent-admin/ac-group-store/ac-pending-resume 未做；read_agent_info 无 per-target 印象（记忆键=conversationId 桶）；update_agent_profile 字段面=preview AgentConfig（无 tags/avatar/presets）；AgentConfig.tools 保持 string[] 白名单（include/exclude 对象形态未进核心契约）；归档整理 run 写记忆未联动（ac-memory API 已备）
- **M7（规划，下一里程碑）可视化/WebUI**：开工简报 `docs/m7-webui-plan.md`。范围：① WS RPC 业务方法注册（M15 对账阻断级缺口——传输设施全备、registerRpc 零注册；方法表 chat.send/interrupt/interact.respond/agent.list/config/group.*/history.request/usage.tokens 按消费域薄注册行）② 事件面补齐（tool/progress 流式增量、归档完成通知、agents/updated 档案变更——src agent.profile.updated 系写侧僵尸勿照搬、interaction wire 整形；逐消息汇总建议前端聚合）③ ac-agent-admin 首期（CRUD 经 agentStore+reassign、agents-dir 热重扫、凭据剥离 credentials、diff 保存接 ac-config-merge——纯库 M10 备好零消费）④ 前端本体（决策点：移植 src/ui/webui Vue3 全家桶[换传输层 core/api+events]vs 新写最小聊天面；预构建 dist 进 ac-webui 静态，dev 期 vite proxy → 3830）。src 参考：host/server/src/ws/protocol.ts（~56 型）、api/*.ts（21 文件）、agent-service.ts；ui/webui/src/core/**（事件契约/HTTP client/工具视图注册表）。
- **M15 ✅ 对账收官**（2026-08-22）：六轴逐项对照（工具/事件/配置/会话粒度/usage 回读/群归档持久化）+ M14 缩水件评估，产出 `docs/m15-reconciliation.md`（决策依据：补什么/缩什么/为什么 + 切换策略结论）。**补齐 13 项**：ac-usage 持久聚合回读（boot 回读 jsonl 重建 byAgent/byModel/byDay + conversationId 入账流水）、ac-timer-tools（timer 工具 set/list/disable——服务链路 M12 已备，补 LLM 入口）、ac-job-wakeup（job/settled → conversation.deliver(sender:'event') 唤醒 owner——src onJobDone 双通道之②的 preview 形态）、**ac-group 持久化**（root 给定即启用：group.json 成员表 + messages.jsonl 本体 + archive/ 轮转[500k 阈值/30k 保留/机械摘要 summary_N.md——src maybeArchiveBody 原样] + historyFor viewer 视角回放[peer 包装/own 原文/相邻合并/30k 截断/摘要头] + send 传 history 种子[重启后首跑恢复群上下文；内存视图存在则零开销]——地图 §3.3 ac-group-store 预留位并入本服务，owning 形态无独立行）、ac-conversation 待投持久化（next-turn 入队即落盘 pending-<handle>.jsonl、消费重写、boot 回放——src pending-resume 最小闭环；进行中 run 归 ac-session 账）、AgentConfig.tools include/exclude 对象形态（resolveToolNames 统一解析：router 信封/list_tools 生效集/ac-archive 整理 run 共用；loop 契约不变）、AgentConfig.llmParams（采样白名单 temperature/max_tokens/top_p/response_format/stop/reasoning_effort/thinking/logprobs/top_logprobs/tool_choice——filterLlmParams 过滤防保留键覆盖 → LoopRunRequest.llmParams → 每步透传）、memory_append 工具（ac-memory 经 ctx.inject(['tools']) 可选注册；append 累积写不重写）+ ac-archive 整理 run 提示词联动（生效集含该工具才给指令）、AgentsService.reassign（数据驱动覆盖注册不挂 fiber——修 update_agent_profile 覆盖注册归属 collab 行的勘误）、ac-restart 宿主半边（after-run 消费 system-restart interrupt → root dispose 优雅关闭 → exit(42)——修中断链断链勘误）、插件工具门禁 dev→admin（动态 import 代码进进程 = admin 边界）、send_agent virtual 目标拒绝、web_search schema 收敛回 src 正典 + reload_modules files/reason 兼容。**显式缩水**（m15-reconciliation.md §三）：会话粒度对话级（工具对入账需配套回放协议与预算，孤立 tool 行会被 LLM API 拒绝；safeSplitIdx 标注前向防御）、per-target 印象（成对键与规约 2 冲突）、群记忆单桶（单通道 v3 决策）、read_agent_info 无 name/tags（无 UI 消费面）、boot 五层组合栈（yml 唯一出厂态）、全局 config.json 无消费行（config/changed 基础设施已备）、LLM 池/$VAR（env 兜底覆盖主场景）、ac-plugin-market（staging 信任边界已平移）、ac-agent-admin（会话内修改面已覆盖；HTTP 管理面归 M7）、WS RPC 业务方法零注册（消费者归 M7）、工具流式增量事件（onProgress 回调已备；事件化归 M7）、reload 宿主半边（hmr 联调挂账）。验证：typecheck + 495/495 + smoke + boot + supervised 全绿。

- **M7 ✅ WebUI/可视化**（2026-08-22，A+B+C+D 全量；开工简报 `docs/m7-webui-plan.md`）：**A 传输接线**——ac-web-api 薄编排行（WS RPC 业务方法显式注册、preview 风格 `domain/action` 命名与事件名两命名空间并存：conversation/deliver·interrupt·stats[ack busy/parked/deduped 映射]、interaction/list·reply、session/history·delete-message[ac-session 增 deleteMessage 原子重写]·archive[可选能力 ctx.get 非 strict]、agents/list·tool-defs[生效集+defs]、group/list·create·delete·join·leave·rename·send·history[ac-group 增 records() 原始记录口]、usage/tokens）；**B 事件面**——tool/progress（ToolsService.execute 中央接线 onProgress→emit + 桥接 run 登记表过滤——src chat.tool_execution.update 对应物）、archive/completed（archiveAndRebuild 唯一漏斗收尾 emit）、agents/updated（reassign/remove 写口 emit——src agent.profile.updated 写侧缺失补真实现）、durable-interaction/opened bridge 端 wire 整形（ask_questions questions 上提）、逐消息汇总取前端聚合（delta 前端合成 message，零服务端改动）；**C 前端本体**——src/ui/webui 全量移植 preview/webui：组件层零改动，**适配器合成架构**（services/websocket.ts 类面原样内部讲 preview 线协议：出站 src 词汇→rpc/call、入站事件帧→合成 src chat.* 契约[dialogId 映射保 feed 过滤语义：群=group~gid~aid/委托=chat~agent~x/直答=chat~user~aid]）+ endpoints 层 RPC 化（preview 无面处优雅降级）+ compat/protocol.ts 跨端契约内联（不跨轨依赖 src/sdk/protocol）；vite dist 由 web-server staticDir 托管 + SPA fallback，dev vite 3831 proxy→3830；适配层合成表（webui/tests/adapter.test.ts）与服务面 e2e（ac-app/tests/webui-e2e.test.ts：TREE+scripted provider+真 WS 投递→全链路帧→历史→幂等）双测试锁定；**D 管理面**——ac-agent-admin 首期（ctx.agentAdmin：sanitize[AgentConfig 字段白名单 fail-closed + apiKey 剥离进 credentials] + deepMerge 局部补丁 + agentStore 唯一写口 + reassign 热生效 + computeDiff 变更报告[ac-config-merge 首个消费者] + saveDoc 空=删 + system-prompt dry-run[before-run waterfall 干跑]；写侧 RPC 随本行注册即归属）。**显式降级**：file.upload HTTP 面、singles/workspaces/版本/插件市场后端面、chat.subscribe resume 快照、chat.continue 自主续写。验证：preview:typecheck + webui vue-tsc + 533/533 + smoke + boot（3830 静态托管 + wscat 手测）。

- **M19 ✅ user 去特殊化——全对键桶模型**（2026-08-26 收官；规划与五裁决 `docs/m19-pair-bucket-plan.md`）：一切双端会话统一对桶 `conversationId = pairKey(a, b)`（[a,b].sort().join('~')，ac-agent-loop owning 导出；自会话 = a~a），user 只是端点之一——桶/路由/统计零专属路径，新增虚拟 Agent（如 user2）零代码自动成桶/成流/进矩阵（验收测试锁定）。**信封身份/拓扑分离**（D1）：`sender` = string 端点 id + 新增 `source: 'user'|'agent'|'event'` 拓扑词（ws-bridge 后台过滤/MAX_AUTO_WAKES/session 事件行三消费方改读 source；router/*·steered·loop envelope·llm meta 全线加位）；Agent id 禁 `~` 升级承重墙（register/reassign 抛错 + admin sanitize + agents-dir 容错跳过 + 群 id 黑名单——runAddress 从右解析无歧义）。**机制触发归自会话**（D2）：timer 全局/个人条目与 job-wakeup 统一落 `pairKey(target, target)`（矩阵对角线）；ac-archive 阈值门从 conv===agentId 切对桶端点判定、archiveAll 按 owningAgentOf 解析。**边界算键**（D3）：web-api conversation/deliver 显式 `pairKey(VIEWER_AGENT_ID, agentId)`（服务层不猜 viewer；前端直答透传）；session/tokens 改 byConversation 键。**前端分区统一 pair:**（D4）：废 direct:——routeDialog 对桶统一路由（含 viewer 可写/不含只读且流式直播入桶）、feed agentKeyOf·streamAgent·未读/名册 viewer 对桶映射、toRunsSnapshot/convKeyToId 对键统一、message-received 统一路由（agent→viewer 私信与委托入站实时入桶）。**入账统一**（#6）：入站 role:user + name=说话人、回复 role:assistant + name=回复 Agent（与群桶同构）；虚拟端点 + source='agent' = agent→viewer 私信按说话人 assistant。**统计**（#7/#8）：usage byPair 对键解析（user 端点不排除，弦图过滤 = 视图选择；旧桶双读兜底）；system-prompt 对话对象行 = sender id + 注册表显示名。**数据重迁移**（D5）：preview 存量清空（备份 data.bak-m19/），migrate-workspace.ts 产对键桶（chat~a~b 全量：user 对/agent 对/自会话；说话人 name + tool_calls/tool 行重建 steps[]；usage 流水 conversationId = pairKey）。验证：双轨 typecheck + 664 测试 + smoke + boot 真数据（15 Agent/91 对桶/9127 用量行）+ WS 探针全链路。 

- **M23 ✅ Agent 自开发插件能力（免审安装闭环）**（2026-08-29 收官，P7 热通道后置；设计/裁决 `docs/m23-agent-plugin-plan.md`，v1-v6 六轮裁决 A-H 系全收敛）：**五步闭环**（开发 files/&lt;agentId&gt;/ → register_plugin 临时试跑[会话级] → install_plugin 免审安装[stage→自动 approve→立即装载，安装态=registry.json] → 回执落账 + sender:'event' 回触 owner 自会话[闭环无人值守自驱动，金闭环 e2e 锁定] → uninstall 回滚[代码回滚语义]）。**P1 免审安装口**：installFromDir 三态结果（installed+loaded/installed+failed/rejected——装载失败不影响安装且立即计入熔断）+ 同 hash 幂等（不重试装载，改动必 bump version）+ 保留字护栏（tools/llmProviders/agents 三面内置名常量表[ac-plugin-core/src/reserved.ts] + boot 全树一致性测试锁定——防动态插件抢注内置名让出厂行 fiber FAILED）+ approveStaging 可补偿分步 + registry 原子写 + 全 mutation 串行队列 + Windows rename retry + copy/hash 排除集统一 + .backup 随机后缀 + register_plugin grants 去除（免审快照 = manifest 全集）与 install_plugin 分工互引。**P2 owner-tag 归属**：capabilities = 显式 ∪ {base, agent:&lt;调用方id&gt;}（E1 并集——显式排除 base 无效，收窄走 tools include/exclude；L2 无身份不合成 owner 段）+ tags/capabilities 双轨对账 warn once（L1，事实源收敛归 M24）+ 共享 = 双写两处（E2）+ manifest provides 对象形状 {tools,llmProviders,events,ui,agents}（E3/G4——前端 provides.hooks 错位修复）。**P5 无人值守补偿控制**：plugins/audit.jsonl 审计流水（install/uninstall/reject/load 四类）+ .load-health.json 熔断（失败计数 ≥3 进 disabled；install/uninstall 强制清记录防死锁；skipped[] 透出第四态徽章）+ boot hash 复验（篡改已装目录拒载——F3）+ gates 就绪屏障（首扫延迟到 gates 行挂监听后，防空 waterfall——G5）+ 安全模式（AGENTCHAT_SAFE_MODE/.safe-mode 跳过动态插件，UI 横幅——L8）。**P3-lite 行偏好层**：cordis.patch.yml（官方 PatchOptions 子集 {id,disabled}；boot.ts 内联官方 bin.js 16 行注入 patches，fail-soft 读取）+ listPatches/setPatch 三态返回（hot 恒不返回后置 P7；no-include-row = 程序化组合无消费者）+ F10 写回守卫测试（patch 生效 + 任意树操作[refresh/loader.create/行 fiber dispose]后 cordis.yml 字节不变，含 insert 型 patch 场景——锁死"出厂态永不运行时写入"）+ denyPaths 控制面黑名单（cordis.patch.yml/registry.json/audit.jsonl/.load-health.json/.safe-mode 五项按 workspace.root 绝对路径注入；裸文件名在 isDeniedPath 三模式永不匹配；workspace 不可用 fail-closed 拒装配路径解析器 + 显式告警——G3）。**P4 可视化**：events/listeners RPC（ctx.events._hooks 有序读出 + prepend/global 标记 + 裸 fiber 名归属——零 vendor 改动，RPC 形状测试兜底）+ 装配页按插件分组/仅显示有参数过滤。**P6 模板规约**：preview/templates/ 三骨架（tool-row[agentTool owner-tag helper + &lt;tool-output&gt; 共享输出框定——H3]/provider-row[纯库复用+命名规约]/event-row[agentFilter + 私有编排铁律]）+ agentchat-plugin-dev 技能更新 + 开发分工补记（files/&lt;agentId&gt;/ = Agent 自开发沙箱；plugins/&lt;agentId&gt;/ = 用户手工开发扫描面——B1）。**显式缩水**（P7 后置不阻塞闭环）：热通道（fiber.update 事务化行树）/fiber→行聚合映射/反依赖图/yml 行熔断（internal/status 订阅）——首期 yml 行停用恒"重启生效"；UI 非隔离徽章细则与配置弹窗归 M24。src 无对应物（src 轨道插件面 = 人审 staging 单通道，无免审闭环与补偿控制——本里程碑是 preview 原生能力）。

## 7. 规约落地清单（同步进技能）

- 顺序无关收敛模式 → 插件技能"扩展插件编写规约"节
- 持久化 owning service 五条 → 框架技能
- conversationId 寻址不变量 → 框架技能
- "机制任务不过 LLM + sender:'event' 触发" → 框架技能
- hooks[具名].enabled 软停用约定 + ADR-4 缩水记录 → 框架技能
