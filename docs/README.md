# AgentChat 文档中心

> 性质：仓库级文档索引与归属规则。
> 状态：现行 · cr-1008 2026-11-11 整理批完成（cr-1019 复核修复收口）——文档规范成文 + design/ 八域重组（65 篇落位、archive 按域分目录）、现行 43 篇头部 43/43 合规、md 链接与代码注释路径 0 死链、独立复核 P0×2/P1×10/P2×3 全修。
> 历史节点：2026-10-26 cr-703 单轨布局重组；2026-10-27 cr-726 全量审查批（12 篇归档）。

## 归属规则

| 位置 | 收什么 |
|------|--------|
| 仓库根 README.md | 根级布局与开发事实源：架构、仓库布局、命令、文档地图 |
| 本目录 docs/ | 仓库级文档：规范（doc-conventions.md）、发版手册（release.md）、索引（本文件） |
| docs/design/<域>/ | 设计档案现行档：域深设计、裁决簿、活跃计划/调研/审计（域划分见下表） |
| docs/design/archive/ | 收官过程档案——内容冻结原样，只读（cr-1008 起按域分目录，索引见 archive/README.md） |
| docs/cutover/ | preview 轨归档——只读历史，不再更新 |

## 文档规范

一切新文档落笔前先读 [doc-conventions.md](doc-conventions.md)（cr-1008 起）：kebab-case + 体裁后缀命名；头部三行（性质 / 状态 / 读者）；正文日期真实日历日 YYYY-MM-DD；移动文档全仓同步引用。

## design/ 域目录（整理批目标态）

| 域 | 收什么 | 代表档（批后落位） |
|---|---|---|
| assembly/ | 装配、行集、进程模型、数据根分层 | menu-assembly.md、host-shell-row-manifest.md、host-shell-decisions.md、data-root-layers.md、migration-chain-completeness.md、config-upgrade.md（agent-assembly.md 已被 menu-assembly.md 取代） |
| session/ | 会话状态机、运行生命周期、信封投递、子 Agent、权限模型 | session-design.md、run-status-state-machine.md、permission-gate-plan.md、permission-gate-handoff.md、conv-scope-plan.md、access-retirement-plan.md、subagent-recovery-matrix.md、conv-settings-conventions.md（会话键契约） |
| webui/ | WebUI 装载模型、行/席、控件标准、UI 计划 | webui-v3.md、ui-rows-and-slots.md、webui-standard-controls.md |
| plugin/ | 插件体系规范与开发范式 | **plugin-architecture.md（现行规范，cr-1006）**、auth-registry-data-format.md |
| llm/ | 模型协议、连接池、提供商接入 | llm-pool-hardening-cr99.md |
| ops/ | 发版 CI、性能、事故复盘、安全 | release-ci-postmortem.md、perf-followups-2026-11-10.md |
| platform/ | 跨域横切：提示词机制、技能注入、信封锁协议、远程接入、平台增量 | rpc-transitional-audit.md、remote-client-relay-plan.md、skill-injection-and-storage-vocab.md |
| meta/ | 文档与流程自身的规约、活清单 | epoch-marking-convention.md、cr-tool-v2.md、gap-backlog.md |

> 边界拿不准 → platform/；批内执行可微调落位，落位后本表同步。
>
> **当前存量**（2026-11-11 cr-1008 整理批收官 + 独立复核后）：现行 **43 篇 .md + 2 个图件**（assembly 9 / session 7 / webui 8 / plugin 2 / llm 1 / ops 3 / platform 10 md + 2 html / meta 3）+ 归档 `archive/<域>/`（assembly 8 / session 16 / webui 19 / plugin 5 / llm 3 / ops 5 / platform 29 / meta 0 / scripts 20）。已实施且无前置依赖的 **18 篇**按收官判据迁入 archive（内容冻结只读）；另有 3 篇自述「已实施待归档」但**缓归档**——`prompt-section-ecosystem-fix`（§8 判据表需先并入他档）、`single-system-prompt-materialization-plan`（§3/§4 需确认承载方）、`system-prompt-decentralization-plan`（§3 段落归属表是唯一索引），随提示词域一次收口。
>
> **文档地图**（逐档见各域目录；`archive/README.md` 是归档索引）：`assembly/` 行集与装配裁决、`session/` 会话与运行、`webui/` 前端装载、`plugin/` 插件体系、`llm/` 模型连接、`ops/` 运维复盘、`platform/` 跨域横切、`meta/` 文档自身规约。

## 批次进度板（cr-1008 · 2026-11-11 立）

| 批 | 范围 | 篇数 | 状态 |
|---|---|---|---|
| 0 | 全局：规范成文 + 本目录划分 + 全仓引用 interim 重指 00-ToRevise | — | ☑ 2026-11-11 |
| 1 | assembly/（装配·行集·进程·数据根） | 14 | ☑ cr-1009 |
| 2 | session/（会话·运行·信封·子 Agent） | 10 | ☑ cr-1010 |
| 3 | webui/（装载·行席·控件·UI 计划）；基座 webui.yml v4 + 生成器注释同步 + 重跑投影 | 11 | ☑ cr-1017 |
| 4 | plugin/ + llm/（插件体系·模型连接） | 9 | ☑ cr-1016 |
| 5 | ops/ + platform/（发版·性能·事故·提示词·调研·远程·平台增量） | 18 | ☑ cr-1018 |
| 6 | meta/（规约·活清单）+ archive/ 按域分目录 + 队列移除 + 全仓引用终指 + 根 README 文档地图刷新 + 归档裁决（21 篇已实施/已取代 → archive 域目录） | 3 | ☑ 2026-11-11 |

整理批已收官；后续维护按「维护规则」与 [doc-conventions.md](doc-conventions.md) 执行。本板保留全部批次记录（批内过程与验收基准），逐批 CR 为 cr-1009/1010/1017/1016/1018。

## 当前可用文档

| 文档 | 说明 |
|------|------|
| [doc-conventions.md](doc-conventions.md) | **文档规范**：命名、格式、归档纪律（整理批验收基准） |
| [../README.md](../README.md) | 根级事实源：架构、packages/+apps/ 布局、命令、文档地图 |
| [release.md](release.md) | npm 发版流程手册（OIDC / tag 驱动 CI） |
| [design/](design/) | 现行设计档案八域（65 篇，cr-1008 起按域组织——逐域见上方「design/ 域目录」表） |
| [design/archive/](design/archive/) | 收官过程档案（冻结，批 6 起按域分目录） |
| [cutover/](cutover/) | preview 轨历史（只读） |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本历史 |

## 维护规则

1. **文档只描述当前代码**。过时副本不留仓库内；old-track 口径一律归档到仓库外归档根或 docs/cutover/。
2. 新文档落笔前先读根 README.md、[doc-conventions.md](doc-conventions.md) 与 .dsh/skills/（agentchat-dev），以当前代码为准。
3. 域深设计/裁决直接落 docs/design/<域>/；正在推进的计划同域维护，不另建轨道目录。
4. 收官判据与归档三去向见规范 §三；域深设计与现行事实源**永不归档**，随代码演进维护。
5. preview 相关历史只进 docs/cutover/（冻结），不再作为现行口径引用。
6. 移动/改名文档 = git mv + 全仓引用同步（node cr/cr-git.mjs check 路径锁会提示未命中）。
