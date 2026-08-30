# AgentChat 配置参考

> 版本：v0.6.2（2026-08-15）。配置分两层：**全局配置** `workspace/default/config.json` 与 **Agent 配置** `workspace/default/agents/<dir>/config.json`。
> 合并顺序：代码默认值 → 全局配置 → Agent 差异配置（deepMerge）。LLM 与搜索配置另有池解析。

---

## 1. Agent 配置（config.json）

### 1.1 基础字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_id` | string | 唯一标识（决定存储路径与会话键；旧 API 曾写作 `id`） |
| `name` | string | 显示名称 |
| `avatar` | string | 头像文件名（放在 Agent 目录下） |
| `description` | string | 简介（列表/档案展示） |
| `virtual` | boolean | 虚拟 Agent（如 user），无 LLM，仅路由端点 |
| `tags` | string[] | 能力标签；受控词汇表 `base/dev/admin/conductor`（`base` 隐式，旧 `agent` 归一化），工具 `requires` 按 AND 语义匹配 |
| `llm` | string \| object | LLM 池引用 / 内嵌配置（见 §3） |
| `allowedPaths` / `security.allowedPaths` | string[] | 路径沙箱白名单（write/edit/bash 共享管控；见 [sandbox-security.md](sandbox-security.md)） |
| `maxSteps` | number | 单次执行最大 ReAct 步数（防失控） |
| `deepThink` | boolean | 深度思考默认开关 |

### 1.2 新契约：presets / tools / hooks（v0.6.2 推荐）

```json
{
  "agent_id": "my_agent",
  "name": "我的助手",
  "tags": ["dev"],
  "presets": [
    "agentchat-fs-tools",
    "agentchat-shell-tools",
    "agentchat-agent-prompt",
    "agentchat-agent-session"
  ],
  "tools": {
    "include": ["read"],
    "exclude": ["write", "bash"]
  },
  "hooks": {
    "runStart": ["agent-prompt.build-system-prompt", "agent-session.load-history"],
    "toolExecutionStart": ["security.security-check"],
    "toolExecutionEnd": ["hooks.log-tool"],
    "runEnd": ["agent-session.save-session", "agent-session.log-usage"]
  }
}
```

| 字段 | 语义 |
|------|------|
| `presets` | 启用哪些插件（= 工具/钩子注册的 owner = cordis 插件名）。**缺省 = 旧契约兼容（不过滤 owner）** |
| `tools.include` | 显式启用的工具名（默认关闭的工具——如 `requires` 为空——只能在此启用） |
| `tools.exclude` | 显式停用的工具名；优先级最高，覆盖 `include` 与默认启用 |
| `hooks` | 七类钩子的**启用清单**（`runStart / runEnd / stepStart / stepEnd / toolExecutionStart / toolExecutionEnd / fallback`），数组顺序即执行顺序；**不在清单里 = 停用**；未注册/插件未启用的名字自动跳过 |

**默认启用**：启用插件后，`requires` 非空且全部命中能力标签的工具默认开启。受控词汇表为 `base / dev / admin / conductor`：`base` 是隐式基础能力层（人人可用），`dev / conductor / admin` 需对应标签；旧 `agent` 标签读取时自动归一化为 `base`。`tags` 只做权限门禁，不再作为独立开关。旧字段 `tools: string[]`、`disabledTools`、`disabledHooks` 仍可读入，保存时自动迁移为新契约。

### 1.3 旧契约：plugins（兼容保留）

存量配置仍可写 `plugins: [{ name: "builtin", tools: [...], runStart: [...] }]`，装配层在 `presets/tools/hooks` 缺省时自动聚合回退。旧钩子名 `builtin.*` 经 `LEGACY_HOOK_ALIASES` 归一化到新域名（如 `builtin.save-session` → `agent-session.save-session`），完整映射见 [plugins/core-agent-config.md](plugins/core-agent-config.md)。**新配置请直接使用新契约。**

### 1.4 命名空间（写在 Agent 配置里）

