# user 域账本对称化设计（user-domain-ledger-plan）

> 性质：实施计划——agent→user 投递的落账契约重构：出站行退役、user 桩成 user 域唯一写者、读面全走读时投影并读。
> 状态：已实施 · cr-1344 2026-11-26（cr-1343 计划——批次 A-D 全落；实施批注见 §五批次表，待验证目标全达后归档）。
> 读者：实施者（动 user-stub / messaging-tools deliver / fold / singles-row / 迁移脚本的人）——动手前先加载 agentchat-dev 技能。

## 一、背景与论证链（2026-11-26 会话裁决）

### 1.1 现状（不对称）

send_agent(user) 投递的消息落 **sender 的 agent 域账本**（deliverRow 出站行，
ac-shell-conversation/src/service.ts deliver 跨壳分支 L497-509：agent_id=sender、
delivered:true、无 run 键）——写给 user 的行住在 sender 域里。

现状的辩护链（cr-973 时代）：user 无进程 → 无写者 → 出站行由 sender 壳代写。该链条的
隐含假设「user 侧无执行体」不成立——**user-stub 驻宿主进程、本来就是 user 端点的收信执行体**
（apps/host/user-stub.ts receive：非回信信封已消费直播帧 + 未读）。

### 1.2 用户裁决的两原则（本次重构的依据）

1. **单写者**：消息发给 user → 由 user（桩）写入自己的账本。每域恰好一个写者，
   单写者原则不但没破，比现状更对称（现状是「我写你的行」= 域与归属错位）。
2. **读时投影**：viewer 可视面从多个账本合成。conversationDirs（ac-ledger manage.ts）
   本就全 agent 域扫描并读——user 域挂真实目录后**零改动**即被所有读面并读。

### 1.3 sender 工作记忆的承载实证（「出站回执保留」方案否决）

曾担心 user 域方案让 sender 回放丢失「我发过什么」。实测（官方 foldSession + foldLlmReplay，
与 live 同一函数）否决该担心——tool-call 对已完整承载：

| 承载形态 | 内容 | 会话实证 |
|---|---|---|
| tool role 消息（subcall 结果行） | 回执 JSON「已投递给 user…」+ arguments 全文 | seq 918 等 4 行 |
| tool_calls 内嵌 | run_code arguments 全文（含 send_agent 调用代码与正文） | 多条轨迹消息 |
| ReAct 协议结构 | 模型发起调用时参数必在上下文（直调形态 assistant tool_calls + tool result 原生消息对） | 恒成立 |

结论：**sender 出站行退役，无需轻量回执替代**——tool 对是比出站行更结构化的工作记忆
（带调用语境与回执结果）。IM 白名单批风险 #4 的裁决随之翻转。

## 二、终态规格

### 2.1 落账契约

| 事件 | 写者 | 落点 | 行形态 |
|---|---|---|---|
| agent→user 投递（send_agent / user 直答终稿 postReply） | user 桩（宿主进程） | agents/user/sessions/<uuid>/messages.jsonl | 入站行同构：role agent、agent_id=sender、delivered true、requestId 锚 |
| user→agent 发言 | 壳（现状不变） | agents/<agent>/sessions/<uuid>/ | 入站行 agent_id=user（现状不变） |
| agent→agent 委托 | 壳（现状不变） | 双方域各持投影（现状不变） | 不涉 |

### 2.2 读面（并读验证点）

| 读面 | 现状 | 期望 |
|---|---|---|
| conversationDirs | 全 agent 域扫描 | 自动带上 user 域（零改动） |
| projectUserReplay | 并读 + 双谓词（user 行 / peer 行） | **非零改动**：user 域行的 agent_id=sender≠domain——两个谓词都不命中 → 需新谓词分支（唯一确定的读面改动，实施时核） |
| fold im 白名单（cr-1332/1334） | delivered===true 或 role===user 直取 | user 域行 role=agent + delivered ✓ 值直取（零改动） |
| foldLlmReplay（sender 视角） | agentDirOf 单域读——不读 user 域 | 不读 user 域（语义正确：那是 user 的事实的家；sender 靠 tool 对记忆） |
| 前端 IM 直播帧 | user-stub 收信即广播（cr-1144） | 落账点换位置，帧路径不动 |
| 未读轴 | host-web bumpUnread（unreadAxisKeyOf 按 uuid 键） | 落账点换位置，轴键计算不动 |

### 2.3 退役面

- ac-shell-conversation deliver 跨壳分支的 deliverRow 出站行（agent→user 方向）——整个退役；
  agent→agent 出站行不涉（双方域投影是另一语义，本批不动）。
