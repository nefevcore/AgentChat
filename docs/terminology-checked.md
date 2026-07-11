# AgentChat 扩展 & 工具 & 字段 表述清单

> 整理日期：2026-07-11 | 用于统一审校中文标签、描述和字段命名

---

## 一、扩展 (Extensions)

### 1. agent-session（Agent 会话）
| 项目 | 当前值 |
|------|--------|
| **name** | `agent-session` |
| **label** | `会话` |
| **description** | `管理对话历史、上下文压缩和 Token 用量追踪。` |
| **ns** | `extension.agent_session` |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `maxContextTokens` | `最大上下文长度` | `设定会话上下文长度` | number | 100000 |
| `keepRecentRatio` | `留存消息比例` | `归档时保留的最近消息比例` | number | 0.10 |
| `summaryPreviewLen` | `压缩后的上下文长度` | `TODO: 这个应该是压缩后的上下文长度` | number | 200 |
| `idleArchiveSec` | `空闲归档时间` | `无对话自动归档的等待时间` | number | 1800 |
| `messageQueryDefaultLimit` | `历史查询默认条数` | `加载历史消息的默认数量` | number | 50 |

---

### 2. agent-memory（Agent 记忆）
| 项目 | 当前值 |
|------|--------|
| **name** | `agent-memory` |
| **label** | `记忆` |
| **description** | `提取跨会话的偏好、决策、待办事项和用户画像。` |
| **ns** | `extension.agent_memory` |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `maxMemoryFacts` | `最大记忆数量` | `长期记忆的最大事实条数` | number | 50 |

**类型字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `MemoryEntry.id` | string | 条目唯一标识 |
| `MemoryEntry.content` | string | 条目内容 |
| `MemoryEntry.created_at` | string | 创建时间 |
| `MemoryEntry.updated_at` | string | 最后更新时间 |

---

### 3. agent-prompt（Agent 提示词）
| 项目 | 当前值 |
|------|--------|
| **name** | `agent-prompt` |
| **label** | `系统提示词` |
| **description** | `工具、MCP工具、动态指引、技能清单、系统环境、日期 + SYSTEM.md覆盖 / AGENT.md追加。` |
| **ns** | `extension.agent_prompt` |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `tools` | `工具` | `启用工具定义列表装配` | checkbox | true |
| `mcp` | `MCP` | `启用 MCP 工具和资源发现` | checkbox | true |
| `skills` | `技能` | `启用技能清单装配` | checkbox | true |
| `guidelines` | `工具使用指南` | `启用动态指引装配` | checkbox | true |
| `windowsEnv` | `系统环境` | `启用系统环境信息注入` | checkbox | true |
| `datetime` | `日期` | `启用当前日期注入` | checkbox | true |

---

## 二、工具 (Tools)

### 1. bash（Bash 终端）
| 项目 | 当前值 |
|------|--------|
| **name** | `bash` |
| **label** | `终端` |
| **definition.description** | `执行 Shell 命令` |
| **ns** | `tool.bash` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `command` | string | ✅ | 要执行的命令。 |
| `timeout` | number | ❌ | 超时毫秒数，默认 30000。 |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `defaultTimeout` | `默认超时 (ms)` | — | number | 30000 |
| `maxTimeout` | `最大超时 (ms)` | — | number | 120000 |
| `outputMaxLen` | `输出最大长度` | — | number | 50000 |
| `maxBuffer` | `最大缓冲区 (bytes)` | — | number | 10485760 |

---

### 2. edit（编辑文件）
| 项目 | 当前值 |
|------|--------|
| **name** | `edit` |
| **label** | `编辑文件` |
| **description** | `精确编辑文件中的指定文本片段。` |
| **ns** | `tool.edit` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `filePath` | string | ✅ | 文件路径。 |
| `edits` | array | ✅ | 替换列表，每项含 oldText 和 newText。 |
| `edits[].oldText` | string | ✅ | 要被替换的原文本，必须唯一。 |
| `edits[].newText` | string | ✅ | 替换后的新文本。 |

---

### 3. list_agents（列出 Agent）
| 项目 | 当前值 |
|------|--------|
| **name** | `list_agents` |
| **label** | `Agent清单` |
| **description** | `列出所有可用的 Agent 及其描述。` |
| **ns** | `tool.list_agents` |

**工具参数：** 无

---

