# 插件文档索引（一切皆插件）

> v0.6.3（2026-08-16）· 43 个 `@agentchat/*` 工作区包 + 本地 vendor 生态，每包一页。
> 全量 ctx 服务契约与插件模型见 [plugin-system.md](../plugin-system.md)；依赖关系见 [dependencies.md](../dependencies.md)。

## 1. 核心引擎（L0–L3）

| 包 | 插件行 | 提供 |
|----|--------|------|
| [core-types.md](core-types.md) `@agentchat/types` | 无（纯契约） | 消息/工具定义/来源元数据核心类型 |
| [core-contracts.md](core-contracts.md) `@agentchat/contracts` | 无（契约） | Tool / CurrentContext / 七类钩子 / InterruptHandler |
| [core-llm.md](core-llm.md) `@agentchat/llm` | `llm/src/plugin` | `ctx.llm`（契约/BaseLLM/ChatStream/注册表） |
| `@agentchat/llm-openai` | `llm-openai/src/plugin` | openai + default 适配器 |
| `@agentchat/llm-deepseek` | `llm-deepseek/src/plugin` | deepseek 适配器 |
| `@agentchat/llm-glm` | `llm-glm/src/plugin` | glm 适配器（智谱 GLM-5.3） |
| `@agentchat/llm-factory` | 无（分发工厂） | `createLLM`（库级 provider 分发） |
| [core-agent-loop.md](core-agent-loop.md) `@agentchat/agent-loop` | `agent-loop/src/plugin` | `ctx.agentLoop`（ReAct 引擎） |
| [core-agent-config.md](core-agent-config.md) `@agentchat/agent-config` | 无（契约 + 校验） | AgentConfig / PluginManifest / 钩子别名 |
| [core-hooks.md](core-hooks.md) `@agentchat/hooks` | `hooks/src/plugin` | `ctx.hooks`（7 类钩子注册中心） |
| [util.md](util.md) `@agentchat/util` | 无（工具库） | 最小日志器 / supervisor 辅助 |

## 2. Agent 域（L2 + 扩展域）

| 包 | 插件行 | 提供 |
|----|--------|------|
| [agents-pkg.md](agents-pkg.md) `@agentchat/agents` | 无（运行库，boot 装配） | AgentAssembly / createAgentContext / Registry / 凭据 |
| [router.md](router.md) `@agentchat/router` | 无（运行库，boot 装配） | AgentRouter / GroupManager / VirtualAgent |
| [agent-prompt.md](agent-prompt.md) | `agent-prompt/src/plugin` | 钩子 `agent-prompt.build-system-prompt` |
| [agent-skill.md](agent-skill.md) | `agent-skill/src/plugin` | 钩子 `agent-skill.discovered_skills` |
| [agent-session.md](agent-session.md) | `agent-session/src/plugin` | 钩子 load-history/save-session/idle-reset/archive-session/log-usage |
| [agent-memory.md](agent-memory.md) | `agent-memory/src/plugin` | 钩子 `agent-memory.load-memory` |
| [agent-mcp.md](agent-mcp.md) | `agent-mcp/src/plugin` | 钩子 `agent-mcp.open-mcp`（MCP 工具发现） |

## 3. 工具基础设施（L5–L7）

| 包 | 插件行 | 提供 |
|----|--------|------|
| [tools.md](tools.md) `@agentchat/tools` | `tools/src/plugin` | `ctx.tools`（注册中心 + ToolContext） |
| [toolkit.md](toolkit.md) `@agentchat/toolkit` | 无（工具库） | defineTool / 沙箱路径 / 命名空间 / token 工具 |
| [edit.md](edit.md) `@agentchat/edit` | 无（引擎包） | Hashline DSL 编辑引擎 + makeEditTool |
| [fs.md](fs.md) `@agentchat/fs` | `fs/src/plugin` | read / write / edit |
| [shell.md](shell.md) `@agentchat/shell` | `shell/src/plugin` | bash |
| [web.md](web.md) `@agentchat/web` | `web/src/plugin` | web_search / browser |

## 4. 工具与服务域（L7–L9）

| 包 | 插件行 | 提供 |
|----|--------|------|
| [dev.md](dev.md) `@agentchat/dev` | `dev/src/plugin` | code_search / read_logs / reload + register_tool / register_plugin / unregister_plugin / publish_plugin |
| [session-tools.md](session-tools.md) | `session-tools/src/plugin` | query_history / continue_turn / inspect_session |
| [restart.md](restart.md) | `restart/src/plugin` | system_restart |
| [interaction.md](interaction.md) | `interaction/src/plugin` | ask_questions |
| [durable-interaction.md](durable-interaction.md) `@agentchat/durable-interaction` | `durable-interaction/src/plugin` | `ctx.durableInteraction`（持久化暂停点/可恢复交互） |
| [math.md](math.md) `@agentchat/math` | `math/src/plugin` | math（vm 沙箱求值） |
| [agent-tools.md](agent-tools.md) | `agent-tools/src/plugin` | send_agent / send_group / list_agents / list_groups / list_tools / read_agent_info / update_agent_profile |
| [timer.md](timer.md) `@agentchat/timer` | `timer/src/plugin` + `timer/src/service-plugin` | timer 工具 + `ctx.timerManager` |
| [subagent.md](subagent.md) `@agentchat/subagent` | `subagent/src/plugin` + `subagent/src/service-plugin` | subagent 工具 + `ctx.subagent` |

## 5. 宿主与装配（L9–L11）

