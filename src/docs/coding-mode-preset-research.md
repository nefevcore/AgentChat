# 程序化模式（run_code / PTC）预设研究 v5.2

> 状态：研究报告（2026-09-16，v5.2——全量标签化已落地 + 前置修复合入：①基础族自动补齐迁移**整体移除**（终态裁决：tags 完全以用户/预设配置为准，仅留 agent-admin 新建缺省；存量由用户手工补）②字面名落空告警（resolveToolNames onUnknownLiteral + router 接线）③README「tags 即工具面」出厂限定语 + 落空可观测注记。技术债清理随批完成，P0 三件套可直接开工）。
> 命名终裁（v3.1）：**程序化模式**；曾评估「高效模式」被否（质量阶梯/机制不可见/速度误导/命名空间占用）。效率主张放 description 首句：「以代码编排成批工具调用，大幅降低 token 消耗」。
> 调研对象：DSH（DeepSeek Harness）PTC 模式、Anthropic《Code execution with MCP》、Cloudflare Code Mode、LangChain deepagents/quickjs，及传统派（Claude Code / Codex CLI / Gemini CLI / Aider / OpenCode / Amp）。
> 结论先行：**程序化模式 = 「模型以代码为行动媒介」的执行形态。定义性构件是 run_code（Programmatic Tool Calling，PTC）：模型写一段 TypeScript 程序组合多步工具操作，只有最终返回值回上下文。门禁前置项已随全量标签化（2026-09-16）落地——tags 从此即工具面，P0 只剩 run_code 三件套。**

## 一、范式：两种「编程模式」的辨析（v2 结论维持）

业界「编程模式」一词横跨两种本质不同的东西：

| | A. 写代码的 Agent（coding agent） | B. 用代码行动的 Agent（code as action） |
|---|---|---|
| 内核 | 文件编辑工具集 + 审批/沙箱 | run_code：模型编写程序编排工具调用 |
| 代表 | Claude Code、Codex CLI、Aider、Cursor | DSH PTC 模式、Cloudflare Code Mode、Anthropic code execution with MCP、LangChain quickjs |
| 调用面 | 逐轮 JSON tool_call（N 轮往返） | 一次程序生成（控制流进代码） |
| 「编程」指 | 用户的项目代码 | 模型自己写的 TS 程序 |

v1 报告的盲区：只按 A 轴对照，漏了 B 轴。预设应覆盖 B 轴为定义性内核——A 轴素材（文件工具族）在标准模式已齐备，预设真正改变的是执行形态。

### PTC 解决什么

传统 N 轮往返的五项成本（DSH/CSDN 分析共识）：上下文重复膨胀（工具 schema + 中间结果逐轮回喂）、决策延迟（每步等模型）、中间结果占用、跨步状态恢复难、错误传播。

```
传统：模型 → read(a) → 结果回模型 → read(b) → 结果回模型 → … → 终答
PTC： 模型 → run_code(一段 TS 程序)
        ├─ const a = await tools.read({file_path:'a'})
        ├─ const b = await tools.read({file_path:'b'})
        ├─ if (a.includes('x')) …            // 循环/条件/try-catch
        ├─ const [m,n] = await Promise.all(…) // 只读并行
        └─ return 压缩结论                    // 中间结果不回模型
```

Anthropic 实测：Drive→Salesforce 链路 ~150k → ~2k token（98.7%）；社区实现普遍报 37%~88% 降幅。附加收益：执行计划一次可见（可调试性）、原生控制流、程序可沉淀为可复用 skills。

## 二、PTC 系实现对照（内核构件拆解）

