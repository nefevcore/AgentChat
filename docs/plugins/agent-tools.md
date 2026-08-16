# @agentchat/agent-tools
> 包路径 `src/agent-tools/agent-tools` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
多 Agent 协作工具包。提供 7 个协作工具：send_agent / send_group / list_agents / list_groups / list_tools / read_agent_info / update_agent_profile。身份（`from=config.agent_id`）由工具工厂闭包烘焙，替代旧拦截器；router 经 ToolContext 注入。领域独立。

## 目录（关键源文件 + 一句话）
| 文件 | 说明 |
| --- | --- |
| plugin.ts | cordis 插件行，注册协作工具 |
| register.ts | `registerAgentTools(tools, owner)` 工厂注册入口 |
| tools.ts | 7 个协作工具实现与 `makeAgentTools` 工厂 |

## 插件行
| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| plugin.ts | agentchat-agent-tools | tools | 经 `registerAgentTools` 注册 7 个协作工具（per-Agent 工厂烘焙） |

## 提供的能力
### 工具表
| 工具 | label | requires | 要点 |
| --- | --- | --- | --- |
| send_agent | 发送给 Agent | base | 异步默认 + wait=true 阻塞等待 |
| send_group | 发送到群组 | base | 群发并触发参与者 |
| list_agents | Agent 清单 | base | 列出 ID/名称/虚拟或真实 |
| list_groups | 群组清单 | base | 列出本 Agent 所在群组 |
| list_tools | 工具清单 | base | 列出当前实际启用工具 |
| read_agent_info | 读取 Agent 信息 | base | 公开信息；查他人附加印象 |
| update_agent_profile | 更新个人档案 | base | 更新档案字段并落盘 |

## 工具参考
| 工具 | name | label | requires | 主要参数 | 行为要点 |
| --- | --- | --- | --- | --- | --- |
| send_agent | send_agent | 发送给 Agent | base | to（必填）、message（必填）、wait（默认 false）、no_wait（旧名，默认 true） | 消息 `{from, to, type:'request', payload: message}`；`shouldWait = wait===true \|\| no_wait===false`；wait 时 `router.send(msg)` 阻塞等回复，否则 `router.send(msg, { wait: false })` 异步投递 |
| send_group | send_group | 发送到群组 | base | group_id（必填）、message（必填） | `groupManager.deliverGroupMessage({from, to:'*', type:'chat.send', payload, group_id})`；返回触发参与者数量 |
| list_agents | list_agents | Agent 清单 | base | 无 | `registry.listIds()` 遍历，输出 `- id: name（虚拟/Agent）` |
| list_groups | list_groups | 群组清单 | base | 无 | `groupManager.listGroupsForAgent(config.agent_id)`，输出 group_id、名称、参与者 |
| list_tools | list_tools | 工具清单 | base | 无 | 优先读 `services.tools`（resolveTools 完整结果，含 requires 默认启用）；缺省回退 `effectiveToolOverrides(config).include` |
| read_agent_info | read_agent_info | 读取 Agent 信息 | base | agent_id（可选，默认自己） | `registry.get(target)` 输出 agent_id/name/type/tags；仅查自己返回 llm；查他人额外返回 `loadMemory(chatDialogKey(selfId,target), selfId)` 的印象 |
| update_agent_profile | update_agent_profile | 更新个人档案 | base | agent_id（可选，默认自己；仅 admin 可指定他人）、fields（必填） | 允许字段：name/description/persona/avatar/tags/presets/tools/hooks；persona 写 `AGENT.md`（保留标题行），其余字段更新 registry 内存并落盘 `config.json`；不允许修改 agent_id 与 system_prompt |

## 关键契约 / API
```ts
registerAgentTools(tools: ToolsService, owner: string): void
// 工厂：makeAgentTools(config, services) → [send_agent, send_group, list_agents,
//        list_groups, list_tools, read_agent_info, update_agent_profile]
```
- 身份防伪造：`from = config.agent_id` 在工厂闭包内烘焙，LLM 无法经参数覆盖。
- `send_agent` 的 `wait` 为新规范参数，`no_wait` 为旧名别名（`no_wait=false` 表示等待）；异步模式下对方回复会作为新消息送达调用方。
- `send_group` 消息类型为 `chat.send`，`to:'*'`，返回 `result.triggered.length` 个参与者被触发。
- `list_tools` 的 `services.tools` 由 L5 每次投递写入 resolveTools 完整结果（自动注入 + 显式声明）。
- `read_agent_info` 查他人不暴露对方 LLM 配置；印象来自 `files/<self>/memory/<target>.memory.md`。
- `update_agent_profile`：`fields` 为键值对；`hooks` 支持七类钩子顺序表（runStart/runEnd/stepStart/stepEnd/toolExecutionStart/toolExecutionEnd/fallback）；定位 Agent 目录时扫描 `<agentsDir>/*/config.json` 匹配 `agent_id`；任何配置字段落盘失败会返回错误。

## 配置
本包无自有命名空间。相关位置：
- Agent 目录：`<agentsDir>/<agentId>/config.json`（update_agent_profile 落盘，按 agent_id 扫描匹配目录）。
- 人物设定：`<agentsDir>/<agentId>/AGENT.md`（persona 字段写入，保留首行标题）。
- 印象记忆：`files/<self>/memory/<target>.memory.md`（read_agent_info 读取，经 `loadMemory`）。
- `update_agent_profile` 允许字段白名单：`name`、`description`、`persona`、`avatar`、`tags`、`presets`、`tools`、`hooks`。

## 与其他插件的关系
package.json 依赖：`@agentchat/agent-loop`、`@agentchat/agent-memory`、`@agentchat/toolkit`、`@agentchat/tools`、`@agentchat/agent-config`。

使用方：工具经 `ctx.tools` 注册；运行期依赖 ToolContext 注入的 `services.router`（registry + groupManager）与 `services.tools`；`read_agent_info` 依赖 `@agentchat/agent-memory` 的 `loadMemory`。

## 行为细节
- `send_agent` 异步模式（默认）为 fire-and-forget，立即返回；对方回复会作为新消息送达调用方，无需等待。
- `list_agents` 输出示例：`共 N 个 Agent` 后逐行 `- id: 名称（虚拟/Agent）`。
- `read_agent_info` 的 `type` 字段：`info.virtual` 为 true 时输出「虚拟」，否则「Agent」。
- `update_agent_profile` 的 `tags` 使用受控能力词汇表 `base/dev/admin/conductor`（旧 `agent` 自动归一化为 `base`）；`tools` 为 `{ include, exclude }` 工具意图覆盖（exclude 优先；旧 `string[]` 自动迁移为 include）；`presets` 顺序无意义；`hooks` 为启用清单，数组顺序即执行顺序、不在清单里即停用。
- 更新失败语义：registry 未找到返回错误；内存已更新但落盘失败会返回「重启后丢失」警告；persona 为空字符串返回错误。
- `effectiveToolOverrides(config)` 为旧契约兼容回退（`plugins` 聚合 + 旧 `disabledTools` 并入 exclude）。
- 所有工具在 factory 中按 Agent 烘焙，`services`（router/groupManager/tools）来自 ToolContext 注入。

## 测试
package.json 仅 `typecheck`（tsc --noEmit），无 test 脚本。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
