# 第 2 步：创建第一个 Agent

> 目标：创建一个带身份、可对话的 Agent，理解 Agent 目录结构。

## 2.1 WebUI 创建

侧边栏「新建 Agent」→ 填名称 → 保存。系统自动生成 `workspace/default/agents/<agent_id>/config.json`。

## 2.2 手动创建（同样有效）

```
workspace/default/agents/my_assistant/
├── config.json
└── AGENT.md        # 可选：系统提示词
```

`config.json`（新契约，v0.6.2 推荐）：

```json
{
  "agent_id": "my_assistant",
  "name": "我的助手",
  "description": "一个编程助手",
  "tags": ["dev"],
  "presets": [
    "agentchat-fs-tools",
    "agentchat-shell-tools",
    "agentchat-agent-prompt",
    "agentchat-agent-session"
  ],
  "tools": [],
  "hooks": {
    "runStart": ["agent-prompt.build-system-prompt", "agent-session.load-history"],
    "toolExecutionStart": ["security.security-check"],
    "runEnd": ["agent-session.save-session", "agent-session.idle-reset", "agent-session.log-usage"]
  }
}
```

`AGENT.md`：

```markdown
# 我的助手

你是一个编程助手，擅长 TypeScript 和 Node.js。
```

## 2.3 加载配置

- WebUI 里保存即触发；或对任意 dev 标签 Agent 说 `reload(scope=global)`；
- 手动等价：修改 config.json 后用 `reload` 工具，或重启进程。

## 2.4 观察发生了什么

1. `boot` 的 `AgentLoader.loadOne()` 读取 Agent 差异配置，与全局配置 deepMerge；
2. LLM 解析：没写 `llm` → 池中 `default:true` 条目（或池第一项）；
3. 工具解析：`ctx.tools.resolveTools(config)` —— presets 过滤 → `requires` 权限门禁（隐式 `base` 基础层 + `dev` 标签）→ `tools.include/exclude` 意图覆盖（exclude 优先）；
4. 钩子解析：`ctx.hooks.collect(config)` 按 `hooks` 启用清单烘焙钩子数组。

## 2.5 和它聊天

在 WebUI 选择「我的助手」→ 发送「用一句话介绍你自己」。

此时执行链（可对照 [architecture.md](../architecture.md#5-核心引擎agentchatagent-loop)）：

```
Router.send(msg, { wait: true }) → route → deliverOne → createAgentContext（烘焙 LLM/工具/历史/钩子）
→ runStart：agent-prompt 注入系统提示词 → agent-session 加载历史
→ LLM 流式推理 → 回复
→ runEnd：save-session 落盘 sessions/chat~my_assistant~user/messages.jsonl
```

打开 `workspace/default/sessions/chat~my_assistant~user/messages.jsonl`，每行一条 JSON 消息。

## 2.6 练习

1. 修改 `AGENT.md`，让 Agent 说话带固定口头禅，观察 `reload` 后是否生效。
2. 看看 `workspace/default/agents/user/config.json` —— `virtual: true` 的虚拟 Agent 长什么样。
3. 用 `list_tools`（对 Agent 说或直接问）查看它当前有哪些工具。

## 下一步

[第 3 步：Agent 配置详解](03-agent-config-in-depth.md)
