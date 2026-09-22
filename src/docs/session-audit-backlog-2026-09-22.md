# 审查报告：src/ac-session/src/index.ts（v0.8.10..HEAD）

> **三轮处置（2026-09-22 审查会话·v0.8.10 后全仓精简轮，双子 Agent + 主会话自营）**：
> 审查面扩大到未提交工作区（67 文件，subagent 三文件化/skill 驻留注入/
> ask-questions 三态分流/file-snapshots 配置化等）。ac-subagent/service.ts 落地 12 项：
> journalStepOf↔toStepRecord 并源（resultOf 投影参数）；journal 身份键四处模板
> 并源 journalIdentityOf（对齐 ac-session 先例）；pendingSups.kind 死字段删；
> stopRun reason 参数保留（字面量赋值会窄化 abortReason 联合类型致 eslint
> 误报 timeout 比较恒 false——异步写点流分析不可见，判例：**判别字段赋值
> 勿内联字面量**）；earlyCheck list 兜底死分支删；error settle 字面量并源
> failRun 局部函数；historyRecords 双 JSDoc 收敛；ensureMessages 重复注释
> 收敛；readJournal「内存优先」注释矛盾修正（实现是盘上优先、内存补 append
> 失败窗口）；972/1253 等 6 处 no-unnecessary-condition 冗余防御写法清零
> （全仓 lint 0 错）。spawn 父守卫与 resolveModel 的同文案双守卫判合法
> （fail-closed 冗余）。subagentBoard/board.ts、file-snapshots 配置化、
> skill 驻留注入、ask-questions 三态分流核对无违规。
> 遗留新增（同日四轮·迁移链专项，双子 Agent 行审 + 主会话核实落地）：
> **run-code interrupt flaky 根修**——非测试问题而是产品 bug：signal 在
> addEventListener 注册前已 abort（worker boot 慢/并行负载）时监听永不
> 触发、中止静默丢失。修复 = 先判后听（signal.aborted 当场走同一处置）。
> 同款 flaky：singles-ask-questions-refresh 339 行（后端重启后 singles 扫描
> 未完成即 restore → 列表缺行 + restoreLastSingle 落空误清 lastContext 的
> 副作用使重试不成立）——测试改「先轮询列表到位再 restore」。
> **迁移链四项行为修复**（子 Agent 报告问题 1/2/3/4，全部主会话核实）：
> ① migrateSessionDir 顺序反转（先 append 目标文件后改写主文件）+ 按行
> 身份去重幂等（injectSubcalls 对重複 subcall 行不去重——重複 = 双卡）+
> 尾行 
 防护（对齐 repairTail）——原「先改写后 append」崩溃窗口丢行且
> 重跑早退永不补写（三计数归零）；② 迁移快照移 backups/migrations/
> 专用目录（keep=Infinity，隔离常规轮转 BACKUP_KEEP=4——持续失败重启
> 第 5 次起会吞掉迁移前快照）；③ 未来版本告警（dataVersion > 已知最大
> 迁移版本时 warn——降级读新数据不再无声）；④ migrateSubagentsDir 判据
> dir 存在 → messages.jsonl 在场 + 残留旧单文件收尾删除（messagesPath
> 读侧恒优先旧单文件，残留 = dir 弃用双份漂移）。补崩溃窗口回归测试
> ×3（append 先行重跑不重複/尾行不拼行/v3 残留收尾）。
> 遗留未动（低优先）：loadRegistry 不归一旧字段（透传下游，风险下推）；
> 备份文件名秒级戳同秒覆盖；迁移核注释失真（.initialized 推断 v0 描述
> 与实现不符——行为等价）。

> **处置状态（2026-09-22 精简会话）**：二（injectCount）已删；四（void at 死计算）已删；
> 五（settlement 管道）已并源至 settleRun；六（身份键三份）已并源至 journalIdentityOf；
> 九（tmp 命名）已对齐 pid+ts；七/十一（分类与谓词并源——纯重构，热路径宜带基准）遗留。

