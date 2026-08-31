# M21 规划：会话回放重构——视角正确性与 KV 前缀稳定（DSH 对齐）

> 状态：**✅ 已实施（2026-08-27）**——步骤 1-7 + D14 全部落地，
> `pnpm preview:typecheck && pnpm preview:test` 全绿；D13 中性格式按
> session-design 裁决执行（header v1 即中性 + 迁移脚本
> preview/scripts/migrate-session-neutral.ts）；D11 列 M22、D5 快照取
> 「修订键锚点 + 终态核验」形态——详见 session-design.md §8.1 落地状态
> 与 README 各行 M21 标注。本文保留为实证档案与决策记录。
>
> 缘起与范围（按用户评估问题逐项对应）：
> 1. **a⇄b 回放正确性**：preview 未继承 src 的 `role='agent' + agent_id`
>    中性行 + provider 视角转换设计——实证确认 Agent⇄Agent 会话回放
>    视角错乱 + 双视图发散（§1）。
> 2. **KV 缓存经济性**：以 DSH 的前缀稳定纪律
>    （`dsh-kv-cache-analysis.md`）为参照系重设计会话回放：Agent 对会话
>    的 system 抖动（记忆/日期/归档）**本期接受、后续另议**（§3.1）；
>    singles 以 system prompt 持久化追求前缀绝对稳定（§3.2）；群参考
>    src 设计分析（§3.3）。
> 3. **DSH 落盘设计对照**（`dsh-session-storage-format.md`）：事件溯源
>    日志/版本治理/崩溃语义三方面可吸收件已并入（§3.4、§5 步骤 7、
>    §9 附录）；重量级的崩溃闭合器列 M22 候选（§7）。
>
> 前置事实：KV 缓存命中本身不是目标函数——成本与 TTFT 才是。实测
> 全局命中率 95.3%（§0.2），说明现状没有"系统性低命中"，本修复针对
> 的是**结构性的前缀破坏点**与**回放语义错误**，不是救火。

---

## 1. 实证一：a⇄b 回放的三层失败（用户问题 1）

### 1.1 背景：两轨的消息归属设计

| | src | preview |
|---|---|---|
| 持久化角色 | `role='agent'`（**中性**，所有 Agent 发言统一） | 写入时烘死的 `user`/`assistant` |
| 归属标记 | `agent_id`（说话人） | `name`（说话人） |
| 视角处理 | provider `resolveApiRole` 按**读者**转换：`agent_id===viewer→assistant`、`agent_id==='user'→user`、其余→user（`src/core/llm-openai/src/openai.ts` L660-688） | **无**——角色即写入视角，换读者不换角色 |

### 1.2 失败层 1：桶内角色按"投递目标"写死，发起方的半段对话角色颠倒

a⇄b 共享桶 `a~b`（`pairKey` 排序双向一致），ac-session 入账规则：
入站记 `user`+name=sender、回复记 `assistant`+name=回复 Agent。于是：

| 事件 | 落盘行 | b 读回放时该行的正确角色 | 实际角色 |
|---|---|---|---|
| a 发起 → b | `user name=a` | user ✓ | user ✓ |
| b 回复 a | `assistant name=b` | assistant ✓ | assistant ✓ |
| **b 发起 → a** | `user name=b` | **assistant**（b 自己说的话） | **user ✗** |
| **a 回复 b** | `assistant name=a` | **user**（对端说的话） | **assistant ✗** |

即：**每个 Agent 回放共享桶时，对端发起的半段对话角色恰好颠倒**——
自己的历史发言以 user 身份出现（"有人对我说了这句"，实际是自己说的），
对端的回复以 assistant 身份出现（"我说过这句"，实际是对端说的）。
`name` 字段能部分救回归属辨识，但 role 是 chat 模型最强的身份条件，
错乱直接污染第一人称连续性。a 的回放对称地错另一半。

user⇄agent 桶不受影响（虚拟端 user 永远是 reader 侧的"对方"，
写死角色恰好等于读者视角）——**这正是问题长期未暴露的原因**：
主路径（用户直答）语义正确，Agent⇄Agent 委托路径才触发。