### 4. math（数学计算）
| 项目 | 当前值 |
|------|--------|
| **name** | `math` |
| **label** | `计算器` |
| **description** | `执行数学表达式计算。` |
| **ns** | `tool.math` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `expression` | string | ✅ | 要计算的数学表达式，例如 "1 + 2 * 3"、"sqrt(16)"、"sin(pi/2)"。 |

---

### 5. read（读取文件）
| 项目 | 当前值 |
|------|--------|
| **name** | `read` |
| **label** | `读取文件` |
| **description** | `读取文件内容或列出目录结构。` |
| **ns** | `tool.read` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `filePath` | string | ✅ | 文件或目录路径。 |
| `startLine` | number | ❌ | 起始行号（1-based），默认 1。 |
| `endLine` | number | ❌ | 结束行号（1-based），默认文件末尾。 |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `maxLines` | `最大读取行数` | — | number | 2000 |
| `maxBytes` | `最大读取字节数` | — | number | 51200 |

---

### 6. send_agent（发送消息）
| 项目 | 当前值 |
|------|--------|
| **name** | `send_agent` |
| **label** | `发送消息` |
| **description** | `向其他 Agent 发送消息并获取回复。` |
| **ns** | `tool.send_agent` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `to` | string | ✅ | 目标 Agent 的 ID（可通过 list_agents 获取可用清单） |
| `message` | string | ✅ | 要发送给目标 Agent 的消息内容 |

---

### 7. web_search（网络搜索）
| 项目 | 当前值 |
|------|--------|
| **name** | `web_search` |
| **label** | `网络搜索` |
| **description** | `实时网络搜索` |
| **ns** | `tool.web_search` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `query` | string | ✅ | 搜索查询字符串。建议使用自然语言描述你想查找的内容。 |
| `search_depth` | string | ❌ | 搜索结果深度。枚举：basic / advanced / fast / ultra-fast |
| `max_results` | number | ❌ | 最大返回结果数（1-20），默认 5。 |
| `topic` | string | ❌ | 搜索类别。枚举：general / news / finance |
| `include_domains` | array | ❌ | 限定在这些域名内搜索，最多 300 个。 |
| `exclude_domains` | array | ❌ | 从搜索结果中排除这些域名，最多 150 个。 |
| `time_range` | string | ❌ | 按发布日期过滤。枚举：day / week / month / year / d / w / m / y |
| `include_answer` | boolean | ❌ | 是否在结果中包含 LLM 生成的简短答案摘要。默认 false。 |
| `include_raw_content` | boolean | ❌ | 是否包含搜索结果的原始页面内容（Markdown 格式）。默认 false。 |

**配置字段：**

| 字段名 | 标签 | 描述 | 类型 | 默认值 | 可选值 |
|--------|------|------|------|--------|--------|
| `defaultResults` | `默认结果数` | — | number | 5 | — |
| `defaultDepth` | `搜索深度` | — | select | advanced | 基础/高级/快速/极速 |
| `defaultTopic` | `搜索类别` | — | select | general | 通用/新闻/财经 |
| `rawContentMaxLen` | `内容截断长度` | — | number | 2000 | — |

---

### 8. write（写入文件）
| 项目 | 当前值 |
|------|--------|
| **name** | `write` |
| **label** | `写入文件` |
| **description** | `将内容写入文件或创建目录。` |
| **definition.description** | `在工作区中创建或覆盖写入文件` |
| **ns** | `tool.write` |

**工具参数：**

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| `filePath` | string | ✅ | 要写入的文件路径。以 / 结尾表示创建目录。 |
| `content` | string | ❌ | 要写入文件的内容（创建目录时无需提供）。 |

---

## 三、拦截器 (Interceptors)

### send_agent_from
| 项目 | 当前值 |
|------|--------|
| **路径** | `src/global/interceptors/send_agent_from/interceptor.ts` |
| **作用** | 自动注入调用方 agentId 到 send_agent 的 args.from，Agent无法伪造身份。 |

---

## 四、核心类型字段 (src/core/types.ts)

### Message（通用消息结构）
| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `MessageRole` | system / user / assistant / tool / error |
| `content` | string | 消息正文 |
| `agent_id` | string? | 消息来源 Agent ID |
| `name` | string? | 参与者名称（tool 角色消息中提供函数名） |
| `tool_calls` | `ToolCall[]`? | LLM 工具调用 |
| `tool_call_id` | string? | 工具调用关联 ID |
| `reasoning_content` | string? | 思维链/推理内容 (DeepSeek R1 等) |
| `label` | string? | 展示标签 |

