# Tag 系统报告（词表 / 机制 / 归属全貌）

> 目的：标签系统全貌一份文档说清——词表、机制、归属、演进裁决与防漂移守则。过一遍即可建立完整心智模型；后续改动先对照本文（尤其 §八 守则），改完同步本文。
> 本版 = 2026-10-06 文档治理合并版（逐项源码实测重核）：原 `tags-include-semantics-report.md`（2026-09-16，本次重构的根因分析前奏）的有效结论已并入 §二/§三/§十，原文件按归档纪律 git mv 至 `src/docs/archive/tags-include-semantics-report.md`（内容原样冻结、不再更新）。**本文是标签域唯一现行事实源。**
> 关联文档：`skill-injection-and-storage-vocab.md`（会话存储词汇 / 技能注入域）、`session-design.md`；消费方视角 `coding-mode-preset-research.md` 系列已归档仓库外 `Dev\Note\AgentChat\docs-stale-2026-09-18\src-docs\`。

## 一、词表总账（当前全量）

### 1.1 能力标签（capability——被工具 requiredTags 消费）

| 标签 | 工具 | 注册行 | 备注 |
|---|---|---|---|
| `fs` | read / write / edit / glob / grep | ac-fs-tools / ac-fs-search | 文件族（2026-09-16 新建） |
| `fs_minimal` | str_replace_editor | ac-str-replace-editor | 极简编辑器独立门禁词（早于 fs 存在，**未并入**——它是"极简插件包"的专属授权面） |
| `shell` | pwsh 或 bash（一平台一工具，无别名）+ job | ac-shell-tools | 平台拆分；job 与命令工具同族授权 |
| `web` | web_search | ac-web-tools | 有 tagDeclarations（分组元数据"Web 与浏览器"） |
| `web` + `observe` | browser | ac-web-tools | observe 是动作分层族地板（见 §1.4） |
| `collab` | send_agent / send_group / list_agents / list_groups / read_agent_info / update_agent_profile | ac-collab-tools | 多 Agent 协作族；**list_tools 不在此**（单 Agent 也要自省 → infra） |
| `infra` | ask_questions / goal / todo / timer / math / hello / load_skill / list_tools | 各所属行（list_tools 住 ac-collab-tools） | 会话基础设施（2026-09-16 新建）；run_code 已移出——2026-09-21 注入轴重构改 `injection:'mode'`，不挂标签 |
| `history` | read_history / grep_history | ac-session-query | 会话历史回放（检索 + 分页读取）；2026-09-16 全量标签化时与 infra 分立成词 |
| `delegation` | subagent | ac-subagent | 任务委派；子 Agent 派生身份**剥除此词**（防递归 spawn） |
| `dev` | read_logs / reload / reload_modules | ac-dev-tools | 开发调试面 |
| `admin` | system_restart / register_plugin / install_plugin / unregister_plugin | ac-restart / ac-plugin-registry | 宿主级管理动作；子 Agent 派生身份**剥除**（防越权） |
| `sap-adt` | adt_*（32 个） | ac-sap-adt | 领域插件先例；词值单源常量 `CAPABILITY_TAG` |
| `issue-report` | submit_issue | ac-issue-tools | **2026-09-29（cr-41）从 web 切出的独立轴**——对外发布内容公开可见，网络授权不连带解锁；RESERVED 预注册 + tagDeclarations 双声明兜底 |
| `memory` | memory_write / memory_grep | ac-memory | 记忆工具面；出厂预设不授予（cr-17，见 §七） |

口径：本表由 2026-10-06 复核生成（枚举全部生产代码 `requiredTags: [...]` 声明处 + 逐行核对工具名）。出厂工具已无游离门禁外者；`toolAllowedFor` 的 base 分支只覆盖动态插件等未声明注册面（§二）。

### 1.2 档位标签（access-tier——reserved，**永不进 requiredTags**；抉择组 `exclusive:'access-tier'`）

| 标签 | 语义 | 判定 |
|---|---|---|
| `full-access` | 不受沙箱限制（人工授予的信任） | tierOf：tags 含即生效（full 优先） |
| `sandbox-access` | 工作区白名单内自由 | 同上 |
| `base-access`（exclusiveNone） | base 档：写类工具需审批/白名单（2026-09-21 进目录——抉择下拉需显式缺省项；落词不写，缺席即语义） | 无任一档位词即 base |

档位词与能力词**正交**：能力词管"能看见什么工具"，档位词管"工具执行时的权限高度"。混用被启动期断言拦截（§八）。

### 1.3 模式标签（tool-mode——reserved，**永不进 requiredTags**；抉择组 `exclusive:'tool-mode'`）

| 标签 | 语义 | 判定 |
|---|---|---|
| `tc-base`（exclusiveNone） | 标准：模型逐个直调工具（缺省，不落词） | 无任一模式词即 base |
| `tc-programmatic` | 程序化：工具调用经 run_code 写程序编排（LLM 面收窄为单入口） | toolModeOf：tags 含即生效 |
| `tc-none` | 无工具：移除 LLM 工具面（纯聊天） | 同上（none 优先，fail-closed） |

- 判定单源 `toolModeOf` / `effectiveToolMode`（会话覆盖 `conv-settings.toolMode` ?? Agent tags）；收窄单源 `narrowToolsByMode`（tc-programmatic → `injection:'mode'` 工具集，与 tags 无关；无 mode 工具 = 空面，不回落常规面）。
- `tc-*` 是**纯模式词**（2026-09-17 裁决）：不进任何 requiredTags（启动断言扫描拦截），"程序化"是形态选择非授权门槛。
- 程序化形态 = **会话级开关**（`conv-settings programmatic` + router 收窄 LLM 面），`__programmatic__` 预设已退役（2026-09-17，见 §三）。

### 1.4 仅声明标签（无工具直接消费，`tagDeclarations` 手工声明）

| 标签 | 声明方 | 形态 |
|---|---|---|
| `web` / `observe` / `manipulate` / `inject` | ac-web-tools | browser 动作分层（tier:true 层级族：低 ⊂ 高；抉择组 `exclusive:'browser-tier'`——UI 下拉单选，选高层连带写齐低层，`exclusiveOffDesc` 说明全关后果）；browser 工具的 requiredTags 是 `['web','observe']`，分层靠 before-execute 按 action 判定——声明只提供目录展示与配置语义 |

### 1.5 退役与保留词

- **`base` 已退役**（2026-09-16）：不再预注册、不再作为用户可见标签（tag-registry 目录无此词、前端归一剔除存量）。但**内部保留两处**，是有意设计非残留：
  - `toolAllowedFor`：无 requiredTags 的工具**显式等价** `['base']` 门禁——"默认开放"的机制锚点（覆盖动态插件未声明面）；
  - `capabilitySetOf` / `sessionCapsOf`：能力集恒含 base——与上者配对，删一处即漂移（见 §六 单源纪律）。
- **`agent:<id>` owner 前缀**：私有工具标签（agentTool() 自动注入），不进目录、catalog 采集跳过，等 owner 自行声明。
- **`code-exec`**：程序化模式 P0 方案预留的新词，**未出生即退役**——程序化改走会话级开关（2026-09-17）后不再需要授权词；运行库无此词（仅历史文档与 cordis.yml 注释留痕，勿按旧文档复刻）。

## 二、机制：三层结构与根因裁决

### 2.1 三层结构（标签在哪里起作用）

```
第一层（注册声明）  ToolDefinition.requiredTags——工具行声明"我需要哪些标签"（AND 语义）
第二层（能力合成）  capabilitySetOf / sessionCapsOf：{base} ∪ {agent:<id>} ∪ AgentConfig.tags
                   → toolAllowedFor 过滤工具【可见面】（LLM 工具清单）