- cr-1332 白名单批位置 B（出站行打标）随之退役；风险 #4 裁决翻转记录于本档 §一-1.3。
- im-delivered-flag-handoff.md §2.1 表的 agent→user 行改指 user 域入站行。

## 三、护栏（不做清单）

- 不动 agent→agent 双域投影（现状语义正确，本批边界 = agent→user 单向）。
- 不动 user→agent 入站行（写者 = 壳，现状正确）。
- 不做 user 域的全功能化（无 LLM 无 run——它只是收信账本，不是计算实体）。
- 存量出站行迁移 = 一次性脚本（幂等重跑），不做双读长期过渡（宁一次性清，不留两态）。

## 四、风险与开放项

| # | 项 | 说明 |
|---|---|---|
| 1 | projectUserReplay 谓词 | user 域行的 agent_id 是 sender ≠ domain——现有两谓词（user 行 agent_id=user / peer 行 agent_id===domain）都不命中 user 域的行 → 实施时加第三谓词或归一。**唯一确定的非零改动读面** |
| 2 | singles-row 域扫描 | agents/user/sessions/<uuid> 会被 singles 扫描扫到（uuid 形键）——确认注册表/指纹逻辑对 user 域无特判冲突 |
| 3 | 直播帧时序 | user-stub receive 现状先广播后（隐式）无 durable——落账成为收信步骤后，帧与 durable 的顺序需定（建议：先 durable 后广播，与壳侧入站语义对齐） |
| 4 | postReply 终稿回信（agent→user 方向） | 终稿信封也是 agent→user 投递——同批迁移 or 分批？建议同批（同一路径语义） |
| 5 | 跨进程崩溃窗 | user 桩落账在宿主进程（重启丢内存）——落账原子性靠 ledger writer 既有纪律（临时文件 + rename），崩溃窗与壳侧同语义 |

## 五、分批切分（实施批）

| 批 | 内容 | 验证 |
|---|---|---|
| A | user-stub 落账 + 出站行退役（写面两刀）+ postReply runMs 透传 + foldUserReplay 谓词第三分支（user 域行优先） | ☑ ledger/conv/webui 326 例 + e2e-user 7 例：user 域入站行在场（delivered/run/runMs）、sender 域出站行零新增、im 白名单 agent 回复从 user 域行取（fold.test 锚） |
| B | 读面三处确认（projectUserReplay 谓词 ☑并源 foldUserReplay / im 白名单 ☑ / singles 扫描 ☑零改动——键形锁 + 同 id 不扩集合 / session-index ☑零改动——镜像近似既有语义）+ face-ops 两刀（owningAgentOf / replayTokensOf 排 user 域） | ☑ 三包 277 例；真机走查（cr-1344 运行时验证，2026-11-26 23:48–23:55）：IM 视图两条 `send_agent(user)` 消息在场（落 user 域）、agent 域零出站行新增、未读 RPC 与 UI 徽章正常（轴键计算未改）；宿主侧 fold 投影新代码生效（agent 域无该行而 IM 仍可见 = 唯一读者是 user 域） |
| C | 存量迁移脚本 + 归档/管理面对账 | ☑ `scripts/migrate-outbound-user-rows.mjs` 幂等空转验证；dev 数据根 24 行迁毕（备份 sandbox/backup-outbound-migrate-20261126-234046）；迁移后 mathematician~user IM 43 行零丢失（15 agent 投递全在场） |
| D | 文档收口（im-delivered-flag-handoff §2.1/§2.2 / dual-view 状态板 #6 / 本档状态行 / singles-row 头注） | ☑ |

顺序：A → B → C → D（B 依赖 A 的写面新形态；C 依赖 B 验证读面）。持久化链路变更——
验证阶梯按 agentchat-dev 全档 + pnpm test:integration。

## 六、本批论证的证据锚（2026-11-26 会话实测）

- 出站行形态与归属：本会话 messages.jsonl seq 613（agent_id=__creator__、delivered:true、无 run 键）
- tool 对三重承载实证：foldLlmReplay 投影「行集装配验证」tool role=2 / tool_calls 内嵌=3；「cr-1342 改名完成验证」2/4
- user 域零 sessions 目录（现状）：agents/user/ 仅身份文件
- conversationDirs 全域扫描：packages/ac-ledger/src/manage.ts L26-41
- user-stub 收信执行体：apps/host/user-stub.ts receive（直播帧 + 未读已消费）
- 前序裁决翻转：im-delivered-flag-handoff.md 风险 #4（出站行打标 → 退役）
