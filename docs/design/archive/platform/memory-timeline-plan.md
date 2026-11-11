# 记忆时间线与群聊转录流重构（memory timeline plan）

> 【已实施 2026-09-27，cr-4】落地形态与计划的两处偏差：
> ① 注入 seam = `conversation/before-start`（新 emit 事件，startRun 顶部、
> history 装配之前）——比计划 §3.3 预估的「deliver 后投递 seam」更精确的
> 落点：注入行直落流后本 run 的 history 派生即含（无延迟一轮），且位于
> 文件尾部（KV 前缀稳定）；
> ② delta 基线锚以文本行「记忆基线 seq=N」内嵌在快照/delta context 行
> 尾部（自描述，无旁路状态）。
>
> 2026-12-00 立项（epoch 批次标记，非日历月——沿当前计划纪元前沿；规约见
> epoch-marking-convention.md）。
>
> 两项耦合重构：① 长期记忆从「会话桶单 md 注入」重做为「Agent 人格维度
> 单时间线 + checkpoint/delta 注入协议」；② 群聊从「每 run 派生视图」改为
> 「成员私有转录流」。②由①驱动——记忆 delta 行在结构上无法进入派生视图
> （historyFor 只取 post 行），派生视图路线对两项问题（回放缺失、KV 不稳定）
> 均无解，故一并施工。

## 一、动机与根因

### 1.1 记忆：桶寻址 vs 人格寻址

现状 ac-memory 按会话桶寻址（键 = conversationId：1v1 对键 / 群 id / singles
重定向对用户对键），记忆文件 = files/<agentId>/memory/<会话键>.md。结构性缺陷：
**记忆的归属主体是 Agent 人格，不是会话**——群聊里记下的约定落 <gid>.md，
私聊读 agent~user.md，天然互不可见。singles 重定向、群 memoryOwner 锚点共享，
都是给错误寻址打的补丁（anchor/key/属主/重定向四套概念）。

形态参考：Claude memory tool（文件 + 工具，验证了介质选择）+ Letta（core 恒注入
+ archival 检索两层，验证了读路径分层）。Mem0/Zep 类抽取管道基建在个人 Agent
规模（单 Agent 时间线几百 KB/年）是负资产，不采纳。

**语义决策（跨会话记忆可见）**：时间线归人格 ⇒ delta 注入的 origin ≠ 本会话
是去重过滤而非隐私过滤，快照更不分 origin——Agent 在 alice~bob 会话记住的事，
会出现在 alice~nana 的 run 上下文里。这与「记忆归人格」自洽（人格连续性 = 像人
一样记得所有朋友的事），是**有意的产品语义**而非疏漏；用户 1v1 隐私预期如有
落差，演进位 = peers 轴的注入侧过滤（二期，settings 可配），存储与协议无需
变动。

### 1.2 群聊：派生视图的结构性缺陷

现状成员上下文 = 每 run 从本体（sessions/groups/<gid>）per-member 派生
（historyFor：视角包装 + 相邻 peer 合并 + D6 派生窗）。三个结构性问题：

1. **无转录**：成员 run 的推理/工具调用/终稿不入本体（D11/M26 裁决：post 是
   唯一入账口）——群聊 run 物理上不存在任何回放材料；
2. **KV 不稳定**：相邻 peer 合并就地变异末块字节（peer 连发即从该块失效）；
   D6 派生窗超阈值整体重派生（invalidate-from-head）；
3. **与记忆协议不兼容**：delta 行是 context 行，historyFor 只取 role:agent 的
   post 行——context 行根本进不了派生视图。

## 二、裁决链（推翻与留痕）

| 被推翻/退役的裁决 | 出处 | 推翻动机 |
|---|---|---|
| 记忆面收敛为 fs 工具（memory_append/memory_rewrite 移除） | ac-memory 头注 2026-09-00 | 桶寻址错误（§1.1）；新形态需要结构化条目与 origin 元数据，fs 裸写无法铸造 |
| 群记忆属主（memoryOwner 单写多读） | 2026-10-00 群记忆收敛 | 记忆归人格后「群共享记忆」概念消失；全链退役（§6.2） |
| D11 S1/S3：per-Agent 视角桶不采纳（写放大 + 第二事实源） | ac-group 头注 M21/D11 | 当时拒绝的是全量视图重派生；现为尾部追加转录流。本体仍是发言唯一事实源，成员流是不同内容域（runs + 已消费视图），非镜像。回放缺失与记忆协议不兼容是结构性的（§1.2） |
| M21/D9 记忆条目：文件变化 → 一次全量前缀 reset（显式接受） | ac-memory 尾注 §4.4 | 新协议永不触碰 system 易变内容；记忆行全部走流内尾部追加（§3.4） |