第三层（白名单解析） resolveToolNames：tools.include/exclude 的 'tag:<x>' 引用
                   按 requiredTags 反向展开为工具名（点名不解锁）
```

### 2.2 关键语义（配 Agent 时的心智模型）

1. **tags = 钥匙圈**：解锁工具可见性（第二层）。「tags 即工具面」对出厂工具成立（全量标签化后无一个出厂工具游离门禁外）；第三方/动态插件不声明 requiredTags 仍默认可见（base 锚点短路）——README 已注明此边界。
2. **include = 围栏**：收窄工具面的唯一手段（第三层）。include 一给即白名单；`tag:fs` 等引用自动展开、工具增删自动跟随。include **从 M15 收编首版起就是白名单**（commit 422ea9a：`const base = include ?? all`），"允许注入 tag 外单个工具"的追加语义在代码史上不存在——该记忆偏差反复出现本身说明双轴语义（tags 解锁 vs include 选取）的心智负担是真实痛点。
3. **可见 ≠ 可执行**：执行面另有 ac-security 双轴门禁（能力轴复检 + needPermission×档位权限轴）+ 双黑名单 + bash 扫描。可见面挡 LLM 浪费轮次，执行面是真防线。
4. **两处落空告警**（fail-observability，ac-router 信封装配处挂 logger.warn）：`tag:x` 展开为空（标签不存在/无工具声明）与字面名不在可见面（拼写错/平台改名如 Windows 存量 `'bash'`）。透传行为不变，静默变可观测。

### 2.3 根因裁决（原 tags-include-semantics-report §二，2026-09-16）

| 候选根因 | 裁决 | 依据 |
|---|---|---|
| A. base 隐形注入 | **不成立**（是果非因） | 即使显式化，base 亦不匹配任何门禁——无门禁工具的进门机制是 `toolAllowedFor` 短路，与 base 无关 |
| B. 无 requiredTags = 恒可见（默认开放） | **成立**（结构性根因） | tags 收不窄 read/write/edit/math/…——"tags = 工具面"的心智模型在实现上不成立，全靠 include 白名单兜底收窄 |
| C. include 白名单语义本身 | 部分成立（放大器） | 白名单 + 平台相关工具名（pwsh/bash）的组合在工具拆分后才显形矛盾，`tag:` 引用是补丁式解法 |

病灶的准确描述（修复前）：门禁体系三层各自独立演化，心智模型却假装它们是一层——用户以为写 tags 就在圈工具面，实际 tags 只是钥匙圈，工具面是"没上锁的门全部 + 钥匙能开的锁"；要精确控制必须 include 逐一点名，而点名平台相关工具名又踩平台坑，于是需要 `tag:` 引用——而 `tag:` 引用依赖 requiredTags 声明密度，声明稀疏（当时 fs 族全部无声明）导致 `tag:fs` 这类引用**静默展开为空**。

修复现状（2026-09-16 全量标签化 + 阶段 0 防恶化，均已落地）：
- fs/collab/infra 三族标签补齐 → `tag:fs` 一类引用成立；
- `toolAllowedFor` 把无 requiredTags **显式等价**为 `['base']` 门禁（caps 恒含 base，行为逐字节不变——契约从"默认开放"改写成"base 解锁"，幽灵标签变真锚点）；
- `resolveToolNames` 两类落空都回调告警，router 接线（静默 → 响）。

## 三、程序化模式的冲击与化解（裁决链，含被取代的方案）

**起点（2026-09-16 原报告）**：程序化模式 P0 预设方案 `include: ['run_code', 'tag:fs', …]` 在当时的标签体系下**会静默失效**——`tag:fs` 展开为空（fs 标签不存在；str_replace_editor 挂的是 `fs_minimal`），生效面只剩 run_code + 命令工具，而失败模式是静默的（静态断言抓不住运行期空展开）。

**当时的三选项裁决**（原 §4.1）：

| 选项 | 内容 | 裁决 |
|---|---|---|
| L1 预设层显式点名（纯数据：include 写全工具名） | 零体系改动、立即落地；但工具增删不自动跟随、与"只写 tags"形态美学不一致 | **未采用** |
| L2 补齐 fs 标签族（read/write/edit/glob/grep 挂 `requiredTags:['fs']` + 存量迁移） | 让 `tag:fs` 成立、自动跟随；需配套预设与存量迁移 | **采用**（2026-09-16 随全量标签化实施） |
| L3 体系性收口（无门禁工具全部标签化，"tags 即工具面"） | 心智模型最干净；破坏性变更 + 基础设施工具设计意图被推翻 | **不随 P0 走**（留待独立提案，未实施） |

**偿债路线图三阶段**（原 §4.3）与现状：

| 阶段 | 内容 | 现状 |
|---|---|---|
| 0 防恶化（立即） | ① `toolAllowedFor` 无 requiredTags 显式等价 `['base']`；② `resolveToolNames` 空展开告警；③ tag-registry 描述与 README 注记同步 | **已实施** |
| 1 还本（随 P0） | fs 标签族 + 存量迁移 | **已实施**（2026-09-16；三族同批） |
| 2 终态（实战反馈后） | base 可摘除化：capabilitySetOf 恒注入移除、'base' 变普通标签、新建 Agent 出厂默认带 base → "tags = 工具面"完全成立，include 退役为例外点名 | **未实施**（base 仍恒注入；翻盘条件 = 程序化/实战反馈。预标两坑：无身份宿主直调 caps={'base'} 特例；ask_questions/todo 等基础设施工具"恒注入"还是"接受可收窄"） |

**结局：方案整体被后续裁决取代（勿按原 P0 文字实施）**
- 2026-09-17：程序化形态改**会话级开关**（conv-settings `programmatic` + router 收窄 LLM 面），`__programmatic__` 预设退役、`code-exec` 标签未出生即退役——预设数据行 + tag 引用的互斥形态**不复存在**；平台相关工具名不再进 include，`tag:shell` 只服务极简预设。
- 2026-09-21：注入轴（`injection`）重构——run_code 摘 requiredTags 改 `injection:'mode'`，由 `narrowToolsByMode` 从注册面直接合成，与 tags 彻底解耦。
- 遗留观察（未被机制保证，保留警示）：SDK 投影面与 include 白名单的一致性仍无机制兜底（投影现经 `sessionCapsOf ∩ toolAllowedFor` 与真实 run 同链，含 `widenToolsForGating` 估算面同口径修复）；占位词表仍只有 `tag:shell` 一条，未扩为可配置表。

## 四、迁移与兼容（存量盘上数据）

| 机制 | 内容 | 状态 |
|---|---|---|
| ~~基础族自动补齐~~ | ~~读边界归一补 fs/collab/infra + 一次性标记~~——**已整体移除**（2026-09-16 终态裁决）：tags 完全以用户/预设配置为准，框架不做任何自动补齐。存量无三族标签的 Agent 由用户手工补（用户基数小，明确知情优于隐式改写）。`UNIVERSAL_TAGS` 常量仍导出（ac-agents），但**消费点（agent-admin 新建且未传 tags 的创建面缺省）亦已移除**——现无任何生产消费方，仅存导出与语义存档注释（防"顺手恢复"） | ✅ 移除（语义存档见 ac-agents service.ts UNIVERSAL_TAGS 注释） |
| `conductor → delegation` | 标签改名归一（读边界，回写后退役） | 既有 |
| `hooks → settings` | M24 X1 键名归一（读边界） | 既有 |
| 存量 `'bash'` 字面名（Windows） | **不迁移**（用户裁决：手工改配置）；靠落空告警兜底可观测 | 记录在案 |

读边界归一（conductor/hooks 两条）是 forever code（从不被编辑的存量 Agent 永不落盘归一形态）——删函数 = 那部分 Agent 配置突变，只增不删。基础族补齐曾是第三条，经裁决未出生即退役。

## 五、派生身份的标签传递

| 场景 | 规则 |
|---|---|
| 子 Agent（subagent spawn） | 派生注册身份 = 父身份编辑：preset:true（名册/协作/管理面不可见）+ tags = 父 tags **剥 `STRIPPED_TAGS = ['delegation','admin']`**（防递归 spawn、防宿主级越权）+ settings 浅拷贝。其余标签（含 fs/collab/infra/shell/web/档位/模式）原样继承——父有什么能力子就有什么 |
| 预设物化 | 预设数据行声明 tags + tools（`tag:shell` 占位在物化层按平台解析为 pwsh/bash 字面名，不进 AgentConfig）；盘上已有实体 skip-if-present 优先于预设物化 |
| 档位继承（run 级） | 子 Agent run 的 elevation = `effectiveTierOf`(父, call.elevation)——继承不放大也不缩水 |
| 防自助越权 | update_agent_profile 拦截 preset:true 身份的自助修改（防子 Agent 改 tags 加回 delegation/admin） |

## 六、单源纪律（谁拥有什么——改前必查）

| 职责 | 唯一归属 | 禁止 |
|---|---|---|
| 能力集合成 / 可见性判定 | `capabilitySetOf`（纯 tags）/ `sessionCapsOf`（+ 会话授权注入）/ `toolAllowedFor`（ac-agents） | ac-security 执行复检、router 可见面、list_tools、run_code 投影、subagent 装配**统一消费 sessionCapsOf**——改一处必核全部消费点 |
| 档位判定 | `tierOf` / `effectiveTierOf` / `TIER_RANK`（ac-agents） | 档位词进任何 requiredTags（启动断言拦截） |
| 模式判定 / 收窄 | `toolModeOf` / `effectiveToolMode` / `narrowToolsByMode` / `isModeToolFace`（ac-agents） | 模式词进 requiredTags；mode 工具挂 requiredTags（断言拦截） |
| `tag:` 引用展开 | `resolveToolNames`（ac-agents；router/collab/archive/web-api/admin 消费） | 各处自建展开逻辑 |
| 迁移归一 | conductor→delegation / hooks→settings 归一（ac-agent-store getAgent 内联） | 其他读路径绕过归一直读盘 |
| 标签目录 | `TagRegistryService`（ac-tag-registry：RESERVED 预注册 + tool/registered 采集 + tagDeclarations 扫描 + `catalog()`） | 手写字符串数组配 Agent（应消费 catalog） |
| 写类/命令工具名单 | `WRITE_PATH_TOOLS`（write/edit/str_replace_editor）/ `COMMAND_TOOLS`（pwsh/bash）（ac-security；run_code 等消费方 import 单源，含 fallback 探测） | 第二份词表 |
| 新建 Agent 的 tags 缺省 | **无**（2026-09-16 终态：写口不补齐、不改写，以调用方传入为准；创建面由 UI 对话框/预设声明负责） | 在写口"顺手补基础族"（曾因写口世界 ≠ 落盘世界导致协作工具静默消失） |

## 七、出厂预设的标签声明（当前）

| 预设 | tags | tools | 备注 |
|---|---|---|---|
| 标准模式 `__standard__` | fs / infra / shell / web / delegation / issue-report | —（全量可见面） | 2026-09-17 精简：不含 collab 与 history（单会话通用对话不需要）；cr-17 起不含 memory；cr-41 起含 issue-report |
| 极简模式 `__dsh_minimal__` | fs / shell / infra / fs_minimal | `include: ['str_replace_editor', 'tag:shell']` | 极简插件包专属授权面；memory/skill/datetime/system-prompt 软停用 |
| 创造模式 `__creator__` | fs / infra / shell / web / delegation / dev / admin / issue-report | —（标准同构 + dev 调试面 + admin 插件装卸） | 无新词（dev/admin 既有词复用）；技能面保留；cr-17 起不含 memory；cr-41 起含 issue-report |
| ABAP 开发 `__abap_dev__`（ac-sap-adt/preset 子行） | sap-adt / fs / collab / infra / shell / web | —（只写 tags，不写白名单） | 与标准模式同构；order=4（创造模式占 3 后顺延） |
| 程序化 | —（**无预设行**） | — | 会话级开关（conv-settings `programmatic`）；`__programmatic__` 预设 2026-09-17 退役；需要时按 tc-* 模式词/会话开关选择 |

## 八、防漂移守则（新改动 checklist）

**新增工具**：
- [ ] 声明 requiredTags（挂到已有族优先；确属新能力域才建新词）
- [ ] 不声明 = 默认开放（base 锚点）——出厂工具**禁止**不声明；动态插件接受
- [ ] needPermission 类工具确认档位矩阵行为（ac-security）
- [ ] 若走 `injection:'mode'` 通道：**不得**再挂 requiredTags（启动断言拦截）

**新增标签**：
- [ ] 命名：小写单词（连字符罕用），不得 `agent:` 前缀，不得与档位词/模式词/已有词撞名（查 tag-registry catalog）
- [ ] 出厂族词 → 预注册进 RESERVED（带面向用户的短描述）；需要分组/层级展示 → tagDeclarations（tier:true 仅用于"低 ⊂ 高"分层族）
- [ ] 有工具消费 requiredTags、无消费纯领域词才走声明——双源对同一词合法（描述取声明、工具清单取并集，browser 先例）
- [ ] 同组互斥词（档位/模式/动作分层）→ 声明挂 `exclusive: '<组名>'`（UI 聚合为下拉单选）；组的缺省项挂 `exclusiveNone: true`（进目录但不落词——缺席即语义）；判定函数不得消费 exclusive 元数据（落词规则保证一致态）
- [ ] 涉及存量授权面 → 优先"用户手工改 + 落空告警兜底"（基础族自动补齐迁移已按此裁决移除，勿"顺手恢复"）；确需读边界归一（改名类）参照 conductor→delegation 范式

**改标签语义 / 改名**：
- [ ] 改名走读边界归一（conductor→delegation 范式），盘上旧词只读不写
- [ ] 删词先查 catalog 消费方与存量盘上引用；落空告警兜底但不代替清理决策

**新增预设**：
- [ ] tags 声明授权面（主形态）；确需 include 时用 `tag:` 引用（平台相关工具名用 `tag:shell` 占位，物化层消化）
- [ ] 每个引用的运行期展开进集成测试（静态断言抓不住 tag: 空展开）

**结构性红线**：
- [ ] 档位词 / 模式词永不进 requiredTags（`assertNoTierInToolRequirements` 启动断言：RESERVED 中 category ≠ capability 的词一律拦截）
- [ ] `agent:<id>` 前缀保留给 owner 私有工具
- [ ] base 的两处内部保留（toolAllowedFor 锚 + capabilitySetOf/sessionCapsOf 注入）必须成对存在
- [ ] settings 键空间归插件；框架内部标记用 config 顶层 `_` 前缀键
- [ ] 本报告与 README 门禁节随改动同步（本文是标签域事实源）

## 九、演进时间线（决策存档）

| 时间 | 事件 |
|---|---|
| 早期 | requiredTags 能力轴建立；base 隐式注入（当时的"人人可见"表达） |
| A3（2026-09-16） | dev→shell 拆分；命令工具挂 shell + needPermission |
| access-tier（2026-09-16 规划） | 档位标签 full/sandbox 入 tags；双轴门禁定型 |
| 2026-09-16 早 | fs_minimal 建立（str_replace_editor 移出默认面）；tag-registry P1（词表显式化 + 断言）；`tag:` 引用（resolveToolNames）；browser 动作分层声明（tagDeclarations 先例） |
| 2026-09-16 | **全量标签化**：fs/collab/infra 三族补齐、base 退役（目录侧）、平台拆分 pwsh/bash、子 Agent 派生注册身份、tag:shell 占位解析、空展开告警 + 字面名落空告警、README 出厂限定语（详见已归档 `tags-include-semantics-report.md` §四与本批提交）。同日终态裁决：**基础族自动补齐迁移（normalizeUniversalTags + 一次性标记）整体移除** |
| 2026-09-16 | **根因裁决与偿债路线图**：默认开放被认定为结构性根因（非 base 隐形注入）；P0 三选项定 L2（补 fs 标签族）；阶段 0 防恶化落地（详见 §三） |
| 2026-09-17 | **tc-* 纯模式词裁决 + 程序化开关化**：tc-* 不进 requiredTags；程序化 = 会话级开关（conv-settings），`__programmatic__` 预设退役、`code-exec` 未出生即退役；极简模式优化裁决（不预配模式词） |
| 2026-09-21 | **抉择组（exclusive）**：目录条目挂互斥元数据——access-tier（base-access 显式进目录）/ tool-mode（tc-*）/ browser-tier（声明组）三组在 Agent 配置 UI 合一为下拉单选；落词单源 ac-client-ui-agents/client/tagExclusive.ts；判定面零改动 |
| 2026-09-21 | **创造模式 `__creator__`**（插件开发预设）：标准同构 + dev + admin（插件装卸三件套）；无新词；ABAP 开发 order 3→4 顺延 |
| 2026-09-21 | **注入轴（injection）重构**：run_code 摘 requiredTags 改 `injection:'mode'`；「授权词 = infra」语义退役。同批：excludeForms 轴整体撤销（实施偏差），交互性改 `requiresInteraction` 布尔（self 会话自动排除，formDeniedBy 单源）；system_restart 撤 single 限制。启动断言扩：mode 工具禁挂 requiredTags |
| 2026-09-26 | **会话授权注入进可见性合成（`sessionCapsOf`）**：browserTier 可见性事故根修——conv-settings 键定义 `grants` 声明的标签在"可见性合成点"统一注入（此前只作用 web-tools 动作门禁，无 tags 的 Agent 在工具可见面就看不到 browser）；router / agents tool-defs / list_tools / run_code 投影 / ac-security / subagent 统一换用 sessionCapsOf |
| 2026-09-28 | **cr-17 预设记忆工具面收口**：三个内置预设 tags 移除 memory——预设无人格且单例物化，注入软停用 + 工具面预授予 = "可见但永不回来"裂缝；memory_write/grep 要记忆走人格 Agent |
| 2026-09-29 | **cr-41 对外发布独立轴**：submit_issue 的 requiredTags 从 web 切到新词 issue-report（网络授权不连带解锁对外发布）+ tag-registry 预注册 + 会话开关 + tagDeclarations 双声明兜底 |
| 2026-10-06 | **本文合并治理**：tags-include-semantics-report.md 有效结论并入本文，原文归档 `src/docs/archive/`；词表按源码复核（补 issue-report / memory 两词，修正预设声明面，补 tc-* 与 sessionCapsOf） |

## 十、附录：核查方法与证据锚点

- requiredTags 全集：生产代码 27 处声明（`Get-ChildItem src -Recurse -File -Include *.ts | Select-String 'requiredTags: \['`，滤 node_modules/tests/templates 后逐行核对工具名）
- 工具可见性两支：`toolAllowedFor` / `capabilitySetOf` / `sessionCapsOf` / `resolveToolNames`（`src/ac-agents/src/service.ts`）
- include 首版语义：`git show 422ea9a:preview/ac-agents/src/service.ts`（M15 收编时 `const base = include ?? all`）
- 落空告警接线：`src/ac-router/src/service.ts`（信封装配处，两类回调）
- 执行门禁：`src/ac-security/src/index.ts`（能力轴 sessionCapsOf + 权限轴 effectiveTierOf；词表 WRITE_PATH_TOOLS / COMMAND_TOOLS）
- 词表目录：`src/ac-tag-registry/src/service.ts`（RESERVED / catalog / assertNoTierInToolRequirements）
- 预设声明：`src/ac-agent-presets-builtin/src/index.ts`（标准/极简/创造）、`src/ac-sap-adt/src/preset.ts`（ABAP）
- 程序化方案原文（已被取代，历史）：已归档 `tags-include-semantics-report.md` §三/§四 + `coding-mode-preset-research.md` 系列（仓库外归档）

## 十一、快速定位索引

| 想看/想改 | 去 |
|---|---|
| 词表预注册（fs/collab/infra/history/issue-report/档位/模式描述） | `src/ac-tag-registry/src/service.ts` RESERVED |
| 手工声明（分组/层级/互斥） | `src/ac-web-tools/src/index.ts` tagDeclarations / `src/ac-issue-tools/src/index.ts`（双声明先例）；契约 `src/ac-tag-registry/src/contract.ts` |
| 能力判定/展开纯函数 | `src/ac-agents/src/service.ts`（capabilitySetOf / sessionCapsOf / toolAllowedFor / tierOf / effectiveTierOf / toolModeOf / effectiveToolMode / narrowToolsByMode / resolveToolNames / UNIVERSAL_TAGS） |
| 执行门禁（权限轴/黑名单/扫描） | `src/ac-security/src/index.ts` |
| 目录 RPC（tags/catalog） | `src/ac-tag-registry/src/service.ts` catalog() |
| 抉择组落词（exclusive UI 语义） | `src/ac-client-ui-agents/client/tagExclusive.ts`（聚合/反解/落词单源）+ `TagChoice.vue` + `AgentPane.vue` |
| 落空告警接线 | `src/ac-router/src/service.ts`（信封装配处） |
| 预设占位解析 | `src/ac-agent-presets/src/index.ts`（tag:shell → 平台字面名） |
| 归一消费点 | `src/ac-agent-store/src/service.ts` getAgent（conductor/hooks 两条；基础族补齐已移除） |
| 新建 Agent 的 tags 写口 | `src/ac-agent-admin/src/service.ts` sanitize（原样透传，不补齐） |
| 出厂预设声明 | `src/ac-agent-presets-builtin/src/index.ts` / `src/ac-sap-adt/src/preset.ts` |
| 门禁体系 README 注记 | `src/README.md`「AgentConfig.tools 的 tag 引用」节 |
| 会话存储词汇 / 技能注入 | `skill-injection-and-storage-vocab.md` |
