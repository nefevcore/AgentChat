# 标签体系 × tools.include 语义分析——程序化模式实施前的裁决报告

> 2026-09-16 · 由「极简模式为什么用 tag:shell」的追问触发，延伸至工具门禁体系的结构性核查，面向准备实施的程序化模式（run_code / PTC，见 coding-mode-preset-research.md v3.1——已归档 `Dev\Note\AgentChat\docs-stale-2026-12\src-docs\`）。
> 结论先行：**当前门禁体系的根本缺陷是"无 requiredTags = 恒可见"的默认开放设计，而非 base 隐形注入；程序化模式的 P0 预设方案（`include: ['run_code', 'tag:fs', …]`）在当前标签体系下会静默失效，必须在实施前补齐 fs 标签族或改用显式点名**。

## 一、现状事实（全量核查结果）

### 1.1 门禁声明面（requiredTags 全集）

| 工具 | requiredTags | 注册行 |
|---|---|---|
| pwsh / bash | `['shell']` | ac-shell-tools |
| str_replace_editor | `['fs_minimal']` | ac-str-replace-editor |
| web_search / browser | `['web']` / `['web','observe']` | ac-web-tools |
| subagent | `['delegation']` | ac-subagent |
| adt_*（32 个） | `['sap-adt']` | ac-sap-adt |
| read_logs / reload / reload_modules | `['dev']` | ac-dev-tools |
| system_restart / register_plugin / unregister_plugin / install_plugin | `['admin']` | ac-restart / ac-plugin-registry |
| **其余 ~17 个工具** | **无 requiredTags** | — |

无门禁工具清单：read / write / edit / glob / grep / math / job / hello / send_agent / send_group / list_agents / list_groups / list_tools / read_agent_info / update_agent_profile / ask_questions / timer / goal / todo / load_skill / read_history / grep_history。

### 1.2 能力集合成（base 注入点，两处单源对齐）

```ts
// ac-agents/src/service.ts capabilitySetOf（可见面过滤单源）
const caps = new Set<string>(['base']);        // ← 隐形注入
caps.add(`agent:${agentId}`);
for (const t of agent?.tags ?? []) caps.add(t);

// ac-security/src/index.ts 执行门禁（同款合成）
const caps = new Set<string>(['base', ...(agent?.tags ?? [])]);
```

### 1.3 tag:base 是幽灵标签

全仓 **没有任何工具声明 `requiredTags: ['base']`**。base 被注入进每个能力集，但从不匹配任何门禁。真正让 read/write/edit 全量进门的是 `toolAllowedFor` 的第一行短路：

```ts
if (!def?.requiredTags || def.requiredTags.length === 0) return true;  // 无门禁 = 恒可见
```

`base` 的全部现实存在感：tag-registry 目录描述（"隐式注入，无需也不能手动声明"）、UI 的隐式固定徽章、旧标签 'agent' 的归一化目标（useAgentSettings.ts:175）。

### 1.4 tools.include 语义（git 史核查）

include **从首版起就是白名单选取**（M15 收编，commit 422ea9a）：`const base = include ?? all`——include 一给，工具面即收窄为 include 展开集。src 旧轨同语义平移，无中途漂移。"允许注入 tag 外单个工具"的追加语义在代码史上不存在，属记忆偏差——但这个偏差反复出现本身说明双轴语义（tags 解锁 vs include 选取）的心智负担是真实痛点。

## 二、根因分析

### 2.1 三个候选根因的裁决

| 候选 | 裁决 | 依据 |
|---|---|---对话记录截断——此行不完整，实际内容为：|---|
| A. base 隐形注入 | **不成立**（是果非因） | 即使显式化，base 依然不匹配任何门禁——17 个无门禁工具的进门机制是 `toolAllowedFor` 短路，与 base 无关 |
| B. 无 requiredTags = 恒可见（默认开放） | **成立**（结构性根因） | tags 收不窄 read/write/edit/math/...——"tags = 工具面"的心智模型在实现上不成立，全靠 include 白名单兜底收窄 |
| C. include 白名单语义本身 | 部分成立（放大器） | 白名单 + 平台相关工具名（pwsh/bash）的组合在工具拆分后才显形矛盾，tag: 引用是补丁式解法 |

### 2.2 病灶的准确描述

门禁体系有三层，各自独立演化，心智模型却假装它们是一层：

```
第一层（注册）   requiredTags 声明——但 60% 工具没声明，"默认开放"
第二层（合成）   capabilitySetOf：base 幽灵标签 + agent:<id> + tags
第三层（解析）   resolveToolNames：include 白名单选取（tags 不参与选取）
```

用户配置时以为写 tags 就是在圈工具面；实际上 tags 只是钥匙圈，工具面是"没上锁的门全部 + 钥匙能开的锁"。要精确控制工具面必须 include 白名单逐一点名——而点名平台相关工具名（bash/pwsh）又踩平台坑，于是需要 tag: 引用——而 tag: 引用依赖 requiredTags 声明密度，声明稀疏（fs 族全部无声明）导致 `tag:fs` 这类引用**静默展开为空**。

## 三、对程序化模式的直接冲击（P0 阻塞项）

研究文档 §四 P0 方案原文：**预设数据行 `__programmatic__`——互斥形态：include run_code + 文件族 tag 引用**（§五.2 同款：`tools: { include: ['run_code', 'tag:fs', …] }`）。

### 3.1 tag:fs 在当前注册面下静默展开为空

实证（模拟 resolveToolNames 展开）：`fs` 标签**不存在**——read/write/edit/glob/grep 全部无 requiredTags，str_replace_editor 挂的是 `fs_minimal`。若按 P0 方案直接落地：

```
include: ['run_code', 'tag:fs', 'tag:shell', …]
                ↓ resolveToolNames