### 1.3 失败层 2：双 handle 双视图，播种一次后永不再同步

M19 对桶模型下 `runAddress(agent, conv)` 使 a、b 在同桶各有独立门与
独立上下文视图（`a~b~a` / `a~b~b`）。`send_agent` 首次投递时以
`session.history(convKey)` 播种（ac-collab-tools L119-128），
`contextFor` **只在视图不存在时播种一次**：

- b 的视图（`a~b~b`）此后只积累 a→b 入站 + b 的回复；
  **b 发起的方向（b→a 及 a 的回复）进了桶文件，永不进 b 的视图**——
  长活进程内 b 对自己发起的半段对话"失忆"，直到重启才被重新播种。
- a 的视图对称。两视图随进程存活越久越发散，且都与文件不一致。

### 1.4 失败层 3：视图行与文件派生行字节不等价（跨重启缓存全丢）

- 进程内 push：`{role, content}`（**无 name**；record 固化的
  `message_id`/`timestamp` 会变异进对象随信封进 provider 请求）；
- 文件回放：`{role, content, name}`（无固化字段）。

重启后首个请求在 name/固化字段处分叉 → 全量 miss（provider 侧缓存
本可跨重启命中）。此为通用问题（不限 a⇄b），v1 版 M21 的 P1。

### 1.5 结论与修法方向

用户判断**成立**。修法不是回退到 src 的中性角色存储，而是把 src 的
**按读者投影**语义移到回放层：`name` 已是完备的说话人标记（对桶行
恒有 name），回放时按 viewer 变换（`name===viewer→assistant`，
其余→user）即可——对 user⇄agent 桶是恒等变换（零回归），对 a⇄b
桶恰好修复颠倒。视图侧统一为"文件事件的按读者增量投影"（§3.1、§5
步骤 1-2）。

---

## 2. 实证二：KV 缓存现状与 DSH 机制映射（用户问题 2 总纲）

### 2.1 DSH 的核心纪律（`dsh-kv-cache-analysis.md` 提炼）

> **把"请求前缀字节级稳定"提升为整个框架的一等架构约束。**

- 请求前缀 = `[system][tool schema][history]`；每步请求 = 上一步的
  字节级前缀 + 纯追加后缀 ⇒ 服务端自动前缀缓存除尾部全命中；
- 八机制分层担责：append-only 事件溯源 + 派生历史（M1）、system 与
  工具顺序确定性（M2）、易变内容追加化不进前缀（M3）、条件
  reasoning 回传（M4）、请求可重建不变量（M5）、compaction 是唯一
  前缀破坏者且自身复用缓存（M6）、计量闭环（M7）、不为不存在的
  语义留 API（M8）；
- 每个包必须回答"我对请求前缀做了什么"（KV Cache effect 声明纪律）。

### 2.2 映射表：AgentChat preview 现状逐机制对照

| DSH 机制 | preview 现状 | 判定 |
|---|---|---|
| M1 append-only 会话 + **派生**历史 | 文件 append-only ✓；但内存视图非派生（独立积累、播种一次、与文件发散） | ✗ → §3.1 重设计 |
| M2a system 确定性组装 | persona/framework 分块拼接，输入不变则输出确定 ✓ | ✓ |
| M2b **工具顺序规范化** | `toolSpecs` 按 `ctx.tools.list()` **注册顺序**（插件加载时序产物）——HMR/装卸插件即变 | ✗ → §5 步骤 3 |
| M3 易变内容追加化 | datetime 在 system（日更，src 资产 #12 已按日收敛）；memory 在 system（变更即失效） | agent 桶本期接受（§3.1）；singles 需处理（§3.2） |
| M4 条件 reasoning 回传 | run 内 assistant 轮不回传 reasoning_content；当前模型（deepseek-v4-flash 等）工具循环未要求 | ✓（切 thinking 系模型时复核） |
| M5 请求可重建不变量 | 无 | 以 golden 等价测试做轻量版（§5 步骤 6） |
| M6 compaction 唯一破坏者 + 自身复用缓存 | M20 整理 run 的提示词 = agent system + `session.history()` 逐字回放 + 尾部整理指令——**结构上已是 DSH 8.3 形态** ✓；触发比 archiveTokenRatio=0.5（DSH 用 0.8×窗口，更晚触发=更少失效） | ◐ → §6 D6 |
| M7 计量闭环 | cacheHit/cacheMiss 入 usage 流水（M15）✓ | ✓ |
| M8 无显式缓存标记 | 无 ✓ | ✓ |

