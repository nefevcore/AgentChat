# AgentChat 文档中心

> 版本：v0.6.3（2026-08-16） · 目标：**一切皆插件**。
> 本文档是 docs/ 的导航页。README 面向用户，本目录面向用户与开发者。

---

## 文档地图

### 项目文档

| 文档 | 说明 | 面向 |
|------|------|------|
| [architecture.md](architecture.md) | 插件化架构总览：包布局、cordis 运行时、启动流程、核心引擎、工具/钩子系统、消息路由、L4 门面与事件流 | 开发者 |
| [configuration.md](configuration.md) | 全局配置 + Agent 配置参考（presets/tools/hooks 新契约、LLM 池、命名空间） | 用户/开发者 |
| [plugin-system.md](plugin-system.md) | 一切皆插件：cordis 插件模型、服务契约（inject）、插件 manifest、插件库与发布流程 | 开发者 |
| [tool-capabilities.md](tool-capabilities.md) | 工具能力标签（base/dev/admin/conductor）与第三方自定义词汇扩展设计（暂不实施） | 开发者 |
| [dependencies.md](dependencies.md) | 依赖分层图、运行时组合图、依赖规则与例外（含 Mermaid 版） | 开发者 |
| [dependency-graph.html](dependency-graph.html) | 交互式依赖图（自包含 HTML，浏览器打开；由 `node scripts/gen-deps-graph.mjs` 生成） | 开发者 |
| [sandbox-security.md](sandbox-security.md) | 沙箱与安全模型：路径沙箱、bash 限制、脱敏、凭据存储、威胁模型 | 开发者/用户 |

### 开发指南

| 文档 | 说明 |
|------|------|
| [plugin-dev-guide.md](plugin-dev-guide.md) | 如何开发一个 AgentChat 插件：manifest.json、插件行、工具/钩子注册、权限、发布与 UI 扩展 |
| [tool-dev-guide.md](tool-dev-guide.md) | 如何开发一个新工具：defineTool、requires 门控、per-Agent 烘焙、注册与热加载 |
| [archive-orchestration.md](archive-orchestration.md) | 归档调度机制设计（先整理后归档、标记体系、超时降级） |
| [router-refactor-plan.md](router-refactor-plan.md) | Router 投递链路重构实施文档：`send/trigger` 收敛、placement、pending 恢复（已实施，见 CHANGELOG Unreleased） |

### 插件文档（每包一页）

索引见 [plugins/README.md](plugins/README.md)。覆盖全部 43 个 `@agentchat/*` 工作区包与本地 vendor 生态：

- 核心引擎：`types` · `contracts` · `llm` · `llm-openai` · `llm-deepseek` · `llm-glm` · `llm-factory` · `agent-loop` · `agent-config` · `hooks` · `util`
- Agent 域：`agents` · `router` · `agent-prompt` · `agent-session` · `agent-memory` · `agent-skill` · `agent-mcp`
- 工具基础设施：`tools` · `toolkit` · `edit` · `fs` · `shell` · `web`
- 工具/服务域：`dev` · `session-tools` · `restart` · `interaction` · `durable-interaction` · `math` · `agent-tools` · `timer` · `subagent`
- 宿主/装配：`archive` · `backup` · `workspace` · `server` · `boot` · `plugins`
- 跨端与 UI：`protocol` · `webui` · `hello` · [vendor-ecosystem.md](plugins/vendor-ecosystem.md)

### Step-by-Step 学习资料

见 [tutorial/README.md](tutorial/README.md)，从零开始 10 步上手：

1. 环境与首次启动 → 2. 创建第一个 Agent → 3. Agent 配置详解 → 4. 工具与钩子 → 5. 多 Agent 通信 → 6. 定时与自主行动 → 7. 开发工具插件 → 8. 动态插件与插件库 → 9. WebUI 与事件流 → 10. 架构与依赖图

### 归档（历史资料）

[archive/README.md](archive/README.md) —— 迁移研究报告、历史设计方案与复盘报告。已过期的文档统一归档于此，保留追溯价值。

---

## 目录结构约定

```
docs/
├── README.md                 ← 本页
├── architecture.md           ← 架构总览（当前态）
├── configuration.md          ← 配置参考（当前态）
├── plugin-system.md          ← 插件体系说明
├── tool-capabilities.md      ← 工具能力标签扩展设计（暂不实施）
├── plugin-dev-guide.md       ← 插件开发指南
├── tool-dev-guide.md         ← 工具开发指南
├── dependencies.md           ← 依赖图（Mermaid + 规则）
├── dependency-graph.html     ← 交互式依赖图（自动生成）
├── plugins/                  ← 每包一页插件文档
├── tutorial/                 ← Step-by-Step 学习资料
└── archive/                  ← 过期/历史文档归档
```

## 维护规则

1. **文档只描述当前代码**。任何包改名/拆包后，同步更新 architecture、dependencies、plugins/ 对应页面。
2. **依赖图可重跑**：`node scripts/gen-deps-graph.mjs` 重新扫描 package.json 与 import 边，生成 `docs/dependency-graph.html`。
3. **过期文档先进 archive/**，不要就地修改历史报告；有长期价值的机制文档（如 archive-orchestration）就地更新路径与版本头。
4. 插件文档的"提供的能力"必须与 `register*.ts` / 插件行的实际注册一致。