### AgentContext（Agent 上下文）
| 字段 | 类型 | 说明 |
|------|------|------|
| `sender` | string | 消息发起方 Agent ID |
| `receiver` | string | 消息接收方 Agent ID |
| `systemPrompt` | string | 系统提示词 |
| `history` | `Message[]` | 对话历史 |
| `currentMessage` | `Message`? | 当前用户消息（ReAct 循环中的当前轮次） |
| `agentConfig` | `AgentConfig`? | 完整 Agent 配置 |
| `runtimeConfig` | `Record<string, Record<string, unknown>>`? | Agent 级运行时配置覆盖 |
| `loopMessages` | `Message[]`? | 本轮 ReAct 循环产生的完整消息 |
| `llm` | `LLMProvider`? | Agent 的 LLM 实例 |
| `llmConfig` | `LLMConfig`? | Agent 的 LLM 配置 |
| `cumulativeUsage` | `LLMUsage`? | 本轮累计 Token 用量 |
| `availableTools` | `Array<{name, displayName?, description}>`? | 本轮可用工具概览 |
| `meta` | `Record<string, unknown>`? | 扩展间共享元数据 |

### LLMRequest（LLM 调用请求）
| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 消息列表 |
| `tools` | `ToolDefinition[]`? | 可用工具定义 |
| `thinking` | boolean? | 是否启用深度思考模式 |
| `userId` | string? | 业务侧用户标识（用于 DeepSeek API 限速隔离） |

### LLMResponse（LLM 调用响应）
| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string \| null` | 响应正文 |
| `toolCalls` | `ToolCall[]` | 工具调用列表 |
| `finishReason` | `'stop' \| 'tool_calls' \| 'length' \| 'error'` | 结束原因 |
| `reasoning` | string? | 思维链/推理内容 |
| `usage` | `LLMUsage`? | Token 用量 |

### LLMUsage（Token 用量统计）
| 字段 | 类型 | 说明 |
|------|------|------|
| `prompt_tokens` | number | 提示词（输入）token 数 |
| `completion_tokens` | number | 补全（输出）token 数 |
| `total_tokens` | number | 总 token 数 |
| `prompt_cache_hit_tokens` | number? | [DeepSeek] 缓存命中的输入 token 数 |
| `prompt_cache_miss_tokens` | number? | [DeepSeek] 缓存未命中的输入 token 数 |

### StreamToken（流式 token）
| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `thinking_start \| thinking_update \| thinking_end \| message_start \| message_update \| message_end \| toolcall_start \| toolcall_update \| toolcall_end \| error` | token 类型 |
| `delta` | string? | 增量文本 |
| `partial` | `{content, reasoning}` | 累计状态 |
| `toolCall` | `{index, id?, name?, arguments?}`? | 工具调用增量信息 |
| `error` | string? | 错误描述 |
| `usage` | `LLMUsage`? | Token 用量 |

### ToolDefinition（工具定义）
| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'function'` | 固定值 |
| `function.name` | string | 工具名称 |
| `function.description` | string | 工具描述 |
| `function.parameters` | `Record<string, any>` | JSON Schema 参数定义 |

### Tool（可执行的工具）
| 字段 | 类型 | 说明 |
|------|------|------|
| `ns` | string | 命名空间 |
| `name` | string | 唯一标识 (from Meta) |
| `label` | string | 显示标签 (from Meta) |
| `description` | string? | 描述 (from Meta) |
| `configuration` | `ConfigField[]`? | 配置 Schema |
| `definition` | `ToolDefinition` | 工具定义 |
| `execute` | function | 执行函数 |
| `interceptor` | `ToolInterceptor`? | 工具拦截器 |
| `extractLabel` | function? | 从参数提取 UI 标签 |

### Extension（扩展插件）
| 字段 | 类型 | 说明 |
|------|------|------|
| `ns` | string | 命名空间 |
| `name` | string | 唯一标识 (from Meta) |
| `label` | string | 显示标签 (from Meta) |
| `description` | string? | 描述 (from Meta) |
| `configuration` | `ConfigField[]`? | 配置 Schema |
| `preHook` | `PreProcessHook`? | 前置钩子 |
| `postHook` | `PostProcessHook`? | 后置钩子 |