### 2.3 实测基线（2026-08-27，preview/data/usage/*.jsonl）

全局 9,140 run 命中率 **95.3%**；news（2,191 run）91.3%、均 miss/run
≈16k。news 逐 run 呈双峰：稳态定时轮 95–99%（miss=本轮新工具输出，
架构不变量）；1% 全量 miss 簇 = 9.5h 空闲后的 provider 逐出 + 重启后
的 §1.4 字节分叉。结论：**无系统性低命中，修复对象是结构性破坏点**
（§1.4、工具顺序、群滑窗）而非整体策略。

---

## 3. 三种会话形态的回放重设计

统一心法（DSH M1 + 落盘第 1 原则"事件是真理，消息是投影"）：**会话
文件是唯一事实源（append-only）；每个参与者的上下文视图 = 文件按读者
视角的派生投影；进程内 = 增量投影缓存，重启 = 重派生，二者必须字节
等价；compaction（归档/轮转）是唯一的 replace，显式、低频、且触发
视图重派生。** DSH 的存储层验证了该纪律可贯穿到底（无平行"持久化
消息类型"，一切视图从日志确定性派生）——preview 不动存量行格式即可
获得同构收益（§3.4）。

### 3.1 Agent 对会话（a⇄b / user⇄x，问题 2.1）

- **回放**：`history(conversationId, { viewer })` 按 §1.5 变换。
  user⇄x 恒等（零回归），a⇄b 修复视角颠倒。
- **视图派生化**：ac-conversation 订阅 `router/message-received` /
  `router/reply-completed`，把每个文件事件**投影进该桶全部 handle**
  的视图（`speaker===viewer→assistant`，否则 user；行形态
  `{role, content, name}` 与文件派生完全一致）——修复 §1.2/§1.3/§1.4
  三层（视角、发散、字节等价一步到位）。
- **归档联动**：订阅 `archive/completed` 标记该桶全部 handle stale，
  下次 startRun 重派生（stale-惰性，天然避开在途 run 竞态）——修复
  v1 版 P2（归档后视图不收缩、长活进程预算失效）。
- **system 抖动**（memory/datetime/归档 rewrite）：**本期接受**（用户
  裁决），失效面 = 该桶一次全量 reset，频率 = 记忆变更/日更/归档。
  后续优化方向已预留（memory 挪尾部注入等，见 §6 D4 同构决策）。
- **整理 run 的缓存复用**（M20 已达成的 DSH 8.3 形态）：保持。

### 3.2 singles 独立会话（问题 2.2：system prompt 持久化 → 前缀绝对稳定）

目标：`[system + tool schema]` 前缀对该会话**跨轮、跨重启字节不变**
（singles 是最自 contained 的形态：无对端 Agent、model 覆盖恒定 =
路由/缓存域恒定），是 DSH 纪律的最佳试点位。

设计：
- **快照持久化（DSH EpochHeader 子集 + fold-latest）**：快照形状 =
  `{ system 全文, 规范化后 tools schema 全集, 修订键 }`——不只
  system：工具集变化同样是"历史无法复现"的因子（DSH agentPreset
  持久化的同一论证），修订键必须覆盖二者。single 创建（或首跑）时
  组装并持久化到 singles 自有目录（`session.json` 新字段或 sidecar
  `system.md`）；此后每跑字节复用快照，不再重组装。快照**最新胜**
  （fold-latest，重拍覆盖）——它只服务前缀复现，审计需求由 usage
  流水兜底。
- **易变件出 system、追加化**（DSH M3）：
  - datetime → **每日一条 user 快照**（追加，日内幂等不再注入；比
    in-system 日更严格更优：日内零失效，跨日仅追加）；
  - memory（键=sid）→ 快照按 memory 内容哈希作修订键：变更时重拍
    快照（一次显式失效）**或** 变更内容以 user 快照追加（绝对稳定）
    ——二选一见 §6 D4。