| 包 | 插件行 | 提供 |
|----|--------|------|
| [archive.md](archive.md) `@agentchat/archive` | `archive/src/plugin` | `ctx.archive`（先整理后归档编排） |
| [backup.md](backup.md) `@agentchat/backup` | 无（函数库） | createBackup（weekly 轮转 + zip） |
| [workspace.md](workspace.md) `@agentchat/workspace` | `workspace/src/plugin` | `ctx.workspace`（初始化 + loadAgents） |
| [server.md](server.md) `@agentchat/server` | `http-plugin` + `service-plugin` + `http-routes-plugin` | `ctx.http` / `ctx.l4` / REST + WS |
| [boot.md](boot.md) `@agentchat/boot` | `plugin` + `plugin-finalize` + `plugin-diagnostics` | `ctx.bootstrap` / 装配接线 / 缺口诊断 |
| [plugins.md](plugins.md) `@agentchat/plugins` | `plugins/src/plugin` + `plugins/src/http-plugin` | `ctx.pluginHost` / 插件库 / `/api/plugins` |

## 6. 跨端与 UI

| 包 | 插件行 | 提供 |
|----|--------|------|
| [protocol.md](protocol.md) `@agentchat/protocol` | 无（契约） | 跨端类型 + 插件事件 + UI 扩展契约 |
| [webui.md](webui.md) `@agentchat/webui` | `webui/src/plugin` | HTTP + WS + SPA（3830）+ UI 扩展宿主 |
| [hello.md](hello.md) `@agentchat/hello` | `@agentchat/hello` | 最小 cordis 插件示例（链路验证） |
| [vendor-ecosystem.md](vendor-ecosystem.md) | src/vendor/* | cordis 4 本地生态（8 包） |

## 7. 插件行 → ctx 服务速查

| ctx | 行 | 页 |
|-----|----|----|
| agentLoop | `@agentchat/agent-loop/src/plugin` | core-agent-loop |
| llm | `@agentchat/llm/src/plugin` | core-llm |
| tools | `@agentchat/tools/src/plugin` | tools |
| hooks | `@agentchat/hooks/src/plugin` | core-hooks |
| durableInteraction | `@agentchat/durable-interaction/src/plugin` | durable-interaction |
| pluginHost | `@agentchat/plugins/src/plugin` | plugins |
| http | `@agentchat/server/src/http-plugin` | server |
| bootstrap / agents | `@agentchat/boot/src/plugin` | boot |
| workspace | `@agentchat/workspace/src/plugin` | workspace |
| archive | `@agentchat/archive/src/plugin` | archive |
| timerManager | `@agentchat/timer/src/service-plugin` | timer |
| subagent | `@agentchat/subagent/src/service-plugin` | subagent |
| l4 | `@agentchat/server/src/service-plugin` | server |
| webServerHost | `@agentchat/boot/src/plugin-finalize` | boot |
| webui（可选读取） | webui / plugins 的 WebUIService | webui、plugins |

## 8. 工具速查（v0.6.3 实际注册）

| 工具 | requires | owner 插件行 | 文档 |
|------|----------|--------------|------|
| read / write / edit | base | agentchat-fs-tools | fs |
| bash | base | agentchat-shell-tools | shell |
| web_search | base | agentchat-web-tools | web |
| browser | base | agentchat-web-tools | web |
| code_search / read_logs / reload | dev | agentchat-dev-tools | dev |
| register_tool / register_plugin / unregister_plugin / publish_plugin | admin | agentchat-plugin-tools | dev |
| query_history / continue_turn | base | agentchat-session-tools | session-tools |
| inspect_session | dev | agentchat-session-tools | session-tools |
| system_restart | admin | agentchat-restart-tools | restart |
| ask_questions | base | agentchat-interaction-tools | interaction |
| math | base | agentchat-math | math |
| send_agent / send_group / list_agents / list_groups / list_tools / read_agent_info / update_agent_profile | base | agentchat-agent-tools | agent-tools |
| timer（set/list/disable） | base | agentchat-timer-tools | timer |
| subagent（spawn/list/await/kill） | conductor | agentchat-subagent-tools | subagent |

> `@agentchat/edit` 的 `makeEditTool`（requires: base）由 `@agentchat/fs` 纳入 `makeFileTools`，随 fs 行注册（2026-08-16 起）。详见 [edit.md](edit.md)。旧 `agent` 标签读取时自动归一化为 `base`。

## 9. 钩子速查

| kind | 注册名 | owner | 文档 |
|------|--------|-------|------|
| runStart | agent-mcp.open-mcp | agentchat-agent-mcp | agent-mcp |
| runStart | agent-prompt.build-system-prompt | agentchat-agent-prompt | agent-prompt |
| runStart | agent-skill.discovered_skills | agentchat-agent-skill | agent-skill |
| runStart | agent-memory.load-memory | agentchat-agent-memory | agent-memory |
| runStart | agent-session.load-history | agentchat-agent-session | agent-session |
| runStart（automatic） | agent-session.recover-history | agentchat-agent-session | agent-session |
| stepEnd（automatic） | agent-session.step-persist | agentchat-agent-session | agent-session |
| toolExecutionStart | security.security-check | agentchat-security | [security](../sandbox-security.md) |
| toolExecutionStart（automatic） | agent-session.tool-persist | agentchat-agent-session | agent-session |
| toolExecutionEnd | hooks.log-tool | agentchat-hooks | core-hooks |
| runEnd（automatic） | agent-session.save-session | agentchat-agent-session | agent-session |
| runEnd | agent-session.idle-reset / archive-session / log-usage | agentchat-agent-session | agent-session |

> 说明：security 域的插件文档并入 [sandbox-security.md](../sandbox-security.md)（安全模型+实现）。