### AgentMessage（Agent 间通讯）
| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 发送者 Agent ID |
| `to` | string | 接收者 Agent ID |
| `type` | `AgentMessageType` | 消息类型 |
| `payload` | string | 负载 |
| `correlation_id` | string? | 关联 ID，用于追踪上下文、防止死循环 |
| `data` | `Record<string, any>`? | 附加数据 |

### AgentMessageType（消息类型枚举）
| 值 | 分类 |
|------|------|
| `request` / `response` / `broadcast` | 路由协议 |
| `chat.send` / `chat.interrupt` | 聊天控制 |
| `chat.start` / `chat.end` | 聊天生命周期 |
| `chat.turn.start` / `chat.turn.end` | 轮次 |
| `chat.message.start` / `chat.message.update` / `chat.message.end` / `chat.message.error` | 消息流 |
| `chat.thinking.start` / `chat.thinking.update` / `chat.thinking.end` | 思考流 |
| `chat.toolcall.start` / `chat.toolcall.update` / `chat.toolcall.end` | 工具调用流 |
| `chat.tool_execution.start` / `chat.tool_execution.update` / `chat.tool_execution.end` | 工具执行流 |
| `agent.list` / `agent.list.response` | Agent 列表 |
| `history.request` / `history.response` | 历史查询 |
| `file.upload` / `file.upload.progress` / `file.upload.complete` | 文件上传 |

### ToolInterceptContext（拦截器上下文）
| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | 调用该工具的 Agent ID |
| `args` | `Record<string, any>` | 工具参数（可被拦截器改写） |

### ToolInterceptResult（拦截结果）
| 字段 | 类型 | 说明 |
|------|------|------|
| `allow` | boolean | false = 拒绝执行 |
| `reason` | string? | 拦截原因 |
| `args` | `Record<string, any>` | 可修改的参数 |

---

## 五、AgentConfig 字段 (src/discovery/config-types.ts)

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_id` | string | Agent 唯一标识 |
| `name` | string | 昵称 |
| `virtual` | boolean? | 是否为虚拟 Agent（无 LLM） |
| `llm` | `LLMConfig`? | LLM 配置 |
| `tools` | `string[]`? | 要加载的工具名称列表 |
| `pre_hooks` | `string[]`? | 前置钩子名称列表 |
| `post_hooks` | `string[]`? | 后置钩子名称列表 |
| `[key: string]` | any | 命名空间扩展配置 |

---

## 六、LLMConfig 字段 (src/discovery/config-types.ts)

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | `'openai' \| 'deepseek' \| 'ollama'` | 提供商类型 |
| `api_key` | string? | API Key，支持 ${ENV_VAR} |
| `base_url` | string? | API 地址 |
| `model` | string? | 模型名 |
| `temperature` | number? | 温度参数 |
| `max_tokens` | number? | 最大输出 token |
| `reasoning_effort` | `'high' \| 'max'`? | DeepSeek 思考强度 |
| `thinking` | boolean? | 是否默认开启思考模式 |

---

## 七、AppConfig 字段 (src/core/config.ts)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxHops` | number | 5 | Router 最大跳数（防死循环） |
| `messageQueryDefaultLimit` | number | 50 | 历史消息查询默认条数 |
| `webuiDefaultPort` | number | 3830 | WebUI 默认端口 |
| `workspaceDir` | string | `workspace/default` | 运行时工作根目录 |
| `agentsDir` | string | — | Agent 配置目录 |
| `sessionsDir` | string | — | 会话数据目录 |
| `namespaces` | `Record<string, Record<string, unknown>>` | {} | 命名空间配置字典 |

---

## 八、LLM Schema 字段

### DeepSeek
| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `api_key` | `API Key` | 密钥保存在 ~/.agentchat/credentials.json | password | '' |
| `base_url` | `API 地址` | DeepSeek API 端点 | text | `https://api.deepseek.com` |
| `model` | `模型名称` | 模型 ID，如 deepseek-v4-flash | text | `deepseek-v4-flash` |
| `temperature` | `温度` | 控制输出随机性 (0-2) | number | — |
| `max_tokens` | `最大 Token` | 最大输出 token 数 | number | — |
| `reasoning_effort` | `思考强度` | 深度思考模式强度 | select | high |
| `thinking` | `思考模式` | 是否默认开启深度思考 | checkbox | true |

