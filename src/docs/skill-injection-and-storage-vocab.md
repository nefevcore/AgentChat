# 技能注入持久化与会话存储词汇 v2（skill-injection-and-storage-vocab）

> 2026-09-18 会话裁决链存档。起点：load_skill 在 run_code 程序化模式下失效；
> 终点：会话存储词汇 v2（role/source/label 三轴）+ 技能注入三通道 + 版本升级
> 数据迁移机制。相关：session-design（M21/D13 中性格式）、tag-system-report。

## 0. 问题链（按发现顺序）

1. **load_skill 程序化模式失效**：工具描述「加载后按其指令执行」在传统模式成立
   （ToolResult 直接入对话历史），在 run_code 程序内子调用不成立——结果只留
   程序作用域，且 run_code 注入纪律要求「读文件/搜索结果取摘要不回传全文」，
   模型丢弃返回值 = 技能从未加载（本会话首轮实测复现）。
2. **瞬态手势注入的 KV 账**：/name 手势注入是 run 内瞬态（gestureServed 账本
   按 run 翻页），每 run 重新服务 → 技能正文 R 每 run 尾部重现、永不进入可复用
   前缀——R 每 run 全价重付；run 内每步尾部重注则 R 每步 KV 重算（不影响计费，
   影响 TTFT）。尾部追加不破坏其余内容的前缀复用（分歧点本就在轮边界），
   但 R 自身是持续漏损，随技能体积 × run 数线性放大。
3. **结论**：注入必须持久化到会话历史（成为前缀的一部分），一次落账、跨 run
   永久回放。

## 1. 注入三通道（裁决 #1）

前提：**load_skill 不再返回技能正文**（否则 run_code 场景「返回一份 + 注入一份」
双份冗余，且返回正文是搬运诱饵）。返回轻量确认 `{ name, scope, baseDir,
status: 'injected' }`。程序内分析 SKILL.md 的用例改走 read（baseDir 在返回值）。

| 路径 | 当前 run 内 | 跨 run 持久化 |
|---|---|---|
| 手势 /name | before-run 判定 → 落账 context 行 + 同字节 append 进 request.messages | 落账行经 history() 永久回放 |
| 直调 load_skill | 不注入（run 行 steps 携带结果，replayTrajectory 缺省展开即正文在场） | 同左（无新机制） |
| run_code 子调用 load_skill | after-execute 登记 pending → before-step 瞬态注入（run 内每步尾部，字节稳定、按名排序） | reply-completed 收束合并落账（run 行之后；去重、按名排序） |

手势判定收窄：只判 before-run 时的「当前触发消息」= 尾部连续 user 块（已服务者
与后续消息之间有 context/reply 行天然分界）；历史手势消息不二次判定；同名技能
已在历史 context 行 → 跳过（不追加尾部 = 不动前缀，KV 与 token 双优）。
gestureServed 账本整个退役。

落账时序裁决：手势 **pre-run**（run 行之前落账，防正文随会话增长漂移远离手势
消息）；run_code **post-run 收束**（append-only：run 行未落时早插会错序；群桶
并发 run 防穿插）。

## 2. 存储词汇 v2：role / source / label 三轴（裁决 #2）

现状：role 载语义类别（agent/event/error），存储 source 是 role 的 1:1 复读
（`event⇔event`、`error⇔error`，全仓无第三取值、零消费者——判死刑后改判正名）。
v2 三轴正交：

- **role = 消费通道（封闭词汇）**：`agent`（真实发言）/ `context`（上下文材料
  ——LLM 回放 user 语义位，UI 按呈现）；`event`/`error` 退役，由 context +
  source 表达。system/tool 预留不变。
- **source = UI 决策词（开放词汇）**：`'event'`（机制行 → 分隔符）/ `'error'`
  （红色语义）/ `'skill'`（技能注入 → label 条）/ 未来按需。
- **label = UI 文案（可选）**：缺省按 source 回落（后台事件/运行错误）。