| 构件 | DSH PTC | Anthropic CE-MCP | LangChain quickjs | AgentChat 落位 |
|---|---|---|---|---|
| 模型看到的入口 | 单一 `run_code` 工具 | 生成的 `.ts` API 文件按需 import | REPL `tools.camelCase(...)` | run_code 工具行（新） |
| SDK 投影 | 注册表→类型化 `tools.name(args)` | 每个 MCP 工具一个 TS 包装文件 | 工具集→REPL 命名空间（排除自身防递归） | **纯库**：以生效工具集为源 → 声明文件（§六.2） |
| 隔离运行时 | Node worker thread | 沙箱（未给参考实现） | QuickJS（浏览器级隔离） | worker_threads + 类型擦除加载 |
| 预算 | computeMs / maxWallMs / maxOutputBytes | — | REPL 超时 | 三件套照搬 + unref |
| 并发纪律 | 只读可 Promise.all，写类按提交序串行 | — | — | 桥接层按工具元数据分类 |
| 子调用校验 | 宿主桥接逐调用复检（双重校验） | — | **绕过 per-invocation 审批钩子（已知的坑）** | 走 `ctx.tools.execute` → 全安全面自动复用 |
| 安全姿态 | worker = containment 非 boundary，权限等同 bash | 需要安全沙箱 | QuickJS 强隔离但丢审批 | 桥接复检为主，worker 只做资源约束 |
| **激活形态** | **模式级互斥**（四预设之一） | 范式建议（无参考实现） | 常驻 middleware（与工具并存） | **tags 管解锁 + include 管收面，归 Agent 配置层裁决**（§三） |

**AgentChat 的结构性优势**：quickjs 的审批绕过坑在 AgentChat 不存在——桥接层每个子调用走 `ctx.tools.execute`，则能力轴（requiredTags AND）、档位门禁（needPermission × tier）、双黑名单、bash 扫描、`tool/before-execute`/`after-execute` 事件**全部自动生效**。这正是 PTC 文献强调的「双重校验」宿主侧，AgentChat 已有现成机制，只差接线。

## 三、为什么各家用「模式」而非常驻工具（v3 结论，v5 按新门禁校准）

四个结构性理由：

1. **工具面互斥是收益前提，不是副作用。** PTC 的 token 收益两大块：①中间结果不回模型；②工具 schema 不逐个暴露——run_code + SDK 投影**替代** N 个工具的 schema，而非叠加。若并存，模型每次决策都要掂量「这步用 read 还是写进程序」，schema 照付、相互干扰。**互斥才换来省。**
2. **信任档位完全不同。** 传统工具 = 一次调用一次审批的细粒度信任；run_code = 一段程序一揽子授权的粗粒度信任（DSH 口径：程序权限等同 bash）。两档信任不宜让模型在同一会话自由选用——只能由用户预先选。
3. **系统提示词整套换血。** 逐工具操作纪律要换成程序书写纪律（可擦除 TS 语法、只读并行/写串行、预算、返回值压缩）。两套指引并存互相污染。
4. **模型适配非全量覆盖。** PTC 对模型能力有要求（多步规划进一段代码、类型化 API 调用），做成模式让用户按模型/任务选。

「模式」形态的真实代价：模式内无退路（简单任务也得写程序）；能力孤岛（框架协作工具进不进投影，各家没理顺）。

**AgentChat 的第三条路（v5 校准——全量标签化后语义更干净）**：run_code 注册 `requiredTags: ['code-exec']`，两形态归 Agent 配置层：

- **并存形态**：Agent tags 声明 `code-exec` → run_code 可见，与传统工具共存，模型按指引自选执行形态。
- **互斥形态**：程序化模式预设 `tools: { include: ['run_code', 'tag:fs', 'tag:shell', …] }` 收窄工具面。
- 全量标签化后「tags 即工具面」**名副其实**：tags 同时管解锁（能力轴）与收面（include 的 tag: 引用展开）——v4 时代「tags 只能加门不能收面」的结构缺陷已消除，第三条路的两形态都只剩纯配置声明。

代价照旧：并存形态下模型可能「该写程序时逐个调工具」，指引需明确选择策略（预期 >3 步确定性序列优先 run_code）。

## 四、门禁体系现实（v5 改写：全量标签化已落地）

> v4 本章描述的「三层拼合 + 默认开放」结构性缺陷，已于 2026-09-16 全量标签化修复（工作树待提交）。完整证据链见 `tags-include-semantics-report.md`；本节记录**落地后的事实**与对程序化模式的直接影响。

### 4.1 落地事实

**标签族全量覆盖**（一切出厂工具挂具体标签，无门禁工具清零）：