- **残余失效清单**（显式接受，均可枚举）：Agent 档案/人设编辑、
  生效工具集变化（含工具顺序规范化落地后仍存在的增删）、模型覆盖
  修改（换缓存域）、memory 修订（D4 选快照重拍时）。
- **工具顺序**：§5 步骤 3 的规范化对"绝对稳定"是前置必要条件。
- 归档：singles 桶照常走 M20 流程（replace 显式失效，低频）。

### 3.3 群会话（问题 2.3：src 设计分析与修法）

src 设计（preview M15 已原样平移）逐项 KV 评估：

| src 设计点 | KV 判定 |
|---|---|
| 共享 append-only 本体（仅真实发言，无思考/工具） | ✓ 事实源正确 |
| per-viewer 投影（own 原文、peer `<msg>` 包装） | ✓ 每成员独立缓存域，投影确定性 ⇒ 成员内前缀稳定 |
| 相邻 peer 纯发言合并 | ◐ 追加兼容（新 peer 发言只扩展尾部合并块，前缀在尾部块结束符处分叉，损失小）✓ 可保留 |
| 轮转摘要头注入 | ✓ replace 语义、低频，可保留 |
| **尾部 `loadLimitTokens` 截断（每次回放从尾重算）** | ✗✗ **核心缺陷**：本体每增长，截断窗头前滑 ⇒ 每轮请求的历史首条都在变 ⇒ **群请求的历史前缀每轮整体重建**——群是三形态中唯一"结构性永不命中"的 |
| 事件行/触发 hint 进本体 | ✓ append-only |

修法（对齐 §3 统一心法）：per-viewer **派生视图**替代逐轮全量重投影
——
- 成员视图首次触发时派生一次（`[轮转摘要头][按 loadLimit 的尾窗
  投影]`），此后本体新事件**增量投影追加**（含尾部合并块的增量
  合并规则：与尾块同说话人则并入）；
- 视图超阈值（建议 0.8×窗口，§6 D5）→ 显式重派生（可配合本体轮转
  的新摘要），一次性失效；
- 重启 = 重派生，与进程内派生同一函数 ⇒ 字节等价（golden 可测）；
- steer 注入（readSince 增量）与视图投影同一构造点（已是，保持）。

### 3.4 DSH 落盘设计的便宜吸收（用户问题 3：纯增量、不动存量行格式）

对照 `dsh-session-storage-format.md`（事件溯源日志 / 版本治理 /
崩溃语义），三件值得本期吸收：

- **B1 会话头行（版本锚点）**：preview 的 `messages.jsonl` 目前零
  版本治理——src 轨道的教训已在预演（`trigger` 解包兼容层、两种
  `tool_calls` 形状并存、`hist-*` 稳定 id 回填，格式演进代价全堆在
  读取代码里）。DSH 做法：首行不可变 `SessionHeader`（version /
  createdAt / 关键元数据），解析侧对未知版本**宁可拒绝也不误读**。
  preview 增量做法：新会话首行写
  `{"type":"session-header","version":1,"createdAt":…}`；读取时无
  头行 = 旧格式按现规则宽容解析（个人数据宁可部分可用，不学 DSH
  全严格读）。成本一个字段，换未来一切格式演进的 fail-loud 锚点。
  落点：ac-session 写入口。
- **B2 单调 `seq` 字段**：SessionRecord 增可选 `seq`（writer 按文件
  单调分配）。三重收益：① **归档尾锚修复**——`readLastArchived`
  的"读末 8KB 解析末行"对 preview 128KB 大行事实失效（实测最大行
  128.6KB > 8KB 窗口 → 解析失败 → 锚返回 null），有 seq 后锚 = 末
  行 seq 值（或 sidecar `anchor.json`），零解析；② 崩溃/丢行检测
  （seq 断裂 = 有损，现在完全不可见）；③ 归档二次去重从内容匹配
  （findMessageIndex 按内容找）变序号匹配。增量兼容：旧行无 seq
  视为缺失，行为不变。