## 三、记忆时间线架构

### 3.1 存储

单文件：files/<agentId>/memory/timeline.md（workspace.agentWorkdir 锚定，
未装 workspace 行回落 <dataRoot>/files/<agentId>/ 同约定）。

```md
<!-- 2026-12-08T14:32 | origin:g:前端群 | peers:alice,bob -->
[2026-12-08] [约定] 与 alice 约定：每周五同步代码评审
<!-- 2026-12-09T09:15 | origin:alice~nana | peers:alice -->
[2026-12-09] alice 的部署窗口是周三上午
```

- 条目 = 头注释（宿主铸造：时间戳 / origin=写入时会话标识 / peers）+ 正文；
- **date 参数**（可选）：事实发生日 YYYY-MM-DD——历史回填/迁移整理时由 Agent
  提供（at = 该日 + 当前时刻，保证同日内排序）；缺省=今天；
- **标签通道 = 正文前缀段**（`[tag|tag] 正文`——tags 参数已移除，标签由 Agent
  写进 content；parse 侧从前缀提取为轴，头注释 tags 字段仅为存量兼容）：消
  除「参数 tags + 正文重复标注」的双通道混乱——admin 实测曾出现三层重复；
- 正文行首日期段由工具铸（Agent 手滑自带时去重）；无头裸写行带 `[date]` 前缀
  即条目边界（parseTimeline 自提取 at/tags 轴自愈）；渲染层统一 log 前缀形态；
- seq = 条目在文件中的序号（1-based，位置派生）——零计数器状态；
- 容错：fs 裸写破坏头 → 该条降级为纯文本行（grep/渲染不崩，丢失元数据轴）；
- 年度体量估算（几十条/日 × 50-100B）≈ 数百 KB，恒在整读轨道；膨胀治理
  归整理 run（§3.7），一期显式接受。

### 3.2 工具与能力面

**memory_write**（append-only，不提供 rewrite）：

- 参数：content（必填）、peers/tags（可选）；时间戳/origin/seq 由宿主铸造，
  Agent 不接触任何文件名（pairKey 词法类 bug 整族消灭）；
- 过时信息不删改：写新条目自然覆盖（时间戳语义），整理归 §3.7；
- requiredTags: ['memory']（新能力标签——记忆与 fs 正交：可有记忆无 fs、
  有 fs 无记忆；工具契约字段住 ac-tools/src/contract.ts，非新机制）；
  needPermission: false（写口有界，落在自身专用空间）；
- BUILTIN_TOOL_NAMES 增补 memory_write / memory_grep（reserved.ts 同步 +
  2026-09-00「已移除」注释改写为本裁决）。

**memory_grep**（检索面，实时盘上状态）：

- pattern（JS 正则，复用 ac-glob-core/ac-fs-search 的必需字面量预筛技术）+
  过滤轴 since/until（时间）、peer、tag；
- 输出条目级分组（时间戳 + origin 上下文 + 正文），条目 = 最小回忆单元。

**伪造边界（诚实口径）**：timeline.md 仍是 fs 工具可达位置（沿旧裁决的可达性），
Agent 技术上可经 fs 裸写铸造带任意 origin/时间戳的头——协议正确性不依赖头的
真实性（seq 位置派生、H<S 自愈、元数据轴仅影响过滤），危害上限 = 自欺（伪造
自己记忆的溯源）。不为此收紧 fs 写域（memory/ 与其他工作文件同域，特判增加
攻击面无收益）；后续若需强约束再评估写域排除。

**tag 授予路径**：框架曾有的读边界自动补齐（normalizeUniversalTags）已经
2026-09-16 用户裁决**整体移除**（`ac-agents/src/service.ts:119-127` 存档：
「tags 完全以用户/预设配置为准，明确知情优于隐式改写」）——**不重启自动补齐**。
授予走三处显式配置：内置预设（ac-agent-presets-builtin）tags 增补 `memory`；
创建面（WebUI）默认勾选；存量 Agent 用户手工补（用户基数小）。**不降级绕过**
（降级 = 隐式授予，违背上述裁决）。

### 3.3 注入协议（checkpoint + delta）

记忆行是会话流里的 context 行（recordContext，source: memory-snapshot /
memory-delta，agentId = 读者 Agent → 既有 viewer 过滤即 per-agent 可见性，
1v1 共享对桶与群成员流通吃，零契约改动）。