```
{role:context, source:event}              ← LLM 回放 + UI 分隔符
{role:context, source:error}              ← LLM 回放 + UI 红色语义
{role:context, source:xxxx, label:xxxx}   ← LLM 回放 + UI label 条（点击展开正文）
```

消费方影响：

- projectRecord：context → user 显式分支（source 无关；event/error 旧分支删除，
  未迁移残行走「未知词表按 user 喂回」防御兜底，语义等价）
- journal 折叠：`context + source:'event'` 组合判定——技能行（source:skill）不折
  （正文折叠即语义丢失）
- hint 视点过滤：context 行统一按 agent_id 过滤【行为变更：error 从读者无关 →
  过滤——共享桶对端不再看到对方 run 的错误行】
- UI project 行形态：`'agent' | 'context'`（携带 source/label）
- S3 不变式更新：进程内视图 ≡ history() − context 行（双读者有意分歧的显式化）

教训（写入词汇表纪律）：新词汇必须带着消费者出生。source v1 是「先造字段后找
用途」的反例；v2 的 source/label 自带 UI 决策与文案职责。

## 3. UI 形态（裁决 #3）

label 条（收起态；source 定样式：error 红 / event 中性 / 其他按 label 文案）+
点击展开正文（固定高度容器 max-height ~40vh + overflow-y 滚动）。透明度保留：
用户看得见 Agent 加载了什么。无 label 行按 source 缺省文案回落。

## 4. 版本升级数据迁移机制（裁决 #4）

- **位置**：boot.ts（运行锁后、行装载前）——迁移是顺序敏感的启动逻辑，行激活
  序（PENDING 等依赖）无法保证先于 session 首写；故非行、非服务。
- **形态**：新纯库 ac-migration-core（迁移注册表 + 执行器：按序应用 / 幂等 /
  断点续跑）+ boot.ts 调用段。
- **版本标记**：`data/meta.json` `{ dataVersion }`（首启从 .initialized 推断 v0）。
- **v1 迁移集**（同 pass，每文件读一次写一次）：
  - **M-role-v2**：messages.jsonl 逐行 `event → context+source:event`、
    `error → context+source:error`；
  - **M-subcall**：主文件 `"subcall":true` 的 tool-result 行剥离 → 同目录
    subcalls.jsonl（行序保持、seq 目标文件末行续起）——4116723a（09-17）落主
    文件的存量，写侧双文件分流（09-20）后的迁移补课。
- **安全网**：迁移前经 ac-backup-core 纯库直调打快照（backup 行此时尚未激活，
  owning 行的 core 独立可用——首次实战）。
- **失败语义**：任一迁移失败 = 拒绝启动（EXIT_CONFIG 同款出口）；meta.json
  原子写，每迁移完成即落版本。
- **红线声明**：append-only 会话历史可被「版本升级迁移」重写——显式例外，仅此
  一条通道；迁移前快照强制，不可跳过。

## 5. 行为变更清单（显式签收）

1. 手势 mid-run steer 进来的消息不再被服务（判定收窄为 run 触发消息；边缘场景
   由下轮 run 或技能菜单补）
2. 手势未命中（技能尚不存在）不再补偿（一次性判定；旧「不销账保留中途创建技能
   被拾起」语义退役）
3. 手势跨 run 重新服务 → 一次性服务（去重依据 = 历史 context 行在场）
4. error 行读者无关 → hint 视点过滤（共享桶对端不再看到 b 的 run 错误）
5. load_skill 返回值瘦身：content 删除（SkillLoadOutput 契约变更；消费面查证：
   仅 webui 工具标签取 name 渲染，无 content 依赖）
6. read 回落：程序内分析 SKILL.md 改走 read（baseDir 在返回值）

## 6. 改动面