> **二轮处置（2026-09-22 审计会话·本文件同日二刷，双子 Agent + 主会话自营）**：
> 八（recoverJournal 缺 partial 守卫）——**行为修复落地**：settled 收集补 `mr.partial !== true`，
> 红测试置换（journal-recover.test.ts 第 4 用例「partial 回声行不算 settled」，首跑经历假绿
> 事故：测试 JSON 漏闭括号使坏行被跳过、settled 空、走孤儿分支恰好过断言——教训：行为测试
> 必须钉住「文件终态」而非仅 records() 形态）。
> 十（steer-dropped 缺 meta 门控）——**行为修复落地**：补 isArchiveReviewRun/isGroupHint 门控，
> 红绿测试置换（steer-dropped-gate.test.ts 三用例：群 hint / archive / 普通用户对照）。
> 三（run-settled seq 写而不读）——维持观察裁决不变。

## 二轮其余处置（死代码/重复/膨胀，均经全仓 grep 求证后落地）

- D1 死方法 journalInject 已删；D2 record() 死参 partial/target 已删（读侧兼容保留）；
  D3 rewriteJournal/settleTail 死形参 run 已删；D4 step-started 死下标 i 已删；
  D5 ChatInput.domValue + PromptEditor.getText 暴露已删；D6 historyApi ridBase 死回落已删；
  D7 recordContext 退役参数 split 两侧（session+skill）已删。
- O1 settleRun/enqueueSettlement state 形参收窄为 { run }；I3 void text 已删。
- M1 run-code resolveWorkerEntry 孤儿导出已删；M2 skill listeners 虚报 steer-dropped 条目已删；
  M3 注释掉的旧 enterFreeze 块已删；M5 shell-tools 命令不存在正则并源 MISSING_COMMAND_RE；
  M6 worker isFnForm 正则并源 isFnFormSrc；M9 720s 定标注释收敛为 DEFAULTS 指针。
- M10（skill 非全局正则只取首个 skill_content）**行为修复落地**：两处改 matchAll
  （recordedSkillContexts / skillNamesOf——多技能行跨 run 去重漏判根修）。
- M11（subagent error 收束行 role 口径分裂）**行为修复落地**：对齐主会话 D12/F7
  （role:context + source:error）；顺带修复「无 journal 错误收束完全不落 error 行」的更深缺陷
  （journaled=false 且 error 时静默）；红绿测试置换（subagent.integration.test.ts 新用例）。
- I1 JSDoc 块内空行噪音已清（session 56 处 / skill 8 处）。

## 遗留（下轮输入）

- R1 records() 主文件行三份同构扫描（settledRuns / anchorIdx / merged 重组）——热路径，
  并源宜带基准测试先行。
- R2 readJournalRun 与 recoverJournal 的分类三分支并源（同上，含前缀谓词 vs JSON 两套判定法）。
- M4 subagent journal 切段逻辑三份同构（settleRun / recoverJournal / readJournalLive flushSeg）
  + 补行覆盖循环三处——抽 journalSegments()/applySupOverrides() 共用，宜带基准。
- M7 shell executor finish() 两分支对象字面量 90% 相同——单出口重构，宜与 shell 集成测试同批。
- M8 残余：skill 语句间空行（141 处新增）保留未清——格式重构收益低于风险，建议 prettier
  引入时一次性处理（含 chat-core.ts 的 CRLF→LF 归一提交卫生问题）。
- R4 recordContext 两分支同参 emit 未合并（微重复，随 R1 顺手）。

## 事故记录（本轮自查）

- 「read 工具大文件截断 → write 回写」链路曾把 session/index.ts 截断至半文（61KB/128KB）。
  恢复路径：git checkout HEAD + 选择性应用破损前 diff 的前 28 hunk + 手工重放尾部修改
  （B1/B2/injectionId 贯通/O1/D3/journalIdentityOf），全程以 typecheck+98 测试绿灯收束。
  教训：>100KB 文件的「读-改-写」禁用 read+write 工具组合，改用 pwsh 原生或分页处理。

---

（以下为一轮报告原文，历史留档）