| 标签族 | 工具 | 备注 |
|---|---|---|
| `fs` | read / write / edit / glob / grep | v4 P0 前置项，已补 |
| `collab` | send_agent / send_group / list_agents / list_groups / read_agent_info / update_agent_profile | list_tools 挂 infra 不挂 collab（单 Agent 也要自省） |
| `infra` | ask_questions / goal / todo / timer / math / hello / read_history / grep_history / list_tools | 会话基础设施 |
| `shell` | pwsh / bash / job | **平台拆分**：Windows→pwsh（Unix→PS fail-closed 翻译），Unix→bash（纯透传）；job 是命令工具的后台伴生面 |
| 既有 | fs_minimal / web / delegation / dev / admin / sap-adt | str_replace_editor 保留 fs_minimal（极简插件包独立门禁词，未并入 fs） |

**配套机制**：
- **存量迁移**：~~normalizeUniversalTags 读边界归一~~——**已移除**（2026-09-16 终态裁决）：tags 完全以用户/预设配置为准，存量无三族标签的 Agent 用户手工补；agent-admin 新建且未传 tags 时有创建面缺省（UNIVERSAL_TAGS）。
- **tag: 空展开告警**：`resolveToolNames` 增 `onEmptyTagExpand` 回调（fail-fast——v4 指出的 tag:fs 静默失效形态从机制上根绝）。
- **占位解析**：物化层 `tag:shell` → 按宿主平台解析为字面名（pwsh/bash），预设数据保持平台无关；占位在本层消化不进 AgentConfig。
- **tag-registry**：base 退役（幽灵标签消失），预注册 fs/collab/infra + 档位词。
- **出厂预设 tags 更新**：标准 = fs/collab/infra/shell/web/delegation；极简 = fs/shell/infra/fs_minimal（include str_replace_editor + tag:shell）。

### 4.2 对程序化模式的直接收益

1. **P0 前置项完成**：`include: ['run_code', 'tag:fs', 'tag:shell', …]` 的每个 tag: 引用都有注册面支撑，空展开告警兜底。
2. **预设数据形态纯净化**：不用 L1 显式点名回退，tag: 引用自动跟随工具增删（未来新 fs 工具自动进模式）。
3. **子 Agent 派生身份**（同批落地，超出 v4 预期）：spawn 时 `ctx.agents.register` 派生条目 = 父身份编辑（preset:true 隐藏 + tags 剥 delegation/admin）——v4 §九「附带发现①」的合成身份静默落空问题根治。对 PTC 的意义：**父 Agent 有 code-exec → 子 Agent 继承 code-exec**（STRIPPED_TAGS 只有 delegation/admin），run_code 可在子 Agent 会话内用；递归防护仍靠投影排除 run_code 自身（§六.5），不依赖标签剥减。
4. **subagent timeout 缺省 300s → 不限**：研究型长任务不再被默认看门狗截断（v4 §九的事故形态之一从缺省面消除；timeout_s 正值仍可设）。

### 4.3 残余事项（不阻塞 P0）

- str_replace_editor 未并入 fs——程序化预设若要含它需点名或 `tag:fs_minimal`（词已存在，无机制障碍）；
- 占位词表目前单条 `tag:shell`（物化层硬编码）——程序化模式 include 的其余 tag: 引用（fs/infra/…）全平台同名无需占位，**无需扩表**；
- README「三层结构与心智模型」注记随标签化重写（工作树已含）。

## 五、操作面与约束面（v5 修订）

**操作面（被 run_code 程序编排的素材）**——已齐备且已标签化：
- fs 族（read/write/edit/glob/grep）、shell 族（pwsh/bash/job）、str_replace_editor、math、web_search/browser、ask_questions、todo、subagent、goal——全部有 requiredTags，投影分类与 tag: 引用都有词表支撑

**约束面（决定 run_code 能开多大）**——已齐备：
- requiredTags 能力轴 + 三档 access-tier + 询问提权 + 双黑名单 + bash 扫描 + 脱敏
- run_code 的 `code-exec` 新标签注册即可用（tag-registry 目录自动采集——requiredTags 路径无需手工声明），与 shell 区分（可独立授权/吊销），档位随父 Agent

