# docs/design/archive —— 收官过程档案

> 性质：归档目录索引（内容冻结原样，只读——决策轨迹与踩坑实录，含被后续里程碑取代的裁决）。
> 状态：现行 · cr-1008 2026-11-11 按域分子目录重组（原扁平布局）；归档三去向与命名规约见 [../../doc-conventions.md](../../doc-conventions.md) §三。
> 读者：动手前查**现行事实源**（docs/design/<域>/）而非本目录；只有追溯「当初为什么这么定」时才进这里。

## 归档纪律

1. **内容冻结**——归档档不随代码演进更新，不改原文、不按档案行号对拍当前代码。
2. **按域分目录**（cr-1008 起）：`assembly/` `session/` `webui/` `plugin/` `llm/` `ops/` `platform/` `meta/`——与 `docs/design/` 现行域同构。
3. **归档判据**：计划/评审/交接/对账类文档，实施已完成且验收全绿 → 移入本目录；域深设计与裁决簿永不归档。
4. **三去向**：有复用价值 → 本目录；整体过时无价值 → 仓库外归档根（`Note\AgentChat\docs-archived-<日期>\`）；内容已被他档吸收 → 删除并在吸收档记来源。
5. `scripts/` 存归档期验证脚本（与对应里程碑档案同批退役），保留供追溯，不纳入构建。

## 索引

| 域 | 篇数 | 代表档案 |
|---|---|---|
| [assembly/](assembly/) | 8 | `per-agent-instance-architecture.html`（per-Agent 实例架构终稿图）、`host-generation-takeover.md`（宿主换代接管）、`host-shell-read-face-audit.md`（读面审计）、`shell-orphan-process-postmortem.md`（孤儿进程复盘） |
| [session/](session/) | 16 | `message-pipeline-analysis.md` + `message-pipeline-graph.html`（消息管线全景）、`session-event-log-unification-plan.md`（事件日志统一）、`live-pipeline-event-projection-plan.md`（直播管线 B 案）、`security-access-tier-plan.md`（安全档位） |
| [webui/](webui/) | 19 | `m27-webui-slot-refactor-plan.md`（槽位重构）、`webui-v3` 前身系列、`ui-plugin-selfhost.md`（自持产物，已被 v3 取代）、`open-with-app-plan.md`（打开方式） |
| [plugin/](plugin/) | 5 | **`plugin-architecture-v2.md`（v2.1 实施规范，已被 cr-1006 新稿取代——查现行规范请到 `../plugin/plugin-architecture.md`）**、`plugin-face-unification-plan.md`、`plugin-dev-skill-plan.md`、`preset-identity-convergence-plan.md`、`plugin-dev-paradigm-plan.md` |
| [llm/](llm/) | 3 | `llm-protocol-extensibility.md`（协议扩展性）、`llm-provider-model-plan.md`（提供商模型）、`cloud-provider-api-key-adoption.md`（云部署 key 化） |
| [ops/](ops/) | 5 | `edit-tool-incident-report.md`（编辑工具 P0 事故）、`release-ci-postmortem-0814.md`（首发翻车）、`run-code-hardening-backlog.md` |
| [platform/](platform/) | 29 | `m31`–`m35` 移动端系列、`prompt-adjustment-plan.md` + `dsh-system-prompt-analysis.md` + `harness-prompts-survey.md`（提示词四轮调研与实施）、`browser-cdp-plan.md`、`memory-timeline-plan.md`、`relay-security-audit-*`、`track-readme-src-era.md` |
| [meta/](meta/) | 0 | （无归档档；现行规约全在 `../meta/`） |
| [scripts/](scripts/) | 20 | m31/m32/m35 验证脚本、relay-e2e、迁移脚本（`migrate-*`） |

> 逐个文件的完整清单见各域目录（本表只列代表档，不维护逐档说明——那是各域 README 的职责，当前按需检索用 `git log --follow <路径>`）。

## 历史沿革

- 2026-09-18（M30 收官）：归档策略建立，里程碑过程文档移入本目录。
- 2026-10-01（cr-79）：根目录完结批次收编。
- 2026-11-11（cr-1008）：全档按域分子目录重组（扁平 65 篇 → 8 域）；索引表精简为代表档指针。