| 命名空间 | 字段（默认值） | 说明 |
|----------|----------------|------|
| `agent.session` | `maxContextTokens`(1000000)、`keepRecentRatio`(0.03)、`summaryPreviewLen`(4000)、`idleArchiveSec`(14400)、`messageQueryDefaultLimit`(20)、`archiveTokenRatio`(0.5) | 会话历史/归档 |
| `agent.memory` | `memoryBudgetTokens`(10000)、`memoryMaxTokens`(15000，0=不限制) | 记忆注入预算与 memory.md 硬上限 |
| `agent.mcp` | `mcp`(true/false)、`mcpFile`、`cacheTtlMs`(300000) | MCP 服务器发现 |
| `tool.bash` | `defaultTimeout`(30000)、`maxTimeout`(120000)、`outputMaxLen`(50000)、`maxBuffer`(10485760) | bash 超时/输出限制（timeout 已执行；outputMaxLen/maxBuffer 当前仅表单声明，未强制截断） |
| `tool.web_search` | `provider`、`$ref`、provider 专属字段（tavily/serpapi/brave/duckduckgo） | 搜索 provider 配置与池引用 |
| `security` | `allowedPaths: string[]` | 路径穿透白名单 |
| `timer` | `entries: TimerEntry[]` | 预定义定时任务（见 §5） |

配置项按「含 `.` 的顶层键」解析进 `namespaces`，再在 Agent 装配时作为命名空间键可用（如 `getNamespaceConfig(config, 'tool.bash')`）。

---

## 2. 全局配置（workspace/default/config.json）

### 2.1 顶层字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `timezone` | `Asia/Shanghai` | 定时/报时使用的时区 |
| `maxHops` | 5 | 消息最大跳数（当前为配置默认值；v0.6.2 的 AgentRouter 暂未消费） |
| `messageQueryDefaultLimit` | 20 | 历史查询默认条数 |
| `llmProviders` | `{}` | LLM 模型池（见 §3） |
| `searchProviders` | `{}` | 搜索 provider 池（见 §4） |
| `timer`（兼容 `chime`） | 见 §5 | 全局定时任务表 |
| `workspaceDir` | `workspace/default` | 工作区路径（相对 cwd；`AGENTCHAT_WORKSPACE` 环境变量优先） |

`agentsDir / sessionsDir / groupsDir` 由 `workspaceDir` 派生（`<ws>/agents|sessions|groups`），通常无需手动指定。

### 2.2 命名空间键

全局配置同样支持 `"agent.session"`、`"tool.bash"` 等含点键，会并入 `namespaces` 供所有 Agent 继承；Agent 差异配置可整体覆盖。

---

## 3. LLM 配置与模型池

### 3.1 池声明

```json
"llmProviders": {
  "deepseek-v4-flash": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "thinking": true,
    "reasoning_effort": "high",
    "default": true
  },
  "deepseek-v4-pro": { "provider": "deepseek", "model": "deepseek-v4-pro" },
  "glm-5.3": { "provider": "glm", "base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-5.3", "reasoning_effort": "max" }
}
```

### 3.2 Agent 引用形式

| 写法 | 语义 |
|------|------|
| 不写 `llm` | 池中 `default:true` 条目，否则池第一项 |
| `"llm": "deepseek-v4-pro"` | 纯池引用 |
| `"llm": { "$ref": "deepseek-v4-pro", "temperature": 0.3 }` | 引用 + 覆盖 |
| `"llm": { "provider": "openai", "model": "gpt-4o" }` | 内嵌配置 |
| `"llm": { "model": "deepseek-v4-pro" }` | model 名命中池条目时自动解析为池引用 |

### 3.3 LLMConfig 字段