- **B3 已并入 §3.2**（快照 = EpochHeader 子集 + fold-latest）。

**明确不学**（§7"不做"同步收录）：SQLite/seek 后端、投影检查点
缓存（单机个人规模无查询压力）；"未知必需事件拒绝加载"全严格读
（preview 选宽容跳过，B1 留加严口子）；zstd 帧串接/硬链接原子发布
（Windows 主场，tmp+rename 已够）；chunk 打包压缩（steps[] 体积
问题先做末步文本双写消除，压缩暂缓——且若将来做，遵守 DSH 原则
"压缩是编码层词汇，不是事件词汇"，不污染 SessionRecord 词表）。

---

## 4. 目标形态（一句话）

**会话文件是 append-only 唯一事实源；一切回放 = 按读者的确定性派生
投影（视角正确、进程内与重启字节等价）；singles 的 system 前缀持久
化绝对稳定；工具顺序与注册时序解耦；归档/轮转是唯一的显式 replace
且低频；每步请求 = 上一步的字节级前缀 + 纯追加后缀。**

## 5. 分阶段落地（每步独立可验证）

1. **回放视角转换（修 §1.2）**：`session.history(convId, { viewer })`
   — `name===viewer→assistant`、其余→user（event 行维持→user）；
   collab-tools/timer/web-api 传 viewer=目标 Agent。user⇄x 断言恒等
   （零回归门），a⇄b 断言双侧视角正确。
2. **视图派生化（修 §1.3/§1.4/§1.5 + 归档收缩）**：ac-conversation
   视图改由 router 事件投影驱动（全 handle、行形态与文件派生一致、
   含 name）；`archive/completed` → stale → startRun 重派生。golden
   测试：进程内视图 ≡ `history(conv, {viewer})` 重派生（字节级，覆盖
   steer/链跑/虚拟端点私信/a⇄b 双向）；归档后下一轮 ctx 回落预算内。
3. **工具顺序规范化（DSH M2b）**：loop `toolSpecs` 缺省按工具名字典
   序（与注册顺序解耦）；落地即全量一次失效（一次性迁移成本，可
   接受）。测试：装卸无关插件后 schema 序不变。
4. **singles system 快照（§3.2）**：ac-singles 增快照持久化 + 修订键
   + before-run 消费快照；datetime 日快照追加；memory 按 D4 裁决。
   测试：同 single 跨"重启"（重建上下文）system+tools 前缀字节不变；
   修订失效路径显式触发。
5. **群派生视图（§3.3）**：`historyFor` 拆为"派生一次 + 增量投影"；
   阈值重派生；重启等价。测试：连续两轮群消息，第二轮请求前缀包含
   第一轮（除尾部合并块）；滑窗消除。
6. **观测固化（DSH M7/M5 轻量版）**：usage 对比查询脚本化（命中率/
   miss 分布，验收基线）；"KV Cache effect" 声明纪律引入——各回放/
   注入相关行的头注释声明自己对请求前缀的作用（None / Append-only /
   Prefix-stable / invalidate-from-X）。
7. **落盘版本锚点与 seq（§3.4 B1+B2）**：ac-session 写入口增会话
   头行（新会话首行 `{"type":"session-header","version":1,…}`）+
   SessionRecord 可选 `seq`（writer 按文件单调分配）+ 归档尾锚改
   seq/sidecar 锚（修 128KB 大行下 8KB 窗口解析失效）。纯增量：无
   头行旧文件按现规则宽容解析，旧行无 seq 行为不变。测试：头行
   识别/版本拒绝路径；seq 连续性与断裂检测；归档二次去重用 seq 锚
   对拍内容锚。

每步验收：`pnpm preview:typecheck && pnpm preview:test`；步骤 1/2/4/5
后以真实数据对比 §2.3 基线（重启后首 run、归档后下一轮、群连续轮、
singles 跨重启）。

## 6. 决策点（动工前需拍板）

