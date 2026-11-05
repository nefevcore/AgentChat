// 目标读者：实现本方案的人/Agent。事实源：本文件 + packages/ac-agent-loop/src/sections.ts。
// 迁移完成后本文件转为裁决存档（历史裁决不是待办）。

# system prompt 去中心化（cr-881，2026-11-03）

> 用户裁决（2026-11-03 会话）：① override 语义废弃；② 专业客观 → 新包 ac-conduct；
> ③ 产出物引用 → 新包 ac-artifacts；④ 块序无需语义排序（注册序），但随后升级为：
> 学习 dsh 引入显式有序机制；⑤ settings['system-prompt'] 域废弃，存量转写 AGENTS.md；
> ⑥ 章节标题（## 系统环境 等）随拆散退役。

## 1. 机制：PromptSection 注册制（dsh 适配版）

- 新契约住 `packages/ac-agent-loop/src/sections.ts`（ owning 包 = 组装方 ac-agent-loop）：
  - `SectionContribution { name, order, text }`——name 唯一（同层重复注册抛错）；
    text 为静态串或 per-run provider `(req) => string`，空串不贡献。
  - `SECTION_ORDER` 具名分配表（数值单源在本包，贡献方不写裸数字）；
    `sectionOrder(name)` 解析，未知名抛错。
  - 组装在 `run()` 入口（原三档 seam 位置）：`assembleSystemPrompt(ctx, req)`，
    按 (order, name) 升序 join，`request.system` 初始值作 order -1 前缀段。
  - 注册 API：`ctx.??` —— 见 sections.ts 实际导出（registry 住 agent-loop 服务实例，
    与 agentLoop 同 fiber 归属）。
- KV cache：静态段低 order、会话动态段高 order 收尾，排序确定性 = 字节确定性。
- 不引入的 dsh 部分：complete 排他段（= override，已废弃）、{{variable}} 插值、
  PromptContext 快照化、tool schema 组装（走 ctx.tools，正交）。

## 2. 三层 seam 退役分析（cr-881 裁决）

| 档位 | 住户 | 处置 |
|---|---|---|
| before-run-first | 零住户（对称预留词汇） | 删除事件 |
| before-run-last | 对话信息块 + 日期行 | 迁 section（CONVERSATION/DATETIME 两档）后删除事件 |
| before-run（主档） | 混合 | **保留但改义**：通用 run 边界拦截（veto/预算/messages 改写/懒准备），不再承载提示词装配语义 |

随之拆除的收敛式 hack：尾档 prepend/push 收敛、persona 头部前置、
ac-skill [引用约定] 词形锚点插入（insertSkillsBlock）。

## 3. 段位分配表（SECTION_ORDER 真源，见 sections.ts）

| 具名 | 段 | 贡献方 |
|---|---|---|
| CALLER | request.system 初始值前缀 | 调用方 |
| PERSONA | <persona> 块 | ac-persona |
| MEMORY | 记忆静态指引 | ac-memory |
| SKILLS | <available_skills> | ac-skill |
| REFERENCE_FS | [引用约定] @路径 | ac-fs-tools |
| REFERENCE_AGENT | @名称引用 | ac-collab-tools |
| REFERENCE_SESSION | #会话引用（会话标题锚点教学） | 归 read_history/grep_history 工具描述自带——无独立注入段，位保留给未来 owner |
| PTC_SDK | run_code SDK 投影段 | ac-run-code |
| ENV_WORKDIR / ENV_HOST / ENV_MODEL | [工作目录]/[宿主环境]/[模型能力] | ac-workspace / ac-shell-tools / ac-agent-loop（ENV_MODEL——ac-llm inject 会与 agent-loop inject ['llm'] 成环；visionOf use-time 软取） |
| TERMINOLOGY | 术语约定 | ac-collab-tools |
| GROUP_CONTRACT | 群聊行为契约（群名 + 回复走 send_group；会话动态） | ac-collab-tools |
| GUIDELINES_FS / SHELL / JOBS / WEB / ARTIFACTS / COLLAB / TIMER / ASK / SUBAGENT / GOAL / TODO / ISSUE | 指引条目 | ac-fs-tools / ac-shell-tools（SHELL+JOBS——jobs 指引主体是后台命令生命周期，job 工具是 shell 伴生面）/ ac-web-tools / ac-artifacts / ac-collab-tools / **TIMER 遗留**（见 §6）/ ac-ask-questions / ac-shell-subagent / ac-goal / ac-todo / ac-issue-tools |
| CONDUCT | 专业客观 | ac-conduct |
| CONVERSATION | 对话信息块 | ac-conversation |
| DATETIME | 日期行（绝对收尾） | ac-datetime |

## 4. 归属与废弃明细

- settings['system-prompt'] 域整体废弃（enabled/guidelines/systemEnv/conversationPartner/
  override）。存量差异层转写各 Agent AGENTS.md（人设层承载）。
- 术语约定块随协作指引并入 ac-collab-tools（形态门控：非 singles）。
- ac-system-prompt 包退役：row-catalog 摘行；其测试随段迁散或删除。
- 章节标题（## 系统环境 / ## 指引 / ## 术语约定 / ## 对话信息）退役，行级标签自足。

## 6. 遗留项

- **GUIDELINES_TIMER（主动安排）**：宿主 timers 行不能注册（agentLoop 住壳进程——宿主行集
  无 agent-loop 行，inject 即 PENDING；跨进程注册到不了壳 prompt；且出厂壳无 timer 工具注册面，
  cr-883 同因回退）。指引暂时退役（timer 工具描述已载 action=set 语义），待 shell 侧 timer 工具
  行落地时由其 owner 注册。

## 5. 实施与验证

顺序：契约层 → 尾档住户 → 主档 prompt 住户 → 环境块 → 指引条目 → 新包 →
对话信息块 → ac-system-prompt 退役 → preview 适配 → 测试。
验证：pnpm typecheck && pnpm test:unit && pnpm check:deps + 动行集 pnpm test 全量 +
迁移前后 system 全文快照 diff（允许差异：章节标题退役、段间分隔统一）。