| 域 | 改动 |
|---|---|
| ac-migration-core（新纯库） | 执行器 + M-role-v2 + M-subcall |
| ac-app/boot.ts | 迁移调用段（锁后装载前，失败拒启） |
| ac-session | context 词汇五处（KNOWN_ROLES / projectRecord / record extra / UI project / journal+hint 过滤）+ 写入点三处改写 + S3 golden 更新 |
| ac-skill | 手势 before-run 化（单次判定 + 双写）+ load_skill 轻量化 + 载入登记与收束落账 + 去重 |
| ac-run-code | DEFAULT_GUIDANCE「取摘要」教条修正（技能正文例外已由注入机制消解） |
| webui / ui-conversation | label 条渲染（三形态 + 展开容器） |
| 测试 | 迁移幂等/断点、词汇投影、注入三通道、手势语义翻转改写（skill.test.ts 728 行等） |

## 6. 插入切分（变体乙，2026-09-18 追加裁决）

首轮实现把 context 行挂 reply-completed（收束后落账）——实测落盘序
`[user, run行, context]`：注入体被推到终稿后，跨轮 KV 断层 + 时间线倒置。
变体甲（纯 steps 内嵌）丢 durable（steer 挂内存，进程死即丢——违背
2026-09-18 send_agent 教训）；**变体乙 = 写侧 run 切分**：

- 插入消息（steer / 技能 context）到达**消费点**时：当前进度落「关闭行」
  （携带切分前全部步〔含纯文本步〕，吸收既有 partial）→ 插入行落此位 →
  余下步走新铸 run 键（收束行 steps 按切分偏移切片）。
- 落盘自然顺序 = 回放顺序；读侧零新逻辑（partial 吸收机制既有）。
- steer 时序修正：LLM 流期间到达的 steer 实际进队在步 N 后——投递时挂
  stash、步边界消费（loop/step-started 对象身份匹配）才切分落账；未消费
  的 steer 随 loop steerQueue 语义一起丢（模型没见过就不算会话事实）。
- 技能 context 落账挪到 before-step 注入时刻（recordContext split:true）
  ——落位 = 正文进入消息数组的位置；pending 指纹变化才落新行。
- 切分后旧 run 走同款 vacuum（partial 死重物理剔除）。

## 7. partials 摘除（2026-09-20 三文件裁决）

变体乙首版实测暴露三缺陷：① 关闭行 result:null 终值丢失（vacuum 按「收束行
带全量结果」旧假设删了补行，切分 run 不成立）；② 关闭行落盘时点无法保证工具
完成；③ timestamp 同毫秒归位歧义。解法 = **partials.jsonl 摘除**（subcalls
同款三文件分工）：

- **messages.jsonl** = 会话定稿流（header/user/agent/context/关闭行/收束行，
  append-only，零死重）；
- **partials.jsonl** = run 中间态（partial 步行 + 直调补行）——**不进清理面**
  （关闭行 result:null 恒需补行覆盖，读侧 supplements 合并），终值档案如实保留；
- **subcalls.jsonl** = run_code 子调用档案（既有）。

配套裁决：
- **vacuum 整个退役**（主文件零死重，无清理对象——少一个原子重写路径）；
- **补行 run 键归属**：activeRuns.pendingCalls（切分前未完结调用 id → 关闭行
  run 键，完结摘除）——补行覆盖关闭行的对账键修正；
- **echoSeq 归位锚**：partial 行落盘时快照主文件队列序，读侧合并按「主文件
  seq >= echoSeq 首行之前」归位（run 锚优先——同 run 的关闭/收束行前；
  无锚〔run 未收束〕走 echoSeq）；同毫秒 timestamp 歧义免疫；
- **覆盖面扩展**：补行覆盖从 partial 行扩到关闭行（切分 steps 的 result:null）；
- **迁移 v1 扩**：M-partials-split（主文件 partial 行 + 直调补行 → partials.jsonl）。

## 8. 不做与遗留

- 信封 source（LoopSource 'user'|'agent'|'event'）不动——运行时拓扑，与存储
  source 同词不同义，按所在对象区分。
- subagent 会话桶内的注入同 run_code 通道（会话隔离天然覆盖，无额外改动）。
- source 供给侧细分（timer/job/goal-round 真语义标注）不预铺——消费者出生再扩。
- 跨 run 同名技能重复落账的去重由「历史 context 行在场跳过」规则覆盖（§1）。