**外围增强（非定义性）**——缺口清单 v5 修订：

| 缺口 | 对照 | 优先级 | v5 备注 |
|---|---|---|---|
| **run_code 工具行 + SDK 投影纯库** | DSH PTC / CE-MCP | **P0** | 投影与白名单同源（§六.2）；前置项全清 |
| 预设数据行 `__programmatic__` | DSH 四预设 | **P0（同批）** | tag:fs/tag:shell 引用直接可用 |
| 钩子面（编辑后 lint/format 回喂） | CC PostToolUse / Aider auto-lint | P1 | PTC 子调用照样触发 after-execute |
| 工作区记忆文件（AGENT.md） | CLAUDE.md/AGENTS.md 事实标准 | P2 | |
| fileSnapshots.restore | Cursor checkpoint / Aider undo | P2.5 | run_code 程序自身可写恢复逻辑，UI 一键恢复仍值得 |
| git 只读工具 + 审批写 | Aider auto-commit | P3 | run_code 里可串 git 命令 |
| plan mode | CC/Codex/Gemini 全有 | P3 | |

## 六、run_code 落地设计要点（v5 修订）

1. **形状**：单工具 `run_code`（requiredTags: `['code-exec']`），入参 = 程序体（仅可擦除 TS 语法）+ 可选预算覆盖；出参 = 最终返回值（maxOutputBytes 截断）+ 执行摘要（子调用计数/耗时/被拒清单）。
2. **SDK 投影纯库**（同源纪律）：投影源 = **resolveToolNames 解析后的实际生效工具集**（与 loop 送入 LLM 的 `normalizeToolSpecs(list(), request.tools)` 同一入参），不是 capabilitySetOf 独立重算——否则互斥形态下投影面与白名单漂移。生成 `declare const tools: { read(args): Promise<…>, … }` + `@param` 文档；worker 内实现 = 桥接层 proxy；排除 run_code 自身（防递归）。
3. **桥接层**：子调用一律 `ctx.tools.execute({name, args, agentId, conversationId, toolCallId, signal, elevation})`——执行身份随程序出生时快照；needPermission 工具询问提权时 await 阻塞在程序内（maxWallMs 给审批留余量或审批时间不计入 computeMs）。
4. **并发纪律**：写路径类 ∪ 命令类串行（提交序），其余可 Promise.all（上限 5，对齐 loop mapLimit）。分类词表与 ac-security 的 `WRITE_PATH_TOOLS`/`COMMAND_TOOLS` 单源；标签化后可增补 fs/shell 标签判据（fs 族工具 = 写串行候选——但注意 glob/grep 是读，**按工具粒度而非标签粒度**分类，标签只是索引辅助）。
5. **递归防护**：投影排除 run_code 自身；subagent/job 等编排工具按 requiredTags 由能力轴自然拦截或显式排除。子 Agent 派生身份继承 code-exec（§四.2.3）——run_code 可在子 Agent 用，但子 Agent 的投影同样排除 run_code 自身（程序内不能再 spawn run_code 程序）。
6. **KV cache**：SDK 声明块进系统提示 = 前缀稳定（工具集不变则字节不变，M2a 语义）。
7. **中断语义**：`call.signal` 直达 worker（`parentPort.postMessage` + worker 内 AbortController）；工具边界语义与本轮修复的 abort 归因一致（interrupted 而非 error，§九）。
8. **指引双版本**：互斥形态注入程序书写纪律；并存形态额外注入执行形态选择策略（预期 >3 步确定性序列优先 run_code）。
9. **预设数据形态**（v5 简化）：`include: ['run_code', 'tag:fs', 'tag:shell', 'tag:infra', …]`——tag: 引用全部有注册面支撑（§四.1）；str_replace_editor 点名或 `tag:fs_minimal`；L1 显式点名回退形态不再需要。

## 七、实施路线（v5 重排）

