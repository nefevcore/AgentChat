# 变更登记目录（CR log）

> 一切变更（含日常 bugfix）动手前**先在此追加一行**，再动代码。
> 规约背景见 `epoch-marking-convention.md`（cr-1 起 CR 制度建立）。

## 登记格式

```
【cr-序号 yyyy-mm-dd 一句话描述】
```

- cr 号为正整数、单调递增、永不复用（不固定位数，前导零禁止）；日期 = 登记当日真实日期。
- 描述一句话说清改了什么；细节写对应设计文档或 CHANGELOG，目录行保持一行。
- 一次会话内的一组关联小改可合并为一条 CR。

## 目录

- 【cr-1 2026-09-27 日期语义重定义：批次代号退役、存量月份标记 blame 分层还原为真实日期（史前/不可考 → `-00`）、外部归档目录改名、规约重写并建立 CR 登记】
- 【cr-2 2026-09-27 cr 号位数约定修订：三位改「正整数单调递增、不固定位数、前导零禁止」】
- 【cr-3 2026-09-27 CR 目录自 epoch-marking-convention.md §三迁出为独立文件 cr-log.md】
- 【cr-4 2026-09-27 记忆时间线与群聊转录流重构：记忆桶寻址改 Agent 人格单时间线（timeline.md + checkpoint/delta 注入协议 + memory_write/memory_grep 工具）+ 群聊派生视图改成员私有转录流；memoryOwner 全链与派生窗全族退役（计划 src/docs/memory-timeline-plan.md）；追加裁决：迁移前置检查 infra 等价授予——有存量记忆的 infra Agent 自动补 memory 标签（一次性，预设豁免）；条目 log 形态前缀 [date] 由工具铸造 + [tags] 段为正文通道（tags 参数移除）；memory_write 增 date 参数（事实发生日回填）；迁移提示词改指路形态（不内嵌旧桶，Agent 自读 ./memory 整理）]
- 【cr-5 2026-09-27 PTC 程序化失效事故：根因 = DeepSeek 越面结构化幻觉直调（推理端不校验 tool_calls 函数名，editor~user 750K 经典直调历史浸泡下模型无视 run_code 单 schema 请求面、模仿历史直调面外工具；执行面无请求面闸门致全部放行——llm-req/resp 两侧探针实锤）。修复 = loop 请求面硬闸：request.tools 已定义时面外调用不执行、回填「面内可用工具 + 程序化正确入口」引导纠错（模型 ReAct 自愈回落 run_code）；request.tools 未定义不判定。诊断探针六处全部移除，闸门落 src/ac-agent-loop/service.ts 执行点（原探针③位置），单测锁定】
- 【cr-6 2026-09-27 fix(preview): 文件预览双滚动条——body/code-wrap 嵌套 overflow:auto 收归 body 单滚动容器（面板与 Modal 双形态）；markdown/html 预览 iframe 补 display:block 消 inline 基线底隙（~7px descender 撑出 body 纵向溢出 = 双滚动条第二根因）】
- 【cr-7 2026-09-28 dev:demo（boot-yml-main.ts）数据根无条件锚定 workspace/test（同 smoke.ts 语义）：脚本曾尊重宿主继承的 AGENTCHAT_DATA_ROOT，e2e 段把 helper~user 演示会话写进真实数据根（2026-09-15 污染实例）；同步清理真实根内测试残留（helper~user 会话、pending-a~a~a、空 files 桶）】
- 【cr-8 2026-09-27 patch 层加固方案立项（src/docs/patch-layer-hardening-plan.md）：setPatchEntry 改 AST 保注释编辑（yaml@^2，findLast 对齐 include last-wins，损坏文件 throw）+ setPatch 前置装配树校验（未知 id fail-loud 不落盘）；裁决不采纳 DSH overridden 四态/统一锁域/Agent 启停工具入口三项】
- 【cr-9 2026-10-09 browser eval 序列化语义优化（run_code 编排实测复盘驱动）：eval 返回未调用 function（IIFE 漏写括号）/未 await 的 Promise 从静默 {} 改为带修复指引的明确报错；eval 结果保留 JSON 类型（数字/布尔/对象直出，去字符串化）；wait 动作内部 Promise 改经 evalExpr awaitPromise 通道；工具 description 补各动作返回字段契约；run_code 失败时 log 末尾行并进 error 诊断】
- 【cr-10 2026-09-28 run_code 输出预算缺省 32KB→64KB：全量实战复盘定标（489 会话 19008 次落地调用，截断率 0.5% 且 75% 走 return 通道；超限 p50≈45.8K、64K 档消除 71% 事件，正常返回 93%<16K 故提额不伤常态；触发后 30% 被残留数据吞噬、68% 被迫改分段读多烧一轮）。tool.ts DEFAULTS 与 index.ts 行配置缺省/工具参数描述同步】
- 【cr-11 2026-09-28 patch 层加固实施（cr-8 方案落地）：setPatchEntry 改 eemeli/yaml AST 编辑（保注释/保条目序/新条目 flow 风格；findLast 对齐 include last-wins；损坏文件 throw 拒绝覆盖）+ setPatch 前置装配树校验（include 在位且 id 不在 enumerateDisablableEntryIds → throw 不落盘，对齐 DSH 先校验再落盘；落地核对保留为兜底）】
