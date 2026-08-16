# 归档文档索引（Archive）

> 这些文档曾驱动 AgentChat 演进到 v0.6.2「一切皆插件」。它们的路径/结论大多已过期，
> 按 2026-08-15 文档整理统一归档，仅供追溯历史决策与复盘，**不要当作当前行为依据**。
> 当前行为以 [docs/README.md](../README.md) 与源码为准。

## 迁移与研究（cordis 化过程）

| 文档 | 内容 | 何时过期 |
|------|------|----------|
| `cordis-migration-research.md` | cordis 选型调研（版本/概念映射/三方案） | v0.6.x 迁移完成 |
| `cordis-granularity-analysis.md` | 拆分粒度分析（20 包建议稿） | 落地后结构有调整 |
| `cordis-minimality-audit.md` | 插件最小化验证与逐包判定 | 同前 |
| `research-cordis/` | cordis 学习笔记（01–07 + 3 篇练习） | 已内化为 `src/vendor` 与 plugin-system.md |
| `preview-contract-rebuild-plan.md` | 契约化重建方案与 inject 矩阵 | 已全部实施 |
| `preview-knowledge-base.md` | preview 时期权威状态文档（33 包依赖图/阶段历程） | 已切换 src 单轨 |
| `preview-next-session.md` | 会话交接/学习笔记 | 任务已完成 |
| `everything-plugin-gap-plan.md` | 「一切皆插件」差距清单（块 A–E） | 块 A–E 全部完成（2026-08-15） |
| `block-e-migration.md` | 块 E 迁移执行记录（preview → src） | 迁移完成 |

## 设计与计划（已被实现替代）

| 文档 | 内容 | 现对应位置 |
|------|------|------------|
| `preview-plugin-deps.html` | 旧版交互式依赖图 | [dependency-graph.html](../dependency-graph.html) |
| `ui-web-pluginization-plan.md` | UI/Web 插件化 P1–P5 计划 | plugins/webui、plugins/protocol |
| `webui-refactor-plan.md` / `webui-component-analysis.md` / `webui-design-system.md` | WebUI 重构方案 | `src/ui/webui/` |
| `feed-architecture.md` | 统一信息流架构 | WebUI stores/feed |
| `design-preview.html` / `ui-library.md` / `ui-solidity-analysis.md` | UI 设计稿/组件库盘点 | 已上线 WebUI |
| `read-edit-design.md` | read/edit 工具设计演进 | plugins/edit.md、plugins/fs.md |

## 历史复盘报告

| 文档 | 内容 |
|------|------|
| `message-role-refactor-report.md` | 消息角色体系重构（trigger 一等角色、viewer 视角转换） |
| `group-reply-sparsity-report.md` | 群聊回复稀疏问题根因与修复 |
| `group-message-density-analysis.md` | 群聊消息密集问题分析与优化 |
| `token-usage-guide.md` | v0.4.x Token 消耗分析与优化记录（数据已过期，机制思路可参考） |

## 使用方式

- 要理解「为什么是 cordis」：先读 `cordis-migration-research.md`，再看 `everything-plugin-gap-plan.md`。
- 要理解某段历史 bug：对应复盘报告。
- 其余情况：直接读当前文档与源码。
