# AgentChat 文档中心

> 2026-09：仓库已切换到 `ac-*` 注册制新架构（preview → src 轨道转正），**旧轨文档已整体归档至仓库外**，避免过时口径被误当作有效知识。
> 新架构文档重写中。归档位置：`C:\Users\xiaofeng\Documents\Dev\docs\AgentChat`
> - `docs-pre-refactor-2026-09\` —— 重构前 docs/ 根文档（architecture / configuration / plugin-\* / tool-\* 系列、src-webui 两册、dependency-graph）与 `tutorial\` 十步教程、更早的 `docs-archive\` 历史资料
> - `docs-stale-2026-09\` —— 已完成的计划/调研/评审文档

---

## 当前可用文档

| 文档 | 说明 |
|------|------|
| [release.md](release.md) | npm 发版流程手册（OIDC / tag 驱动 CI；个别构建路径注释待随新轨更新） |
| [ui-descriptive-text-inventory.md](ui-descriptive-text-inventory.md) | WebUI 描述性文本清单（tooltip / 帮助文档化改造素材，新轨 src/webui） |
| [../src/README.md](../src/README.md) | **轨道事实源**：新轨道全域能力地图（25+ 域契约 + 链路 + 装配） |
| [../src/docs/](../src/docs/) | 设计档案：里程碑方案 M7-M25、会话域深设计、LLM 池重构方案等 |

## 维护规则

1. **文档只描述当前代码**。旧轨文档一律归档到仓库外，不在仓库内留存过时副本。
2. 新架构文档落笔前先读 `src/README.md` 与 `.dsh/skills/`（agentchat-framework-dev / agentchat-plugin-dev），以当前代码为准。
