# AgentChat 文档中心

> 2026-10-26（cr-703）：全仓重组为单轨布局——活包住 `packages/`、四应用住 `apps/`，旧 `src/` 与 `preview/` 双轨叙事退役。
> 更早的旧轨文档已整体归档至仓库外：`C:\\Users\\xiaofeng\\Documents\\Dev\\Note\\AgentChat`（`docs-pre-refactor-2026-09\\` / `docs-stale-2026-09\\` / `docs-stale-2026-09-18\\`）。
> 2026-10-27（cr-726）：全量文档审查批——12 篇归档（8 篇入 `design/archive/`、4 篇整体过时移仓库外归档根 `docs-archived-2026-10-27\\`），约 25 篇按现行事实修正；审查底稿与疑点清单在仓库外归档根 `docs-review-2026-10-27\\`。

---

## 归属规则

| 位置 | 收什么 |
|------|--------|
| 仓库根 `README.md` | **根级布局与开发事实源**：架构、仓库布局、命令、文档地图 |
| 本目录（`docs/`） | **仓库级文档**：发版流程、文档索引（不放轨道内设计文档） |
| [`docs/design/`](design/) | **设计档案**：域深设计、现行裁决、活跃计划/调研/审计；收官过程文档冻结于其 `archive/` |
| [`docs/cutover/`](cutover/) | **preview 轨归档**：立项、规格、交接、计划与状态板——只读历史，不再更新 |

## 当前可用文档

| 文档 | 说明 |
|------|------|
| [../README.md](../README.md) | **根级事实源**：架构、`packages/`+`apps/` 布局、命令、文档地图 |
| [design/cr-703-followups.md](design/cr-703-followups.md) | **cr-703 收尾清单**：P0/P1/P2 遗留、证据与验收 |
| [design/rpc-transitional-audit.md](design/rpc-transitional-audit.md) | **RPC 过渡实现审计**（cr-715）：前端死链 6 / 空桩 3 / fail-loud 错位 8 / timers-row 近似 / stale 注释——逐项处置清单 |
| [release.md](release.md) | npm 发版流程手册（OIDC / tag 驱动 CI） |
| [design/](design/) | 设计档案：会话/运行时/行册/行集裁决/壳模型/信封协议/远程接入等（标签系统报告已归档——tag 机制 cr-484 起退役） |
| [cutover/](cutover/) | preview 轨历史（规格 `spec.md`、计划 `plan.md`、各批交接） |
| [design/archive/track-readme-src-era.md](design/archive/track-readme-src-era.md) | cr-703 前 `src/` 轨道事实源快照（已冻结） |
| [design/gap-backlog.md](design/gap-backlog.md) | 活动缺口清单（主源：跨域待办/疑点统一登记处） |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本历史 |

## 维护规则

1. **文档只描述当前代码**。过时副本不留仓库内；old-track 口径一律归档到仓库外归档根或 `docs/cutover/`。
2. 新文档落笔前先读根 `README.md` 与 `.dsh/skills/`（agentchat-dev），以当前代码为准。
3. **域深设计/裁决直接落 `docs/design/`**；正在推进的计划在 `docs/design/` 内维护，不另建轨道目录。
4. 收官判据：计划/评审/交接/对账类文档，实施已完成且验收全绿 → 移 `docs/design/archive/`；域深设计与现行事实源**永不归档**，随代码演进维护。
5. preview 相关历史只进 `docs/cutover/`（cr-703 起冻结），不再作为现行口径引用。
