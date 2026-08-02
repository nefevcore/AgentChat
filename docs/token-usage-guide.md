# Token 消耗分析与优化指南

> 版本：v0.4.x（2026-08-01）
> 数据来源：workspace/usage/token_*.jsonl（每日分片）

## 消耗全景

### 单次 LLM 调用的 token 组成

```
prompt_tokens = 系统提示词 + 历史消息 + 工具定义 + 当前消息
completion_tokens = 模型回复（含思维链 reasoning）
total_tokens = prompt + completion
```

关键放大器：**prompt_tokens 每次调用都全量重发**（无跨调用缓存时），
所以"会话越长、工具越多、历史越多" → 单次调用成本越高。

### 实测分布（2026-08-01，总计 28.5M tokens）

| Agent | 调用次数 | 用量 | 说明 |
|-------|---------|------|------|
| agent_chat_dev | 77 | 22.6M (79%) | 今日开发调试密集（归档测试、代码审查）|
| news | 33 | 1.3M | 热点抓取 |
| math_pro | 5 | 0.9M | 单次大计算 |
| test | 30 | 0.8M | 测试验证 |
| writer | 6 | 0.8M | 创作 |
| 其余 9 个 | — | ~2.2M | 正常 |

> 79% 集中在开发 Agent 是**异常信号**（今日密集开发），日常应远低于此。

## Token 消耗点全盘点

### 1. 会话历史（最大消耗源）

| 场景 | 机制 | 消耗 |
|------|------|------|
| 1:1 会话 | preHook loadHistory 全量加载 | 每次调用重发全部历史 |
| **群聊** | **每个参与者 preHook 全量加载共享历史** | **N 参与者 × 全量 = 爆炸** |
| 历史含 reasoning_content | loadHistory 保留（token 估算用） | 单条可能巨大 |

**缓解（已实现）**：
- 归档（1:1 + 群聊）→ 先整理后归档，控制历史长度
- 群聊双阈值（groupArchiveTokens=50K / groupLoadLimitTokens=30K）
- preHook 压缩（maxTokens 超限 → 摘要 + 保留 10%）

### 2. 系统提示词（每调用重发）

组成：
- 基础提示词（角色、职责、工作流）
- **AGENT.md 全文**（agent-prompt 追加）
- 记忆相关（memory.md 摘要/路径提示）
- 工具使用指南（根据启用的工具动态生成）

**缓解（已实现）**：
- agent-memory 只在审查时变更 memory.md → 提示词稳定 → prompt cache 命中率高
- 工具按需启用（list_tools + manage_plugins）→ 指南精简

**缓解（8/2 提示词瘦身）**：
- **记忆注入预算截断**：`extension.agent_memory.memoryBudgetTokens`（默认 600）超限时保留记忆头部 + 追加提示，Agent 可 read 全量 memory.md。实测 agent_chat_dev 记忆 1099→600 tok
- **指引/术语约定按显式 config.tools 门控**：autoInject 工具（send_agent/query_history/定时/子Agent 等）所有 Agent 都有，其工具定义自带说明，不再重复注入散文指引。只有 Agent 显式配置的工具组才注入对应指引。例外：定时任务主动指引始终保留、system_restart 对 admin 保留。实测 agent_chat_dev 指引 772→367、术语约定 157→0 tok
- **持久化存储瘦身**：存储区块操作指引压缩为路径 + 一句话用途（省 ~230 tok）
- **系统环境瘦身**：Windows 编码/引号铁律压缩为精炼版（省 ~90 tok）
- 装配顺序保持"静态在前、动态在后"，记忆仍追加在末尾 → KV-cache 命中不受影响

### 3. 工具定义（每调用重发）

- 每个启用工具的定义（name/description/parameters）都进 prompt
- autoInject 16 个 + 配置工具 → 工具越多 prompt 越大

**缓解**：工具分层（基础/工具/开发），按需配置。

### 4. 思维链 reasoning_content

- DeepSeek 类模型思考过程可能很长（数万 tokens）
- 归档/用量估算时计入

### 5. 重复调用（循环/重试）

- ReAct 循环：多轮工具调用 = 多次 LLM 调用
- 队列重试：失败重试翻倍消耗
- 定时任务：高频任务累积

### 6. 归档整理轮（新增）

- 归档前触发参与者整理轮（完整上下文 + ReAct 工具调用）
- **这是有意的投入**：一次性整理记忆，换取后续历史截断的长期节省

## 监控与治理

### 数据源
- `workspace/usage/token_YYYY-MM-DD.jsonl` — 每次调用记录
- WebUI 用量面板（GET /api/usage/tokens）

### 每日审查建议
```
1. 对比各 Agent 用量趋势（环比）
2. 关注异常增长：某 Agent 用量激增 = 可能有长会话/死循环/高频任务
3. 大会话及时归档（手动压缩 或 等阈值）
4. 检查群聊大小（双阈值应自动控制）
```

### 治理实践（历史记录）
- 7/30：news +60%、impc-dev +145% → 审查后优化
- 7/31：历史最低 7.2M（治理见效）
- 8/1：28.5M（开发密集，agent_chat_dev 占 79% 异常）

## 优化清单

| 优化项 | 状态 | 收益 |
|--------|------|------|
| 群聊双阈值 | ✅ 已实现 | 防多参与者 token 爆炸 |
| 归档先整理后归档 | ✅ 已实现 | 长会话控制 + 记忆保留 |
| 工具分层按需 | ✅ 已实现 | 精简工具定义 |
| 记忆提示词稳定 | ✅ 已实现 | prompt cache 命中 |
| prompt cache 利用 | 🔲 待优化 | 前缀稳定 → 命中缓存（可省 50-90% prompt）|
| 会话滑动窗口摘要锚点 | 🔲 群聊已做，1:1 待评估 | 早期内容固定化 |
| 低价值 Agent 降频 | 🔲 定期审查 | 减少无效调用 |

## 与 LLM Provider 的 cache 策略

- OpenAI / DeepSeek 等支持 prompt cache（相同前缀折扣）
- **稳定前缀**（系统提示词 + 记忆 + 早期摘要）→ 缓存命中
- **变化部分**（近期消息、工具结果）→ 全价
- 因此：提示词稳定 + 归档截断 = 双重省钱