```
✅ 已完成（2026-09-16 全量标签化，工作树待提交）：
  ① fs 标签族 + collab/infra 全量标签化（超出 v4 的 L2 预期，直达 L3）
  ② tag: 空展开告警（onEmptyTagExpand）+ 字面名落空告警（onUnknownLiteral）
  ③ 物化层 tag:shell 占位解析（配套 pwsh/bash 平台拆分）
  ④ 存量迁移——终态裁决：不做自动补齐（曾实现后移除）；用户手工改 + 告警兜底；agent-admin 新建缺省保留
  ⑤ 子 Agent 派生注册身份（合成身份静默落空根治）+ timeout 缺省不限

P0（前置项已全清，可直接开工）：
  ⑥ run_code 工具行 + SDK 投影纯库（§六.1/2/3）
  ⑦ 预设数据行 __programmatic__（tag: 引用 + description 效率首句）
P1 钩子行（编辑后 lint/format 回喂，消费 tool/after-execute）
P2 工作区记忆文件（AGENT.md）｜P2.5 fileSnapshots.restore
P3 git 工具 / plan mode
```

## 八、开放问题（v6 修订：剩三条 + 一条已裁决转实施）

1. run_code 结果是否入会话步记录——建议入摘要+程序体哈希，不入全程序体。
2. `code-exec` 与 shell 的信任关系：等同（DSH 口径）还是分层（投影面裁剪）？影响预设默认 tags。
3. PTC 与 subagent 分工：确定性编排 → run_code；探索性研究 → subagent——建议写进指引。
4. ~~并存形态的工具面边界~~（已随六次实测收敛 + 开关化裁决解决，见 §十）。

## 十、开关化裁决（v6 · 2026-09-17 终裁：程序化 = 会话级开关，非预设）

> **✅ 已实施（2026-09-17 同日晚）**——a-g 全落地：预设退役（preset.ts 删除 + reserved 双表 + 组合根/cordis.yml/yml 去行）+ conv-settings programmatic 键（wire 'true'/null，持久真 boolean）+ router execute 开关收窄（run_code 不在生效面 warn 忽略）+ prompt.ts 形态判定改读 run 级 request.tools 终值 ∩ 复算面（开关收窄不落 Agent 配置——按 Agent tools 复算看不见开关）+ ChatInput「工具使用模式」dd + presetRetired 防御。验证：ac-run-code 44 / ac-router 25（含开关收窄三用例）/ conv-settings 5 / reserved-consistency / web-api 71 / portb-e2e 全绿，typecheck 双 0 错，smoke 冒烟过（tools=(1/67)）。细节见 `run-code-handoff.md` §四.0。

> 三个半月实测（六次真模型会话）后的形态终裁。起点：用户观察「程序化模式更像是另一个维度的模式，而不是和标准模式极简模式这样的预设，更像是一个开关，开启后，会话的工具集全部进入 SDK 投影」。

**裁决内容**：程序化是**工具暴露形态**的运行时选择，不是 Agent 身份。预设回答「Agent 是谁」（人设/工具授予/模型），开关回答「工具如何暴露给 LLM」（逐个 schema vs 单 SDK 入口）——两个维度正交。

**论据**（按决定性排序）：

1. **架构早已在暗示**：`resolveEffectiveTools` 的 scope 双口径（`'llm'` vs `'projection'`）意味着每次 run 本来就同时计算两张脸，预设只是「挑哪张给 LLM 看」的物化形态。开关把这个已存在的维度显式化。
2. **弱模型退路直接消灭**：计划文档 §十一预案的「预设拆两个（互斥 + lite 并存，用户按模型选）」——开关化后退路 = 关掉开关。零新增预设。
3. **预设列表回归语义纯净**：`__programmatic__` 从预设目录退役；列表只剩人设语义（标准/极简/…）。
4. **并存形态不是第三态**：「Agent 有 code-exec、run_code 与传统工具并列可见」= 开关关闭时的自然状态——两态设计完整覆盖，无需三态。

**状态与注入点**（实施映射，零件已就位大半）：

