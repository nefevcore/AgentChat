# 第 3 步：Agent 配置详解

> 目标：吃透 `config.json` 的每个字段，会写 tags / presets / tools / hooks 新契约。

## 3.1 合并模型

```
代码默认值 → workspace/default/config.json（全局） → agents/<dir>/config.json（Agent 差异）
```

`AgentLoader.loadOne()` 用 `deepMerge` 合并；`llm` 与 `tool.web_search` 还会经过池解析（§3.4）。

## 3.2 基础字段

| 字段 | 说明 |
|------|------|
| `agent_id` | 唯一 ID，决定会话键 `chat~<lo>~<hi>` 与存储路径 |
| `name` / `description` / `avatar` | 展示信息 |
| `tags` | 能力标签数组；工具 `requires` 按 AND 匹配 |
| `virtual` | true = 无 LLM 的路由端点（user） |
| `llm` | 池引用 / 内嵌 / 引用+覆盖 |
| `maxSteps` / `deepThink` | 执行上限 / 思考开关 |

## 3.3 新契约三件套

```json
{
  "presets": ["agentchat-fs-tools", "agentchat-agent-session"],
  "tools": { "include": ["math"], "exclude": ["bash"] },
  "hooks": {
    "runStart": ["agent-session.load-history"],
    "runEnd": ["agent-session.save-session", "agent-session.log-usage"]
  }
}
```

- **presets**：启用哪些插件。每个插件的 `name` 就是它注册工具/钩子时的 `owner`；`ctx.tools.resolveTools` 和 `ctx.hooks.collect` 都按 presets 过滤候选。
  - presets **缺省** = 旧契约兼容（不过滤 owner，全部参与）。
- **tools**：`{ include, exclude }` 工具意图覆盖。启用插件后 `requires` 命中能力标签的工具默认开启（`base` 隐式，旧 `agent` 自动归一化）；`requires` 为空的工具默认关闭，只能 include 启用；exclude 优先级最高。
- **hooks**：七类**启用清单**（`runStart / runEnd / stepStart / stepEnd / toolExecutionStart / toolExecutionEnd / fallback`）。**数组顺序 = 执行顺序；不在清单里 = 停用**；未注册名字自动跳过（可以先写配置后装插件）。

## 3.4 LLM 配置四种写法

```json
// 不写：池 default 条目，否则池第一项
"llm": "deepseek-v4-pro",
"llm": { "$ref": "deepseek-v4-pro", "temperature": 0.3 },
"llm": { "provider": "openai", "model": "gpt-4o", "base_url": "https://..." }
```

特殊：`{ "model": "deepseek-v4-pro" }` 且 model 名命中池条目时，自动解析为池引用。

## 3.5 命名空间配置

含 `.` 的顶层键按命名空间解析，放在全局或 Agent 配置均可（Agent 覆盖全局）：

```json
{
  "agent.session": { "maxContextTokens": 1000000, "archiveTokenRatio": 0.5 },
  "agent.memory": { "memoryBudgetTokens": 10000, "memoryMaxTokens": 15000 },
  "agent.mcp": { "mcp": true, "mcpFile": "C:\\path\\mcp.json" },
  "tool.bash": { "defaultTimeout": 30000, "maxTimeout": 120000 },
  "tool.web_search": { "$ref": "tavily-free" },
  "security": { "allowedPaths": ["C:/path/to/project"] },
  "timer": { "entries": [] }
}
```

完整字段与默认值见 [configuration.md](../configuration.md)。

## 3.6 旧契约迁移（知道即可）

存量配置：

```json
"plugins": [
  { "name": "builtin",
    "tools": ["read"],
    "runStart": ["builtin.build-system-prompt", "builtin.load-history"],
    "runEnd": ["builtin.save-session"] }
]
```

装配层在 `presets/tools/hooks` 缺省时聚合旧 `plugins`；`builtin.*` 钩子名经 `LEGACY_HOOK_ALIASES`（12 条映射）归一化到 `agent-*.*` / `security.*` / `hooks.*`。**新配置直接用新契约。**

## 3.7 练习

1. 给 Agent 加 `"dev"` tag，`reload` 后用 `list_tools` 对比新增了哪些工具（read_logs/reload/reload_modules）。
2. 把 `hooks.runEnd` 顺序改成 `["agent-session.log-usage", "agent-session.save-session"]`，从日志观察执行顺序。
3. 给 `admin` 标签试 `system_restart`（确认 Supervisor 会自动拉起进程）。

## 下一步

[第 4 步：工具与钩子](04-tools-and-hooks.md)
