# Tag 系统报告（2026-09-16 终态）

> 目的：标签系统全貌一份文档说清——词表、机制、归属、演进裁决与防漂移守则。过一遍即可建立完整心智模型；后续改动先对照本文（尤其 §七 守则），改完同步本文。
> 关联文档：`tags-include-semantics-report.md`（本次重构的根因分析）、`coding-mode-preset-research.md` v5.1（消费方视角）。

## 一、词表总账（当前全量）

### 1.1 能力标签（capability——被工具 requiredTags 消费）

| 标签 | 工具 | 注册行 | 备注 |
|---|---|---|---|
| `fs` | read / write / edit / glob / grep | ac-fs-tools / ac-fs-search | 文件族（2026-09-16 新建） |
| `fs_minimal` | str_replace_editor | ac-str-replace-editor | 极简编辑器独立门禁词（早于 fs 存在，**未并入**——它是"极简插件包"的专属授权面） |
| `shell` | pwsh / bash / job | ac-shell-tools | 平台拆分：Windows 注册 pwsh、Unix 注册 bash（一平台一工具，无别名）；job 与命令工具同族授权 |
| `web` | web_search | ac-web-tools | 有手工声明（分组元数据） |
| `web` + `observe` | browser | ac-web-tools | observe 是动作分层族（见 §1.3） |
| `collab` | send_agent / send_group / list_agents / list_groups / read_agent_info / update_agent_profile | ac-collab-tools | 多 Agent 协作族；**list_tools 不在此**（单 Agent 也要自省 → infra） |
| `infra` | ask_questions / goal / todo / timer / math / hello / load_skill / read_history / grep_history / list_tools | 各所属行 | 会话基础设施（2026-09-16 新建） |
| `delegation` | subagent | ac-subagent | 任务委派；子 Agent 派生身份**剥除此词**（防递归 spawn） |
| `dev` | read_logs / reload / reload_modules | ac-dev-tools | 开发调试面 |
| `admin` | system_restart / register_plugin / unregister_plugin / install_plugin | ac-restart / ac-plugin-registry | 宿主级管理动作；子 Agent 派生身份**剥除**（防越权） |
| `sap-adt` | adt_*（32 个） | ac-sap-adt | 领域插件先例 |

### 1.2 档位标签（access-tier——reserved，**永不进 requiredTags**）

| 标签 | 语义 | 判定 |
|---|---|---|
| `full-access` | 不受沙箱限制（人工授予的信任） | tierOf：tags 含即生效（full 优先） |
| `sandbox-access` | 工作区白名单内自由 | 同上 |
| （缺省）`base-access` | base 档：写类工具需审批/白名单 | 无任一档位词即 base |

档位词与能力词**正交**：能力词管"能看见什么工具"，档位词管"工具执行时的权限高度"。混用被启动期断言拦截（§五.4）。

### 1.3 仅声明标签（无工具直接消费，`tagDeclarations` 手工声明）

| 标签 | 声明方 | 形态 |
|---|---|---|
| `observe` / `manipulate` / `inject` | ac-web-tools | browser 动作分层（tier:true 层级族：低 ⊂ 高）；browser 工具的 requiredTags 是 `['web','observe']`，分层靠 before-execute 按 action 判定——声明只提供目录展示与配置语义 |

### 1.4 退役与保留词

- **`base` 已退役**（2026-09-16）：不再预注册、不再作为用户可见标签（tag-registry 目录无此词、UI 归一剔除存量）。但**内部保留两处**，是有意设计非残留：
  - `toolAllowedFor`：无 requiredTags 的工具**显式等价** `['base']` 门禁——"默认开放"的机制锚点（覆盖动态插件未声明面）；
  - `capabilitySetOf`：能力集恒含 base——与上者配对，删一处即漂移（见 §五.2 单源纪律）。
- **`agent:<id>` owner 前缀**：私有工具标签（agentTool() 自动注入），不进目录、catalog 采集跳过，等 owner 自行声明。

## 二、三层机制（标签在哪里起作用）

```
第一层（注册声明）  ToolDefinition.requiredTags——工具行声明"我需要哪些标签"（AND 语义）
第二层（能力合成）  capabilitySetOf：{base} ∪ {agent:<id>} ∪ AgentConfig.tags
                   → toolAllowedFor 过滤工具【可见面】（LLM 工具清单）
第三层（白名单解析） resolveToolNames：tools.include/exclude 的 'tag:<x>' 引用
                   按 requiredTags 反向展开为工具名（点名不解锁）
```

关键语义（**配 Agent 时的心智模型**）：