**检测（自描述，无旁路状态）**：run 启动时从会话流尾部向后扫最近一条记忆行，
设其覆盖 seq = S，盘上当前条目数 = H：

| 检测结果 | 判定 | 动作 |
|---|---|---|
| 无记忆行（扫到流头） | 新会话 / 压缩裁掉锚 | 注入**快照**：统计行（N 条 · 时间跨度 · tags）+ 预算内最近 M 条整数条目（settings['memory'].maxTokens，缺省 2000；复用 ac-memory-core 预算纪律），溢出注记「另有 X 条更早记忆，memory_grep 可查」 |
| H > S | 有新写入 | 注入 **delta = (S, H] 且 origin ≠ 本会话**（本会话写入已在 tool-call 历史有副本，不重复注入）；过滤后为空 → 不注入 |
| H = S | **正常稳态**（上次注入后无新写入） | delta 空 → 不注入 |
| H < S | 文件被人工缩短/改写 | 全量重定基线（同无记忆行路径），下一 run 自愈 |

扫描有界（压缩保留尾部），压缩安全 by construction——检测不依赖压缩边界与
任何通知；尾部残留旧 delta 行无妨（锚 = 最近一条记忆行，历史行不参与判定）。
锚失即全量，代价是一次冗余注入，正确性零依赖。

**注入时点（实现验证点）**：必须在 history 装配前直落流（本 run 可见）。验证
before-run 阶段 activeRuns 登记时序：若 run 已登记则 recordContext 走 journal
路径（settlement 后置——本 run 看不见，延迟一轮）；此时改挂投递 seam
（deliver 之后、run 创建之前）。施工时以集成测试锁定。

### 3.4 KV 证明

- 记忆行全部尾部追加（缓存前缀之后）：run N 请求 = system + history + Δ + user，
  Δ 与 user 同为新增 token，**零失效**；下一 run 前缀自然包含已落账的 Δ 行；
- system 侧只剩**恒定静态指引**（数行：时间线概念 / memory_write 时机 /
  memory_grep 用法）——记忆内容与 system 彻底解耦，字节恒定；
- 压缩重定基线：compact 重写流时前缀本已整体失效（必付成本），快照行落在新
  流内——零边际；
- 崩溃恢复：中断 run 的字节保真回放（M21 既有机制）覆盖记忆行——context 行
  随流回放，无需特判。

### 3.5 system 静态指引

ac-memory 保留 loop/before-run 监听（主档，<memory> 静态块）：内容恒定字符串，
per-Agent enabled=false 时整块缺席（同为稳定形态）。指引词与旧桶语义无关。

### 3.6 服务 API（程序化写口）

- write(agentId, {content, peers?, tags?, origin?}) —— 条目铸造 + 原子追加
  （appendFileSync，进程内工具执行串行 + 数据根独占锁挡跨进程）；
- entries(agentId) —— 解析条目流（grep / 快照渲染共用）；
- grep(agentId, q) —— 过滤轴查询；
- set/append/get/ids/remove/fileOf/memoryBucketOf/anchorOf 退役（服务面收敛为
  write/entries/grep 三口）；persist=false 内存后端同语义（测试）。

ac-memory-core 改为渲染/解析纯库：快照渲染（确定性：条目升序、整数条截断、
溢出计数稳定）、条目头解析（容错降级）、预算分配；clipMemoryForInjection 退役
（快照渲染内建预算）。

### 3.7 整理（sleep-time，二期）

时间线膨胀治理：订阅 archive/completed（既有事件，不新增），对归档会话的
Agent 发起轻量整理 run——合并重复、沉降过时条目至 archive/、引入 epoch 进
seq 防整理重写后编号漂移。一期不做（无真实时间线数据前设计空转），膨胀由
快照预算截断兜底。

## 四、群聊成员转录流

### 4.1 形态

```
sessions/groups/<gid>/messages.jsonl   ← 群本体：post 真实发言（不变，唯一事实源）
sessions/<gid>~<member>/messages.jsonl ← 新增：成员私有转录流（per-member）
```

gid~member 正是 deliver 既有 handle 形态。**撞形分析**：runAddress 右起解析
（member 恒最右）不受 ~ 影响；真实撞形在**会话桶路径层**——群 id 与 Agent 同名
时 gid~member 与 1v1 对键争用同一桶（如群 `alice` + 成员 bob →
`sessions/alice~bob`）。防线三层：① 群 id 禁 `~`（规约）；② **双向名册校验**：
建群时查 agents 名册拒同名 Agent id，agents.register 时查群名册拒同名群 id
（装载期 + 注册期双卡）；③ 残余风险（注册面绕过）由一致性测试锁定。

