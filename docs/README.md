# AgentChat 文档中心

> 2026-09：仓库已切换到 `ac-*` 注册制新架构（preview → src 轨道转正），旧轨文档已整体归档至仓库外，避免过时口径被误当作有效知识。
> 归档位置：`C:\Users\xiaofeng\Documents\Dev\Note\AgentChat`（**2026-12 起统一归档根，早期文档中指向 `Dev\docs\AgentChat` 的路径已全部迁移至此**）：
> - `docs-pre-refactor-2026-09\` —— 重构前 docs/ 根文档（architecture / configuration / plugin-* / tool-* 系列、src-webui 两册、dependency-graph）与 `tutorial\` 十步教程、更早的 `docs-archive\` 历史资料
> - `docs-stale-2026-09\` —— 已完成的计划/调研/评审文档
> - `docs-stale-2026-12\` —— 收官里程碑终稿（M7-M25 计划、对账套件、WebUI 适配器系列、程序化模式三件套、T0/精简审计）

---

## 归属规则

| 位置 | 收什么 |
|------|--------|
| 本目录（`docs/`） | **仓库级文档**：发版流程、仓库索引（不放任何轨道内设计文档） |
| [`../src/docs/`](../src/docs/) | **src 轨道设计档案**：域深设计、现行事实源、活跃计划/调研/审计——索引见 [`../src/README.md`](../src/README.md)「设计档案索引」；收官里程碑过程文档冻结于其 `archive/` 子目录与仓库外归档根 |

## 当前可用文档

| 文档 | 说明 |
|------|------|
| [release.md](release.md) | npm 发版流程手册（OIDC / tag 驱动 CI） |
| [../src/README.md](../src/README.md) | **轨道事实源**：新轨道全域能力地图（119 个 ac-* 包 · 契约 + 链路 + 装配） |
| [../src/docs/](../src/docs/) | 设计档案：会话域深设计、UI 行册/Slot 树/组件树三事实源、标签系统、活跃方案（tavern 互通 / 远程接入 / LLM 协议扩展）等 |

## 维护规则

1. **文档只描述当前代码**。旧轨文档一律归档到仓库外归档根，不在仓库内留存过时副本。
2. 新架构文档落笔前先读 `src/README.md` 与 `.dsh/skills/`（agentchat-framework-dev / agentchat-plugin-dev），以当前代码为准。
3. **轨道内设计文档直接落 `src/docs/` 并在 `src/README.md` 设计档案索引登记**；本目录不放轨道内文档（2026-11 归整：`ui-descriptive-text-inventory.md`、`event-graphs.html` 已迁 `src/docs/`；2026-12 归整：28 份收官过程文档移归档根 `docs-stale-2026-12\`）。
4. 收官判据：计划/评审/交接/对账类文档，其实施已完成且验收全绿 → 整文件移归档根对应批次目录，索引同步更新；域深设计与现行事实源**永不归档**，随代码演进维护。