1. **tags = 钥匙圈**：解锁工具可见性（第二层）。「tags 即工具面」对出厂工具成立（全量标签化后无一个出厂工具游离门禁外）；第三方/动态插件不声明 requiredTags 仍默认可见（base 锚点短路）——README 已注明此边界。
2. **include = 围栏**：收窄工具面的唯一手段（第三层）。include 一给即白名单；`tag:fs` 等引用自动展开、工具增删自动跟随。
3. **可见 ≠ 可执行**：执行面另有 ac-security 双轴门禁（能力轴复检 + needPermission×档位权限轴）+ 双黑名单 + bash 扫描。可见面挡 LLM 浪费轮次，执行面是真防线。
4. **两处落空告警**（fail-observability，router 挂 logger.warn）：`tag:x` 展开为空（标签不存在/无工具声明）与字面名不在可见面（拼写错/平台改名如 Windows 存量 'bash'）。透传行为不变，静默变可观测。

## 三、迁移与兼容（存量盘上数据）

| 机制 | 内容 | 状态 |
|---|---|---|
| ~~基础族自动补齐~~ | ~~读边界归一补 fs/collab/infra + 一次性标记~~——**已整体移除**（2026-09-16 终态裁决）：tags 完全以用户/预设配置为准，框架不做任何自动补齐。存量无三族标签的 Agent 由用户手工补（用户基数小，明确知情优于隐式改写）。保留出口：`UNIVERSAL_TAGS` 常量导出（ac-agents），仅一处消费——agent-admin **新建**且未传 tags 时的创建面缺省（显式传 tags 含空数组、以及一切更新均原样透传） | ✅ 移除（语义存档见 ac-agents service.ts UNIVERSAL_TAGS 注释，防"顺手恢复"） |
| `conductor → delegation` | 标签改名归一（读边界，回写后退役） | 既有 |
| `hooks → settings` | M24 X1 键名归一（读边界） | 既有 |
| 存量 `'bash'` 字面名（Windows） | **不迁移**（用户裁决：手工改配置）；靠落空告警兜底可观测 | 记录在案 |

读边界归一（conductor/hooks 两条）是 forever code（从不被编辑的存量 Agent 永不落盘归一形态）——删函数 = 那部分 Agent 配置突变，只增不删。基础族补齐曾是第三条，经裁决未出生即退役。

## 四、派生身份的标签传递

| 场景 | 规则 |
|---|---|
| 子 Agent（subagent spawn） | 派生注册身份 = 父身份编辑：preset:true（名册/协作/管理面不可见）+ tags = 父 tags **剥 delegation/admin**（防递归 spawn、防宿主级越权）+ settings 浅拷贝。其余标签（含 fs/collab/infra/shell/web/档位）原样继承——父有什么能力子就有什么 |
| 预设物化 | 预设数据行声明 tags + tools（`tag:shell` 占位在物化层按平台解析为 pwsh/bash 字面名，不进 AgentConfig）；盘上已有实体 skip-if-present 优先于预设物化 |
| 档位继承（run 级） | 子 Agent run 的 elevation = effectiveTierOf(父, call.elevation)——继承不放大也不缩水 |
| 防自助越权 | update_agent_profile 拦截 preset:true 身份的自助修改（防子 Agent 改 tags 加回 delegation/admin） |

## 五、单源纪律（谁拥有什么——改前必查）

| 职责 | 唯一归属 | 禁止 |
|---|---|---|
| 能力集合成 / 可见性判定 | `capabilitySetOf` / `toolAllowedFor`（ac-agents） | ac-security 有同款合成（执行复检用）——**两处必须同构**，改一处必改另一处 |
| 档位判定 | `tierOf` / `effectiveTierOf`（ac-agents） | 档位词进任何 requiredTags（启动断言拦截） |
| tag: 引用展开 | `resolveToolNames`（ac-agents；router/collab/archive/web-api/admin 消费） | 各处自建展开逻辑 |
| 迁移归一 | conductor→delegation / hooks→settings 归一（ac-agent-store getAgent 内联；基础族自动补齐已移除，仅存语义存档注释） | 其他读路径绕过归一直读盘 |
| 标签目录 | `TagRegistryService`（ac-tag-registry：RESERVED 预注册 + tool/registered 采集 + tagDeclarations 扫描 + catalog()） | 手写字符串数组配 Agent（应消费 catalog） |
| 写类工具名单 | `WRITE_PATH_TOOLS` / `COMMAND_TOOLS`（ac-security；fs/shell 工具行基线共用） | 第二份词表（并发分类等消费方引用单源） |

## 六、出厂预设的标签声明（当前）

| 预设 | tags | tools |
|---|---|---|
| 标准模式 `__standard__` | fs / collab / infra / shell / web / delegation | —（全量可见面） |
| 极简模式 `__dsh_minimal__` | fs / shell / infra / fs_minimal | include: str_replace_editor + tag:shell |
| ABAP 开发 `__abap_dev__`（sap-adt-preset 子行） | sap-adt / shell / web | — |

## 七、防漂移守则（新改动 checklist）