### OpenAI
| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `api_key` | `API Key` | 密钥保存在 ~/.agentchat/credentials.json | password | '' |
| `base_url` | `API 地址` | OpenAI 兼容 API 端点 | text | `https://api.openai.com/v1` |
| `model` | `模型名称` | 模型 ID，如 gpt-4o | text | `gpt-4o` |
| `temperature` | `温度` | 控制输出随机性 (0-2) | number | — |
| `max_tokens` | `最大 Token` | 最大输出 token 数 | number | — |

### Ollama
| 字段名 | 标签 | 描述 | 类型 | 默认值 |
|--------|------|------|------|--------|
| `api_key` | `API Key` | 本地部署通常无需设置 | password | '' |
| `base_url` | `API 地址` | Ollama 服务端点 | text | `http://localhost:11434/v1` |
| `model` | `模型名称` | 本地模型名，如 llama3 | text | `llama3` |
| `temperature` | `温度` | 控制输出随机性 (0-2)，留空使用默认值 | number | — |
| `max_tokens` | `最大 Token` | 最大输出 token 数，留空不限制 | number | — |

---

## 九、WebUI 前端类型 (webui/client/src/types/index.ts)

### AgentInfo
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | Agent ID |
| `name` | string | 名称 |
| `description` | string | 描述 |
| `lastActivity` | number? | 最近活动时间戳 |
| `lastMessage` | `{role, content, timestamp} \| null`? | 最后一条消息摘要 |
| `hasActiveSession` | boolean? | 是否有后台活跃会话 |

### PluginMeta（插件元数据，前端展示用）
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 插件唯一标识 |
| `type` | `'tool' \| 'pre_hook' \| 'post_hook'` | 插件类型 |
| `description` | string | 功能描述 |
| `label` | string | 中文标签 |
| `enabled` | boolean | 是否已启用 |

### ChatMessage（聊天消息）
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 消息 ID |
| `role` | `'user' \| 'assistant' \| 'tool'` | 角色 |
| `content` | string | 内容 |
| `agent_id` | string? | 消息来源 Agent ID |
| `toolCalls` | `ToolCall[]`? | 工具调用 |
| `toolName` | string? | 工具名称 |
| `tool_call_id` | string? | 工具调用关联 ID |
| `name` | string? | 参与者名称 |
| `thinking` | string? | 思考过程 |
| `reasoning_content` | string? | 思考过程（兼容别名） |
| `label` | string? | 思考/工具标签 |
| `isStreaming` | boolean? | 是否流式传输中 |
| `status` | `'running' \| 'success' \| 'error'`? | 状态 |
| `isError` | boolean? | 是否错误 |
| `timestamp` | number | 时间戳 |
| `files` | `FileAttachment[]`? | 附件 |
| `_archived_context` | boolean? | 是否归档上下文 |

### FileAttachment
| 字段 | 类型 | 说明 |
|------|------|------|
| `hash` | string | 文件哈希 |
| `filename` | string | 文件名 |
| `filesize` | number | 文件大小 |
| `text` | string? | 文件文本内容 |

---

## 十、PersistedMessage 字段 (src/global/extensions/agent-session/types.ts)

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'system' \| 'user' \| 'assistant' \| 'tool' \| 'error'` | 角色 |
| `content` | `string \| null` | 内容 |
| `agent_id` | string? | 消息来源 Agent ID |
| `name` | string? | 工具名称 |
| `tool_calls` | array? | 工具调用列表 |
| `tool_call_id` | string? | 工具调用关联 ID |
| `reasoning_content` | string? | 思维链/推理内容 |
| `label` | string? | 展示标签 |
| `timestamp` | string | 时间戳 |

---

## 十一、MCP 类型 (src/global/extensions/agent-prompt/mcp-types.ts)

### MCPServerConfig
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | MCP 服务器唯一名称 |
| `command` | string | 启动命令 |
| `args` | string[]? | 命令行参数 |
| `env` | `Record<string, string>`? | 环境变量（支持 ${ENV_VAR}） |
| `enabled` | boolean? | 是否启用 |
| `connectTimeoutMs` | number? | 连接超时（毫秒） |

### MCPConfig（agent-prompt 的 MCP 子配置）
| 字段 | 类型 | 说明 |
|------|------|------|
| `servers` | `MCPServerConfig[]` | MCP 服务器列表 |
| `cacheTtlMs` | number? | 工具列表缓存 TTL |

---

*清单完毕。共覆盖 **3 个扩展**、**8 个工具**、**1 个拦截器**、**30+ 核心类型/接口** 的所有字段。*
