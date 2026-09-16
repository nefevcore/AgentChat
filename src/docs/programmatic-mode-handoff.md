# 程序化模式（run_code / PTC）实施交接单

> 2026-09-16 收口。本会话完成了研究、前置修复与两轮命名裁决；**P0 实施未开始**。下一 session 从本单开始。
> 主报告：`coding-mode-preset-research.md`（v5.2，实施设计要点在 §六/开放问题在 §八）。

## 一、下一 session 怎么开始

直接对新 session 说（或粘贴）：

> 读 `src/docs/programmatic-mode-handoff.md`，然后按其中的 P0 范围开实施计划。

实施前有 4 个开放问题需要你先裁决（报告 §八，裁决改变数据形状，别等实现完再改）：

1. **run_code 结果入会话步记录吗？** 建议：入摘要 + 程序体哈希，不入全程序体（大返回值经 ac-session 回放会长期占上下文，把省下的 token 吃回去）。
2. **code-exec 与 shell 的信任关系**：等同（DSH 口径，程序可跑任意 bash）还是分层（投影面裁剪）？影响预设默认 tags。
3. **PTC vs subagent 分工**写进指引：确定性编排→run_code / 探索性研究→subagent（建议直接采纳）。
4. **并存形态的投影边界**：todo/goal/ask_questions 这些框架协作工具进不进 SDK 投影？

## 二、P0 范围（三件套 + 随行）

```
⑥ run_code 工具行 + SDK 投影纯库（报告 §六.1/2/3，八条设计要点全文在 §六）
⑦ 预设数据行 __programmatic__（ac-agent-presets-builtin 注册；
   include: ['run_code', 'tag:fs', 'tag:shell', 'tag:infra', …]；
   description 首句：「以代码编排成批工具调用，大幅降低 token 消耗」）
随行：code-exec 新标签预注册（tag-registry RESERVED + §七守则的运行期展开集成测试）
```

新能力域 checklist 走框架开发技能（load_skill agentchat-framework-dev）：契约 → 事件（若需要）→ 服务/纯库 → cordis.yml + ac-app TREE 双表 → 测试 → README。

## 三、本会话沉淀（已合入工作树，未提交）

**研究链**（全在 src/docs/）：
- `coding-mode-preset-research.md` v5.2——程序化模式主报告（PTC 对照、架构分析、八条落地要点、四开放问题、版本沿革含两轮命名裁决）
- `tag-system-report.md`——标签系统事实源（词表/三层机制/单源纪律/防漂移守则/演进时间线）
- `tags-include-semantics-report.md`——门禁体系重构根因分析（历史档案）

**代码改动**（均验证过：typecheck ✅ + 相关域测试全绿）：
- `ac-agent-loop/src/service.ts`——abort 归因修复：signal 已中止的抛错 → finish:'interrupted' 而非 error（steer.test.ts 有锁定用例；run_code 的中断语义 §六.7 依赖此修复）
- `ac-agents/src/service.ts`——resolveToolNames 增 onEmptyTagExpand + onUnknownLiteral 双告警回调；UNIVERSAL_TAGS 导出（自动补齐迁移已移除，存档注释在）
- `ac-router/src/service.ts`——两处落空告警接线（logger.warn）
- `ac-agent-admin/src/service.ts`——新建且未传 tags 时补基础族（创建面缺省，非迁移）
- `ac-security/src/index.ts`——能力轴注释更新（base = 默认开放锚点，与 capabilitySetOf 单源对齐）
- `src/README.md`——tag 引用节补落空可观测 + 「tags 即工具面」出厂限定语
- 测试：steer/resolve/migrate-hooks/agent-store/agents-dir/builtin 更新
- 顺手修：TREE 双表顺序漂移（ui-plugin-registry/ui-desktop-storage）、portb-e2e 期望清单补 ui-desktop-storage

**全量测试注意**：全仓并发跑有 flaky（perf 基准超时、import 挤压——v0.8.8 CI 有同款前科）；按域单跑稳定。验收以受影响域 + typecheck 为准，全量失败先单跑复现再归因。

## 四、实施时最容易踩的坑（研究阶段结论）

1. **SDK 投影源 = resolveToolNames 解析后的生效工具集**（与 loop 送 LLM 同入参），不要用 capabilitySetOf 独立重算——否则互斥形态下投影面与 include 白名单漂移。
2. **并发分类按工具粒度不按标签粒度**：fs 标签里 glob/grep 是只读；串行名单引用 ac-security 的 WRITE_PATH_TOOLS/COMMAND_TOOLS 单源，别建第二份词表。
3. **投影排除 run_code 自身**（防递归）；子 Agent 派生身份继承 code-exec（STRIPPED_TAGS 只有 delegation/admin），但子 Agent 的投影同样要排除 run_code。
4. **投影快照按 run 生成、不跨 run 缓存**（工具行装卸/HMR 窗口 + KV cache 前缀污染）。
5. **审批等待与预算**：needPermission 子调用会阻塞等用户批准——maxWallMs 给余量或审批时间不计入 computeMs。
6. **预设 tag: 引用要运行期集成测试**：boot 全树 → resolve 程序化预设 include → 断言每个 tag: 展开非空（静态断言抓不住空展开；tag:fs 事故的教训）。
7. **worker 是 containment 不是 boundary**（DSH 口径）——安全靠桥接层逐调用走 `ctx.tools.execute`（能力轴+档位+黑名单+扫描全自动生效），worker 只做资源约束（computeMs/maxWallMs/maxOutputBytes + unref）。
8. **指引双版本**（§六.8）：互斥形态注入程序书写纪律（可擦除 TS/只读并行写串行/预算/返回值压缩）；并存形态额外注入选择策略（预期 >3 步确定性序列优先 run_code）。

## 五、相关索引

| 要点 | 位置 |
|---|---|
| 八条设计要点全文 | coding-mode-preset-research.md §六 |
| PTC 三家对照表 | 同上 §二 |
| 模式 vs 常驻工具四理由 | 同上 §三（能力轴切档：tags 管解锁 include 管收面） |
| code-exec 新建词流程 | tag-system-report.md §七（预注册 + 运行期测试） |
| 中断语义修复背景 | 同上 §九 / research §九 |