### 4.2 工作方式

**post 扇出（投影行即入账行）**：post 入本体（现状）+ 逐成员流追加 viewer
投影行（自己的发言 assistant / 他人 user + <msg> 包装——projectRecord 现成
逻辑；附件随行）。写放大 = 每条 post × N 成员 × 数百字节，人速消息频率，可忽略。
扇出投影行是该消息在成员流中的**唯一**入账形态。

**入账边界（现状跳过机制的三处去向）**：

- 触发行跳过（`:962` message-received / `:1013` steered 监听器，isGroupHint
  meta 判定，与 shelf 无关）——**保留**：deliver 只唤醒不携消息，成员流不产生
  第二份触发行，触发材料由扇出投影行承担；
- 终稿 + settlement 拦截（**必改点，onReplyCompleted `:1758`**）：现状
  `isGroupHint(meta) || isGroupBucket(conversationId)` 拦下群 run 的终稿入账与
  journal 物化（M26：run 终稿不是群发言）。新形态下成员流 run 恒带 hint meta →
  转录全部被拦 → 成员流收不到任何 run 材料、退回派生视图等价物。改造：去掉
  `isGroupHint` 判定，只留 `isGroupBucket`（shelf 判定；gid~member 不在群名册
  天然不命中，旧群桶由 shelf 兜住）——成员流获得完整 settlement 转录，群本体
  行为不变。

**其余机制**：

- **成员 run**：conversationId = gid~member，走标准 session 机制——journal /
  settlement / 步级转录 / 崩溃恢复 / 回放 / 压缩全套白拿；
- **记忆协议**：delta 行落成员自己的流——流本身 per-agent，物理隔离
  （viewer 过滤都不需要）；origin 过滤轴照常工作（origin = gid~member）；
- **沉默语义（M26）不变**：run 输出 ≠ 发言，send_group 才 post——转录流私有，
  其他成员物理不可见，沉默权保真；
- **行为契约注入保留**：GROUP_CONTRACT_TEXT 注入判定按 conversationId ∈ 群
  名册——`gid~member` 不命中 → 契约静默失效；判定键改造（handle 解析出 gid）
  并入 ac-group 投递适配；
- **晚加入成员**：入群时一次性种子（本体尾部 + 归档摘要——现 historyFor 逻辑
  降级为种子函数）；
- **压缩**：成员流走 ac-archive 标准路径（conversationId 即 gid~member），
  各成员独立；本体轮转降级为纯 UI feed 关切，只留机械路径。

### 4.3 退役面（ac-group）

historyFor 派生视图（降级为入群种子）、windowOf/deriveWindow/tailScan（D6
派生窗全族）、相邻 peer 合并、latestArchiveSummary 头注入、rotateWithReview
（memoryOwner 属主分流）。

## 五、迁移

### 5.1 存量记忆（版本切换一次性）

启动后逐 Agent 投递迁移 run（deliver，机制任务形态：meta 标记零污染 +
maxSteps 硬闸 + fire-and-forget 不阻塞 boot，对齐群归档整理 run 模式）：

- **前置检查**：Agent 无 `memory` tag → 跳过投递并告警（memory_write 不可见，
  迁移指令必然失败——§3.2 授予路径）；用户补 tag 后重启/手动重发；