- **D1｜视角转换落点**：推荐 **`session.history` 加 viewer 参数**
  （唯一回放边界，全部调用方受益；provider 层不动——preview 的
  LlmMessage 已带 name，无需 src 的 toProviderMessages 双格式）。
  备选：ac-conversation 投影时变换（session API 不变，但群/其他
  history 消费方拿不到正确视角，不推荐）。
- **D2｜跨 handle 同步机制**：推荐 **router 事件投影驱动**（视图 =
  文件事件的纯派生，天然覆盖 a⇄b 双向 + steer/链跑；startRun 现有
  push 逻辑退役或退化为兜底）。备选：保留 startRun push + 补丁式
  同步（改动小但维护两套真相源，违背派生心法，不推荐）。
- **D3｜工具顺序策略**：推荐**字典序缺省**（零配置确定性）。备选：
  DSH 式显式 `toolOrder` 配置 + rest 项（更可控，但引入配置面与
  fail-loud 校验，当前无排序需求证据，暂缓）。
- **D4｜singles 的 memory 取舍**：推荐 **快照按 memory 修订键失效**
  （memory 变更=一次显式失效；保留 system 位指令强度，实现简单）。
  备选：memory 出 system、变更以 user 快照追加（绝对稳定但指令位置
  弱化、追加行永久占史）。二者 datetime 均出 system（无争议）。
- **D5｜群视图重派生阈值与机制**：推荐 **0.8×模型窗口**（对齐 DSH
  compaction 阈值语义；窗口尺寸先用保守常量、后续按模型映射表细化）。
  备选：沿用本体轮转阈值联动（实现省一步，但视图与本体的失效节奏
  耦合，收益低）。
- **D6｜归档触发比（agent 对会话）**：推荐**维持 0.5 本期不动**（归档
  已带整理成本与 LLM 账，提早触发有真实性收益；提阈值属调参非结构，
  待 D5 落地后用 usage 数据再议）。备选：对齐 0.8（更少失效但归档
  频率下降的收益与整理质量风险未量化）。
- **D7（低优）｜近窗轨迹回放**（v1 版遗留项）：`hooks['session'].
  replayTrajectory: K` 维持**不实装**（无重复工具调用的实测抱怨）；
  本文档以回放正确性/稳定性为先，轨迹连续性等证据出现再议。

## 7. 风险与不做的事

- **风险**：① 视角变换漏点（虚拟端点私信/event 行/tool 行）——
  golden 测试矩阵全覆盖 + user⇄x 恒等门；② 事件投影与 startRun 的
  时序竞态（message-received 先于 loop、reply-completed 后于 loop，
  投影只依赖事件序不依赖 run 序，无竞态面；steer 注入行经
  conversation/steered 事件同链投影）；③ 工具顺序落地的一次性全量
  失效（接受，一次性）；④ singles 快照与 Agent 档案编辑的失效交互
  ——修订键必须覆盖 persona/system/hooks 全集，漏键 = 静默陈旧
  （fail-loud：修订键计算覆盖装配输入白名单）；⑤ 群增量合并规则与
  全量派生的等价性——golden 对拍（随机本体序列，增量结果 ≡ 全量）；
  ⑥ 头行/seq 与旧文件混读（无头行文件、compact 重写后 seq 基准）——
  兼容路径测试锁定（无头 = 旧规则、compact 后 seq 从 keep 尾继续）。
- **不做**：推翻对话级回放默认（§2.3 实测无系统性低命中）；src 全
  轨迹回放（D7）；agent 桶 system 抖动优化（用户明示后议）；provider
  缓存预热/保活；DSH 式 request/header 事件与 deepFreeze 全套（以
  golden 测试轻量替代）；M20 归档算法。
- **不做（DSH 落盘件，§3.4）**：SQLite/seek 后端与投影检查点缓存
  （单机个人规模无查询压力）；"未知必需事件拒绝加载"全严格读
  （preview 选宽容跳过，头行留加严口子）；zstd 帧串接/硬链接原子
  发布（Windows 主场，tmp+rename 已够）；chunk 打包压缩（先做末步
  文本双写消除；将来做须守"压缩是编码层词汇"原则）。