`provider`（openai/deepseek/glm/ollama）、`api_key`（支持 `${ENV_VAR}`）、`base_url`、`model`、`temperature`、`max_tokens`、`top_p`、`response_format`（text/json_object）、`stop`；DeepSeek 专有：`reasoning_effort`（high/max）、`thinking`、`logprobs`、`top_logprobs`、`tool_choice`（none/auto/required）；GLM 专有：`thinking`（glm-5.3/glm-4.7 强制思考，关闭无效）、`reasoning_effort`（low/high/max，默认 max）。GLM 注意事项：`tool_choice` 仅支持 auto（配置不生效）、`stop` 最多 4 个、`temperature` 取值 [0,1]。

### 3.4 凭据

凭据统一存 `~/.agentchat/credentials.json`（AES-256-GCM，绑定本机）。查找顺序：**Agent 级 → 全局级 → 池条目中的 api_key 字段**；WebUI「全局设置」可配置并自动抽取明文进凭据库。`${ENV_VAR}` 环境变量引用在配置加载时解析。

---

## 4. 搜索 provider 池

```json
"searchProviders": {
  "tavily-free": {
    "provider": "tavily",
    "defaultResults": 5,
    "defaultDepth": "advanced",
    "defaultTopic": "general",
    "rawContentMaxLen": 2000,
    "default": true
  }
}
```

Agent 侧通过 `"tool.web_search"` 命名空间引用：`{ "$ref": "tavily-free" }`，或内嵌 provider 配置（tavily/serpapi/brave/duckduckgo）。无显式配置时自动合并池 default/首项。搜索响应会透传 provider 的 `credits_used`（Tavily 有值，其余为 null），但 v0.6.2 源码未做 quota/creditsFile 额度强制。

---

## 5. 定时任务配置

### 5.1 全局 timer（原 chime 泛化）

```json
"timer": {
  "enabled": true,
  "tasks": [
    { "time": "08:00", "hint": "现在是 {{time}}，早安报时。请简要汇报今日计划与待办。" },
    { "time": "23:30", "targets": ["*"], "hint": "__archive_all__", "builtin": true },
    { "time": "04:00", "targets": ["*"], "hint": "__backup_all__", "builtin": true }
  ]
}
```

### 5.2 Agent 预定义条目

```json
"timer": {
  "entries": [
    { "id": "morning", "enabled": true, "mode": "workday", "time": "09:00",
      "hint": "查询今日新闻热点", "target": "user" }
  ]
}
```

| mode | 时间参数 | 说明 |
|------|---------|------|
| `delay` | `delay`（如 "1h"） | 固定间隔 |
| `random` | `delay_min` / `delay_max` | 随机间隔 |
| `time` | `time`（"08:00"） | 每天定点 |
| `workday` | `time` | 工作日（基于 chinese-lunar + `agent.timer.holidays/makeupWorkdays` 覆盖） |
| `holiday` | `time` | 节假日 |

运行时由 Agent 使用 `timer` 工具（action: set/list/disable）管理，见 [plugins/timer.md](plugins/timer.md)。

---

## 6. 常用示例：完整全局配置

```json
{
  "timezone": "Asia/Shanghai",
  "maxHops": 5,
  "llmProviders": { "deepseek-v4-flash": { "provider": "deepseek", "model": "deepseek-v4-flash", "default": true } },
  "searchProviders": { "tavily-free": { "provider": "tavily", "default": true } },
  "agent.session": { "maxContextTokens": 1000000, "archiveTokenRatio": 0.5 },
  "agent.memory": { "memoryBudgetTokens": 10000, "memoryMaxTokens": 15000 },
  "agent.mcp": { "mcp": true, "mcpFile": "C:\\path\\mcp.json" },
  "tool.bash": { "defaultTimeout": 30000, "maxTimeout": 120000 },
  "tool.web_search": { "$ref": "tavily-free" },
  "security": { "allowedPaths": ["C:/path/to/project"] },
  "timer": { "enabled": true, "tasks": [] }
}
```

> 更多配置项与含义以各插件文档为准：[agent-session](plugins/agent-session.md)、[agent-memory](plugins/agent-memory.md)、[agent-mcp](plugins/agent-mcp.md)、[shell](plugins/shell.md)、[web](plugins/web.md)、[timer](plugins/timer.md)。