生效面: ['run_code', 'pwsh', …]     ← fs 族全灭，无报错、无警告
```

程序化模式的核心场景就是文件密集操作（一段程序串 read→edit→read 循环）。fs 族静默缺失 = 模式落地即残废，且失败模式是"静默"的——预设测试若只断言 run_code 在场，这个坑测试也抓不住（tag: 展开是运行期行为，静态断言看不到）。

### 3.2 SDK 投影同源风险（§五.2 连带）

SDK 投影纯库的可见工具过滤"`ctx.tools.list()` 过滤出调用方能力集可见的工具"同样依赖 requiredTags 密度：无门禁工具恒可见（对投影是正确行为），但**互斥形态的投影面与 include 白名单的一致性**没有机制保证——include 收窄了模型可见的工具 schema，投影若仍按 capabilitySetOf 全量生成声明，两者漂移。

### 3.3 平台相关工具名进 include 的老问题重现

互斥形态若要点名命令工具：`'bash'` 在 Windows 落空、`'pwsh'` 在 Unix 落空。本轮已为极简模式建立的物化层占位解析（`tag:shell` → 当平台字面名）是现成解法，程序化模式预设直接复用即可——但**占位词表目前只有 `tag:shell` 一条**，若程序化模式需要 `tag:fs` 类占位，需同步扩表。

## 四、选项与建议

### 4.1 三个修复层次（按侵入度递增）

**L1 · 预设层显式点名（零体系改动，纯数据）**

程序化模式 include 不用 tag:fs 引用，直接写全工具名：

```ts
tools: { include: ['run_code', 'read', 'write', 'edit', 'glob', 'grep', 'str_replace_editor', 'tag:shell'] }
```

- 优点：立即落地、无迁移、平台问题沿用占位解析
- 缺点：工具增删不自动跟随（未来新 fs 工具不进模式）；与 ABAP 预设"只写 tags 不写 tools"的形态美学不一致
- 适用：P0 抢跑可接受；但治标

**L2 · 补齐 fs 标签族（动注册面，小改动）**

read/write/edit/glob/grep 补 `requiredTags: ['fs']`（新标签），str_replace_editor 保留 fs_minimal 或并入 fs：

- 优点：`tag:fs` 引用成立，研究文档 P0 方案原样可落；fs 工具增删自动跟随；顺带修复"tags 收不窄 fs 工具"的心智模型裂缝（fs 挡住了，但 math/hello 等仍默认开放——需要裁决这些要不要标签化）
- 缺点：**存量 Agent 兼容**——无 'fs' 标签的存量 Agent 会瞬间失去 read/write（门禁从"无锁"变"有锁"）。需配套迁移：预设 tags 补 'fs'（标准/极简/ABAP 都要）、存量盘上数据迁移、内置 user/admin 实体
- 改动面：5 个工具注册处 + 3 个预设 + agent-store 迁移 + tag-registry 目录 + UI 徽章 + 测试，估 ~15 文件
- 风险点：迁移兜底必须覆盖"盘上已有实体 skip-if-present 优先于预设物化"的路径（ac-agent-presets 注册逻辑：实体已存在时物化跳过——存量用户实体的 tags 不会被预设新 tags 修正）

**L3 · 体系性收口（"tags 即工具面"）**

无门禁工具全部标签化（math→'math'、协作族→'collab' 或逐个标签、基础设施工具裁决"默认人人有"还是"显式授权"）：

- 这是上一轮"base 显式化"讨论的路 B 完全体
- 优点：心智模型彻底干净，程序化模式的投影/白名单/解锁三面在 tags 一根轴上对齐
- 缺点：破坏性变更 + 全量迁移 + 基础设施工具（ask_questions/todo/goal）的"一切 Agent 可用"设计意图被推翻，需产品层重新裁决
- 建议：**不随 P0 走**。等程序化模式落地取得实战反馈后，作为独立提案处理

### 4.2 建议

**P0 随程序化模式实施走 L2**（补 fs 标签族），理由：

1. 研究文档 P0 方案（`tag:fs` 引用）依赖它，不补则方案文字与实现脱节，落地者要么踩静默失效坑、要么临场改方案
2. fs 标签族是三个标签需求（fs/collab/math）中唯一被 P0 方案直接依赖的，最小充分
3. 迁移面可控（3 个出厂预设 + 存量实体迁移一条龙），且能顺带建立"新增标签族的迁移 runbook"（程序化模式后续若需 collab/math 标签照此办理）

### 4.3 偿债路线图（2026-09-16 追问链收口：不处理的恶化曲线与分阶段还本）

**技术债的三条恶化曲线**（§二病灶不处理的后果）：

1. 每个新工具面对不一致先例（60% 无门禁 / 40% 有），声明密度随机游走，`tag:` 引用可用性跟着漂移
2. 每个新预设重踩同样的坑（极简踩了平台名、程序化 P0 正在踩 tag:fs 空展开）——运行期静默失效，测试抓不住
3. 程序化模式引入第三个对齐面（SDK 投影 vs include 白名单 vs requiredTags 门禁），三层漂移空间翻倍

**架构根源**：requiredTags 承担双职责——门禁（AND 匹配）与分组（tag: 引用展开）。fs 争议的僵局 = 想要分组但不想要门禁，两职责压在一个字段上不可分离。阶段 1 选择统一职责（挂标签 + 迁移）而非分离职责（新增 group 元数据），因为 tag-registry/UI 已把 requiredTags 事实性地当能力目录用，双词汇体系成本更高。

**三阶段路线图**（成本递增，可停在任一阶段）：

| 阶段 | 内容 | 成本 | 性质 |
|---|---|---|---|
| **0 防恶化**（立即） | ① `toolAllowedFor` 把无 requiredTags 显式等价为 `['base']` 门禁（caps 恒含 base，行为逐字节不变——契约从"默认开放"变"base 解锁"，幽灵标签变真锚点）② `resolveToolNames` 的 `tag:` 引用空展开告警（静默落空 → 响）③ tag-registry 描述与 README 注记同步 | ~半天，零风险 | 还利息 |
| **1 还本**（随 P0） | fs 标签族：read/write/edit/glob/grep 挂 `requiredTags: ['fs']` + 存量迁移。**迁移基础设施已存在**（ac-agent-store migrate-hooks：'agent'→'base'、'conductor'→'delegation' 归一化先例），补"tags 加 'fs'"一条即可。盲区：skip-if-present（实体已存在时预设物化跳过——迁移必须直接扫实体，不能依赖预设物化路径） | ~2-3 天 | 还本金 |
| **2 终态**（实战反馈后，独立提案） | base 可摘除化：capabilitySetOf 恒注入移除、'base' 变普通标签、新建 Agent 出厂默认带 base → **"tags = 工具面"完全成立**，include 退役为例外点名，`tag:` 引用必要性大降。预标两坑：① 无身份宿主直调 `caps={'base'}` 特例保留与否 ② ask_questions/todo 基础设施工具挂 'infra' 恒注入还是接受可收窄（产品裁决） | 破坏性变更 | 重构 |

**阶段 2 不一步到位的理由**：其正当性依赖未验证前提——"tags 即工具面"是否用户真想要的。程序化模式落地后 include/tag: 引用/投影三面的实战反馈会给出答案：若实践中只写 tags，阶段 2 顺势而为；若 include 被证明有独立价值（例外工具点名场景常见），阶段 2 形态需重新设计。**用阶段 1 的实战数据支撑阶段 2 裁决，比现在赌一把便宜。**

**随行项**（不阻塞 P0，但同批值得做）：

- resolveToolNames 对 `tag:` 引用展开为空时**告警**（运行期 logger.warn——点名了不存在的标签，静默落空违反 fail-fast，这正是本次追问链条里反复踩的坑）
- 物化层占位词表从单条 `tag:shell` 扩展为可配置词表，程序化模式预设数据保持平台无关
- README 工具门禁节补"三层结构与心智模型"注记（本报告 §二.2 的内容），防止后续贡献者再踩

## 五、附录：核查方法与证据锚点

- requiredTags 全集：`Get-ChildItem src -Recurse | Select-String 'requiredTags: \['`（生产代码 13 处声明，测试/模板另计）
- include 首版语义：`git show 422ea9a:preview/ac-agents/src/service.ts`（M15 收编时 `const base = include ?? all`）
- tag:fs 空展开实证：模拟 byTag 构建脚本（2026-09-16 运行于本仓 HEAD）
- base 无消费方：全仓扫 `'base'` 生产引用仅 2 处注入点 + tag-registry 目录描述 + UI 归一化
- 程序化模式方案：coding-mode-preset-research.md v3.1（§三 能力轴第三条路、§四 P0 缺口表、§五.2 SDK 投影；已归档 `Dev\Note\AgentChat\docs-stale-2026-12\src-docs\`）