| 层 | 落点 |
|---|---|
| 存储 | `conv-settings`（既有会话级覆盖域）加 `programmatic?: boolean`——与 model/elevation 同域同语义（按 conversationId 寻址、逐键覆盖） |
| LLM 面收窄 | router `execute` 的工具面合成（capabilitySetOf → resolveToolNames → 形态面终滤，service.ts:200-224）之后、`agentLoop.run` 之前：`programmatic=true` 时 `tools = ['run_code']`（过形态面终滤同口径；run_code 不可见时 warn 一次并忽略开关——无 code-exec 标签的 Agent 开关惰性） |
| 投影注入 | `prompt.ts` injectProjection **零改动**——它按「run_code 是否在 LLM 面」触发，收窄后自然触发互斥形态分支 |
| 授权 | code-exec 标签不动——标签管授权（能不能用），开关管暴露形态（怎么给 LLM 看） |
| lib 临时库 | 零改动（闭包注入与形态无关） |

**UI 形态**（用户终裁）：输入框工具栏的一个**工具使用模式选择器**（与模型选择/思考强度/快捷提权同族的 dd 下拉）——标准 / 程序化两档；选择即写 conv-settings，随会话持久。位置语义正确：它改变的是「这条会话怎么干活」，正是输入框工具栏的语义域。

**中会话切换语义**：允许，run 间隙生效（不在 run 中途翻转）；切换 = 系统提示词投影块出现/消失 = KV 前缀失效点，与 Agent 切换同款处理——不特殊化。

**迁移与防御**（用户终裁的两项）：

1. **`__programmatic__` 预设整体移除**（preset.ts 子行退役 + reserved 双表 + 组合根两行 + portb-e2e 期望）。三次实测会话（4cd1a90d/a7828839/0d55714a）以该预设身份运行——移除后续聊将 404/落空。
2. **前端防御性检测**：单会话 `session.agentId === '__programmatic__'` 且预设目录（agents/presets RPC）不含该 id 时 → 输入框禁用 + 明确提示「程序化模式预设已退役，请开新会话并用输入框模式选择器开启程序化」——禁止对无预设会话续聊（历史只读保留）。

**保留观察项**：开关 on 时子调用直播事件的前端形态（待办 1 附带项）在该 UI 下更值得实测——直播期 N 张子调用卡 vs 收束后单卡的跳变。

> **续修（2026-09-17 同日，用户口径：「会话 1 选了程序化，新会话 2 也默认程序化」）**——开关化的缺口补完：开关此前**只落当前会话**（conv-settings 逐会话寻址），新会话恒回落标准形态；`composePrefs.programmatic` 虽记「上次选择」却**只当 UI 初值**（挂载即被会话存储校准覆盖），从未真正生效——用户口径下这是 bug 而非设计。
>
> **改法（客户端侧，后端零改动）**：① ChatInput 挂载/会话切换回读 conv-settings——有显式 `programmatic` 键 = 存储为准；**无键 = 新会话跟随上次选择**：回放组合偏好并写该会话 conv-settings（程序化必须落存储才生效——router 收窄读的是它；标准态 = 缺省不写）；无 code-exec 授权（禁选）不写，防「勾了不生效」假象。② 新件 `ac-client-ui-conversation/client/toolModeInherit.ts`（模块级单例，与 draftParking 同款——ChatInput 随视角切换重挂载）+ `chat-core.deliver` 投递前 await 该继承写：新会话**首条消息**不抢在继承写之前出门（挂载瞬发的竞态窗口）。
>
> **语义坐标**：与 elevation「持续武装」同族（用户不必每次重设），落点不同——elevation 走 deliver 信封逐条透传，programmatic 只能经会话 conv-settings（router 收窄在服务端读）。显式键 = 会话权威态：在某个会话里选回标准（写 null）后，该会话保持标准；「跟随」只发生在**无键**会话（新会话/1v1 缺省）。不做服务端全局默认（config 域）——那时的落点会是「用户设置」，与「跟随上次选择」是另一条需求，未采纳。

（v4 第 5 条——L2 迁移裁决与 L3 立项——已随全量标签化落地解决，移除。）

## 九、支线修复记录（v5 更新状态）

调研途中 subagent spawn 300s 无返回，诊断出 **ac-agent-loop abort 归因 bug**（已修复）：