- **邻接 backlog（M22 候选，非本期）**：
  ① **崩溃闭合器**——DSH 落盘设计里对 AgentChat 最有行动价值的
  遗珠：重启发现未闭合轮时**追加**合成行补平日志（未答复工具调用
  按风险分级合成结果：`TOOL_NOT_STARTED`"可重试" vs
  `TOOL_OUTCOME_UNKNOWN`"结果未知，只重试只读/幂等操作，有副作用
  的先核验外部状态，不要盲目重试" + `turn/end{interrupted}`）——
  对应 preview 已知最大落盘弱点（mid-run 崩溃整轮丢失、已执行工具
  副作用零痕迹）；② **step 级增量落盘**（修 mid-run 丢失的事务性：
  assistant 的 tool_calls 决策先于工具副作用落盘）——闭合器需要
  先有 step 级落点才有意义，二者应同做。

## 8. 完成判据

- **a⇄b 视角**：golden 测试——a、b 各自回放同一桶，`name=自己` 的行
  全为 assistant、其余全为 user；user⇄x 桶回放与现状逐字节一致
  （恒等门）。
- **派生等价**：进程内视图 ≡ `history(conv, {viewer})` 重派生（字节
  级；覆盖 steer/链跑/私信/a⇄b 双向/归档后），测试绿。
- **归档联动**：归档完成不重启，同桶下一轮 ctx 回落 keep 预算内；
  在途 run 不截断。
- **singles**：同一 single 跨重启（视图重建）system+tools 前缀字节
  不变；datetime 跨日仅追加一行；memory 修订失效路径显式可测。
- **群**：连续两轮消息，第二轮请求前缀包含第一轮完整字节（除尾部
  合并块）；无逐轮滑窗。
- **工具顺序**：工具 schema 序与插件装卸/注册顺序无关，测试绿。
- **落盘锚点（§3.4）**：新会话文件首行为 session-header；无头行旧
  文件回放行为不变（兼容门）；seq 连续且断裂可检测；归档二次去重
  在 >8KB 大行场景下锚不失效（回归修复门）。
- **观测**：`pnpm preview:typecheck && pnpm preview:test` 全绿；
  §2.3 基线查询可复跑，重启后首 run 无结构性 1% 命中（空闲逐出除外）。

---

## 9. 附录：DSH 落盘设计对照总表（用户问题 3 凭证）

分析对象：`WorkDev/dsh/dsh-session-storage-format.md`（DSH 会话日志
的逻辑格式/物理编码/崩溃语义）。分档结论：

**A 档（验证 M21 方向，已加注）**：① 存储行保持中性完备、一切视角
是投影——验证 §1.5 修法与 §3 统一心法；② `surfaceOp: replace` 是
唯一前缀破坏操作、显式低频可审计——对应"归档 = 唯一显式 replace"
（preview 归档分段 ≡ DSH 被遮蔽原始日志，审计语义已等价）；③
agentPreset 持久化论证（"换了组合历史将无法复现"）——§3.2 快照
修订键同一论证；④ 工具参数存原始 JSON 串——验证 M18 选择。

**B 档（便宜吸收，已并入本文）**：B1 会话头行版本锚点（→ §3.4/
步骤 7）；B2 单调 seq + 归档尾锚修复（→ §3.4/步骤 7，128KB 大行
下 8KB 窗口解析失效为直接动因）；B3 singles 快照 = EpochHeader
子集 + fold-latest（→ §3.2）。

**C 档（有价值但正交/重，不进本期）**：① 崩溃闭合器（合成
tool/result 风险分级 + turn/end{interrupted}）——与回放正确性正交，
且依赖 step 级落点，与 ② step 级增量落盘 同列 M22 候选（§7 backlog）；
③ chunk 打包压缩（逻辑日志 ~60% 缩小）——steps[] 体积先做末步文本
双写消除，压缩暂缓。

**D 档（明确不学）**：SQLite/seek、投影检查点缓存（无查询压力）；
全严格读（个人数据宁可部分可用）；zstd 帧串接/硬链接原子发布
（Windows 主场）；delegationDepth/parentSession 谱系（preview
subagent 直连不落盘）。