- 消息**内嵌旧记忆内容**（宿主机械读取 files/<agentId>/memory/*.md 全部桶，
  每桶一节标注来源关系；超预算截断告知）——**不告知文件路径、不依赖 fs 工具**，
  上下文零路径残留；
- 指令：用 memory_write 将值得长期保留的信息条目化转译（可筛选、可改写、
  可丢弃过时内容）——非结构化→结构化转译由 Agent 完成；
- 幂等：marker 落盘（files/<agentId>/memory/.migrated）；失败记日志，重启或
  手动重发；旧桶文件保留不删（供回查），不再注入。

### 5.2 存量群聊（切换点冷启动）

成员流从零开始：首条 post 前做一次性种子（§4.2 晚加入逻辑同款）。切换点之前
的 run 无转录（物理不存在），显式接受——从切换点起回放可用。

## 六、施工面

### 6.1 改动包

| 包 | 改动 |
|---|---|
| ac-memory | 重写：MemoryService（write/entries/grep）+ 工具两行 + 静态指引 + 注入协议 + 迁移投递 |
| ac-memory-core | 渲染/解析纯库（快照确定性渲染、条目头容错解析、预算分配） |
| ac-group | 成员流扇出 + deliver 键改造 + GROUP_CONTRACT_TEXT 判定键改造（handle 解析 gid）+ 派生视图/轮转属主分流退役 + 入群种子 + 群 id 禁 ~ 与双向名册校验 |
| ac-archive | 记忆耦合删除（整理提示词记忆条目、memoryBudgetOf/memoryEnabledOf）+ 概要提示词通用规则「context 注入行是机制材料，无需纳入概要」 |
| ac-session | 契约面不动，代码必改一处：onReplyCompleted 入账跳过判定（`:1758`）去掉 isGroupHint、只留 isGroupBucket——否则成员流 run 终稿/步级转录全被拦（§4.2）；触发行跳过（`:962`/`:1013`）保留；另验证注入时点路由（§3.3） |
| ac-singles | prefixRevision 记忆哈希段删除（`:203-221` 经 memoryBucketOf+get 读记忆进修订键）——记忆退出 system 后静态指引块恒定，无需进键；memoryBucketOf/get 退役后此为唯一消费方，同步删 |
| ac-conversation | deliver 群投递分支适配：读者端点按 handle 推导（gid~member）、hint 携消息语义调整（投影行即入账行，deliver 只唤醒）——施工验证后定具体改面 |
| ac-plugin-core | reserved.ts：+memory_write/memory_grep；「已移除」注释改写为本裁决 |
| ac-agent-presets-builtin | 内置预设 tags 增补 memory（§3.2 授予路径） |
| WebUI | 创建面默认勾选 memory tag；ac-client-ui-group 记忆属主 UI 删除；ac-client-ui-conversation 身份回落逻辑更新；群成员会话视图入口（复用 subagent view） |

### 6.2 memoryOwner 全链退役清单

ac-group 契约字段 + setMemoryOwner/removeMember 清理 + group/memory-owner-set
事件 + RPC group/set-memory-owner；ac-memory anchorOf；WebUI 两包（群设置面板、
会话身份回落）；集成测试。半退役状态（字段在、语义悬空）最差——删干净。

### 6.3 退役注释同步

ac-timer/service.ts:737 引用 memoryBucketOf 语义的注释随 API 退役改写（小）。

### 6.4 验证阶梯

任何 src/ 改动：pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向
lint。另：契约/事件/行集面变化（memory 服务 API、group 事件退役）→ pnpm smoke；
持久化/会话链路 → pnpm test:integration + 定向 npx vitest run src/ac-memory、
src/ac-group。测试面：协议状态机（锚检测 / H>S delta / H=S 空转 / H<S 自愈 /
origin 过滤 / 压缩后重定基线）、扇出投影正确性、沉默权（成员流私有性）、
1758 改造回归（群本体零转录写入 + 成员流完整转录并存）、迁移幂等、注入时点
集成（§3.3 验证点）、撞形一致性（群 id 双卡）。

## 七、观察项（上线后验证，群聊效果以实测为准）

1. 群成员连续 run 的 KV 命中（provider usage cacheHit / 前缀 token 增量）——
   对照派生视图时期基线；
2. delta 注入频率与体积（空 delta 占比——跨会话写入是否如预期稀疏）；
3. memory_write 自主使用率（Agent 是否在恰当时机写记忆——静态指引的有效性）；
4. 成员流增长速率 vs 压缩阈值（扇出写放大实测）；
5. M26 行为契约服从性（新视图形态下沉默/不刷屏是否保持）；
6. 迁移转译质量抽查（条目化合理性、过时内容丢弃判断）。

## 八、裁决记录

| 事项 | 裁决 |
|---|---|
| 记忆介质 | md 单文件（Claude 形态），不上向量库/图库（个人 Agent 规模负资产） |
| 读路径 | checkpoint+delta 流式协议（非 system 恒注入快照——旧形态刷新杀前缀、陈旧度 24h） |
| 写路径 | append-only 单工具；不提供 rewrite（整理归 sleep-time） |
| 跨会话可见 | 有意语义（人格连续性）；演进位 = peers 注入侧过滤 |
| 伪造边界 | 不收紧 fs 写域；协议正确性不依赖条目头真实性 |
| tag 授予 | 不重启自动补齐（2026-09-16 裁决）；显式配置 + 迁移前置检查 |
| 存量迁移 | Agent 自行转译（消息内嵌内容，零路径残留） |
| 群聊冷启动 | 切换点前无回放，显式接受 |