- 现象：看门狗超时 abort 落在 LLM 请求中段时，`agentLoop.run` 把 fetch AbortError 无差别归 `finish:'error'`，ac-subagent 据此错报终态。
- 修复：`execute()` catch 分支增加 `request.signal?.aborted` → `finish:'interrupted'` + `interruptReason{type:'user-abort'}`（`src/ac-agent-loop/src/service.ts`）。
- 回归：`steer.test.ts` 新增用例锁定；相关域 166 测全绿，typecheck 通过。
- 附带发现①（子 Agent 合成身份能力集仅 base，spawn 传带门禁工具静默落空）——**已随派生注册身份修复**（§四.2.3）。
- 附带发现②（mock provider 不接 signal 时 abort 被无视）——真实 provider 已透传，非框架问题，维持记录。
- timeout 缺省 300s（本次事故的触发面）——**缺省已改为不限**（研究型长任务语义）。

---

### 附：文档版本沿革

- v1（2026-09-16 早）：传统 coding agent 对照视角（A 轴），缺口 = 钩子面/项目记忆/回滚/git/plan mode + 预设数据。
- v2（2026-09-16）：定调修正——run_code（PTC）为定义性内核，B 轴补全；落地设计要点七条。
- v3（2026-09-16）：命名定调「程序化模式」；新增 §三「模式 vs 常驻工具」（四理由 + 两代价 + 能力轴第三条路）；设计要点补指引双版本；开放问题补并存形态边界。
- v3.1（2026-09-16）：命名终裁维持「程序化模式」——「高效模式」否决（质量阶梯/机制不可见/速度误导/命名空间占用），效率主张移 description 首句。
- v4（2026-09-16）：交叉整合 `tags-include-semantics-report.md`——门禁三层结构/默认开放根因/L1-L3 修复层次/tag:fs 静默空展开；SDK 投影同源纪律；fs 标签族升 P0 前置。
- v5：全量标签化落地后的状态刷新——§四 改写为落地事实（fs/collab/infra 三族 + 平台拆分 + 空展开告警 + 存量迁移 + 子 Agent 派生身份）；§三 第三条路校准为「tags 即工具面」名副其实；§六.4 并发分类明确按工具粒度；§六.9 预设形态简化（L1 回退不再需要）；§七 实施路线五项已完成、P0 前置全清；开放问题剩四条。
- v5.1（2026-09-16）：前置修复合入（技术债清理）——①基础族迁移一次性标记（曾实现）②`resolveToolNames` 增 `onUnknownLiteral` 回调 + router 接线（字面名不在可见面 = 配置错误可观测——覆盖存量 Windows 'bash' 与拼写错）③README 补「tags 即工具面」出厂限定语与落空可观测注记。
- v5.2（2026-09-16）：**基础族自动补齐迁移整体移除**（用户终态裁决：normalizeUniversalTags 与 `_migratedUniversalTags` 标记全部删除，tags 完全以用户/预设配置为准——存量用户手工补、新建走 agent-admin 创建面缺省 UNIVERSAL_TAGS）。v5.1 的 ① 作废、②③ 维持；UNIVERSAL_TAGS 常量导出保留并附语义存档注释（防"顺手恢复"）。相关测试改写为「不补齐」锁定用例。
- v6（2026-09-17，当前）：**开关化终裁**——程序化从预设改为会话级开关（§十）：`__programmatic__` 预设退役、conv-settings 加 `programmatic` 键、router 工具面合成后收窄 LLM 面、UI = 输入框工具栏模式选择器、存量预设会话禁止续聊（前端防御检测）。六次真模型实测复盘见 `run-code-handoff.md` §六（预检误杀修复/guidance 优化/32KB 预算/lib 临时库/serializeValue 降级链均随实测落地）。
- 命名二轮（收口）：函数/lambda/组合/闭包/算子五候选全否——共同伤是"描述代码长什么样"而非"模式做什么"（用户选模式需要机制可见性），且各自撞名（函数=function calling、组合=GoF Composite、lambda=AWS/无副作用语义反向）；算子融合（ML 框架 kernel 合并）与 PTC 同构，留档为 description 解释话术不作名。**命名讨论就此收口，终名「程序化模式」。**