**新增工具**：
- [ ] 声明 requiredTags（挂到已有族优先；确属新能力域才建新词）
- [ ] 不声明 = 默认开放（base 锚点）——出厂工具**禁止**不声明；动态插件接受
- [ ] needPermission 类工具确认档位矩阵行为（ac-security）

**新增标签**：
- [ ] 命名：小写单词（连字符罕用），不得 `agent:` 前缀，不得与档位词/已有词撞名（查 tag-registry catalog）
- [ ] 出厂族词 → 预注册进 RESERVED（带面向用户的短描述）；需要分组/层级展示 → tagDeclarations（tier:true 仅用于"低 ⊂ 高"分层族）
- [ ] 有工具消费 requiredTags、无消费纯领域词才走声明——双源对同一词合法（描述取声明、工具清单取并集，browser 先例）
- [ ] 涉及存量授权面 → 优先"用户手工改 + 落空告警兜底"（基础族自动补齐迁移已按此裁决移除，勿"顺手恢复"）；确需读边界归一（改名类）参照 conductor→delegation 范式

**改标签语义 / 改名**：
- [ ] 改名走读边界归一（conductor→delegation 范式），盘上旧词只读不写
- [ ] 删词先查 catalog 消费方与存量盘上引用；落空告警兜底但不代替清理决策

**新增预设**：
- [ ] tags 声明授权面（主形态）；include 用 `tag:` 引用（平台相关工具名用 `tag:shell` 占位，物化层消化）
- [ ] 每个引用的运行期展开进集成测试（静态断言抓不住 tag: 空展开）

**结构性红线**：
- [ ] 档位词永不进 requiredTags（`assertNoTierInToolRequirements` 启动断言）
- [ ] `agent:<id>` 前缀保留给 owner 私有工具
- [ ] base 的两处内部保留（toolAllowedFor 锚 + capabilitySetOf 注入）必须成对存在
- [ ] settings 键空间归插件；框架内部标记用 config 顶层 `_` 前缀键
- [ ] 本报告与 README 门禁节随改动同步（本文是标签域事实源）

## 八、演进时间线（决策存档）

| 时间 | 事件 |
|---|---|
| 早期 | requiredTags 能力轴建立；base 隐式注入（当时的"人人可见"表达） |
| A3（2026-08） | dev→shell 拆分；bash 挂 shell + needPermission |
| access-tier（2026-12 规划） | 档位标签 full/sandbox 入 tags；双轴门禁定型 |
| 2026-09 早 | fs_minimal 建立（str_replace_editor 移出默认面）；tag-registry P1（词表显式化 + 断言）；tag: 引用（resolveToolNames）；browser 动作分层声明（tagDeclarations 先例） |
| 2026-09-16 | **全量标签化**：fs/collab/infra 三族补齐、base 退役（目录侧）、平台拆分 pwsh/bash、子 Agent 派生注册身份、tag:shell 占位解析、空展开告警 + 字面名落空告警、README 出厂限定语（详见 tags-include-semantics-report.md §四与本批提交）。同日终态裁决：**基础族自动补齐迁移（normalizeUniversalTags + 一次性标记）整体移除**——tags 完全以用户/预设配置为准，仅留 agent-admin 新建缺省与语义存档注释 |
| 待办 | 程序化模式 `__programmatic__` 预设（含新标签 `code-exec`——首个后标签化时代新建词，按 §七守则走预注册） |

## 九、快速定位索引

| 想看/想改 | 去 |
|---|---|
| 词表预注册（fs/collab/infra/档位描述） | `src/ac-tag-registry/src/service.ts` RESERVED |
| 手工声明（分组/层级） | `src/ac-web-tools/src/index.ts` tagDeclarations（先例）；契约 `ac-tag-registry/src/contract.ts` |
| 能力判定/展开纯函数 | `src/ac-agents/src/service.ts`（capabilitySetOf / toolAllowedFor / tierOf / resolveToolNames / UNIVERSAL_TAGS——基础族常量，agent-admin 新建缺省消费） |
| 执行门禁（权限轴/黑名单/扫描） | `src/ac-security/src/index.ts` |
| 目录 RPC（tags/catalog） | `src/ac-tag-registry/src/service.ts` catalog() |
| 落空告警接线 | `src/ac-router/src/service.ts`（信封装配处） |
| 预设占位解析 | `src/ac-agent-presets/src/index.ts`（tag:shell → 平台字面名） |
| 归一消费点 | `src/ac-agent-store/src/service.ts` getAgent（conductor/hooks 两条；基础族补齐已移除） |
| 新建缺省（基础族） | `src/ac-agent-admin/src/service.ts` sanitize（current === undefined 且未传 tags） |
| 门禁体系 README 注记 | `src/README.md`「AgentConfig.tools 的 tag 引用」节 |
