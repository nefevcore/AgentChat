# 第 4 步：工具与钩子

> 目标：理解工具解析三步骤与七类钩子，能自己诊断「工具为什么没出现」。

## 4.1 工具全景

`ctx.tools = ToolsService` 是唯一注册中心。每个工具带 `requires` 标签门控：

| 能力标签 | 解锁工具（节选） |
|----------|------------------|
| `base`（隐式基础） | read、write、edit、bash、web_search、browser、math、query_history、continue_turn、ask_questions、timer、send_agent、send_group、list_agents、list_groups、list_tools、read_agent_info、update_agent_profile |
| `dev` | code_search、read_logs、reload、inspect_session |
| `conductor` | subagent（spawn/list/await/kill） |
| `admin` | system_restart、register_tool、register_plugin、unregister_plugin、publish_plugin |

> ✅ fs 行注册 read/write/edit：edit 引擎（`makeEditTool`）由 `@agentchat/fs` 的 `makeFileTools` 一并返回（见 [plugins/edit.md](../plugins/edit.md)）。

## 4.2 解析三步骤（写进 ToolsService.resolveTools）

1. **presets 过滤**：`config.presets` 决定哪些 owner（插件名）参与烘焙；presets 缺省 = 旧契约不过滤。
2. **requires 权限门禁**：`requires` 非空且全部命中能力标签（含隐式 `base`；旧 `agent` 自动归一化）才可用；门禁不通过，include 也无效。
3. **tools 意图覆盖**：`tools.include` 显式启用（默认关闭的工具）、`tools.exclude` 显式停用；`exclude > include > 默认`。

诊断口诀：**工具不出现 → list_tools 看启用集 → 查 tags → 查 requires → 查 presets → 查 tools.exclude → 查插件行是否挂载**。

## 4.3 一次工具调用发生了什么

```
LLM 返回 tool_calls[name, arguments]
→ loop 检查 tools Map → toolExecutionStart 钩子（security.security-check）
→ execute(args, stream, signal)（并行/串行按 loop 策略）
→ 结果重排为 tool 消息 → toolExecutionEnd 钩子（hooks.log-tool）
→ 下一步 LLM 看到结果继续推理
```

流式事件（WS 广播）：`chat.toolcall.*`（LLM 的调用意图）与 `chat.tool_execution.*`（真实执行进度/结果）。

## 4.4 七类钩子

| kind | 时机 | 内置实现 |
|------|------|----------|
| runStart | 整次执行开始 | `agent-mcp.open-mcp` → `agent-prompt.build-system-prompt` → `agent-memory.load-memory` → `agent-session.load-history`（顺序由 config.hooks 决定） |
| runEnd | 整次执行结束 | `agent-session.save-session` / `idle-reset` / `archive-session` / `log-usage` |
| stepStart / stepEnd | 每个 ReAct step（一次 LLM + 工具批）前后 | 内置暂无 |
| toolExecutionStart | 工具执行前 | `security.security-check` |
| toolExecutionEnd | 工具执行后 | `hooks.log-tool` |
| fallback | 失败路径兜底 | 内置暂无 |

钩子实现是**工厂**：`(config, services) => hook`。`config.hooks` 只是名字顺序表——执行顺序完全由配置控制，注册中心按名解析。

## 4.5 动手实验

1. 对 Agent 说 `list_tools`，记录它当前的工具集。
2. 改 tags（WebUI Agent 设置里加/删 `dev`），`reload(scope=global)`，再看 `list_tools` 变化。
3. 故意把 `security.security-check` 从 `hooks.toolExecutionStart` 里去掉，尝试 `write` 到 `agents/` 目录——对比有/无检查时行为差异（注意恢复）。
4. 观察一次 `read` 的日志：`[hooks] 工具 read 完成，耗时 xx ms`。

## 4.6 相关源码

- 注册中心：`src/tools/tools/src/service.ts`
- 钩子中心：`src/core/hooks/src/service.ts`
- 工具定义工厂：`src/toolkit/toolkit/src/define-tool.ts`
- 各域注册：`src/{fs,shell,web,dev,session-tools,restart,interaction,math,agent-tools}/**/register.ts`

## 下一步

[第 5 步：多 Agent 通信](05-multi-agent-communication.md)
