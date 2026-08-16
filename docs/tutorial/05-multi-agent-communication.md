# 第 5 步：多 Agent 通信

> 目标：让 Agent 互相帮忙，理解 send_agent / 群聊 / 消息路由。

## 5.1 协作工具（agentchat-agent-tools）

| 工具 | 作用 |
|------|------|
| `send_agent` | 给另一个 Agent 发消息（默认异步；`wait=true` 阻塞等回复） |
| `send_group` | 在群聊中发言 |
| `list_agents` | 列出所有 Agent |
| `list_groups` | 列出群组 |
| `read_agent_info` | 读某个 Agent 的公开档案 |
| `update_agent_profile` | 更新自己的档案 |
| `list_tools` | 列出自己当前可用工具 |

这些工具全部 `requires: ['base']`，`from` 由工厂闭包注入，Agent 无法伪造发件人。

## 5.2 让 coding_agent 帮个忙

创建两个 Agent（如 `my_assistant` 与 `coding_agent`），然后对 `my_assistant` 说：

> 帮我让 coding_agent 审查一下 workspace/default/files/shared/tool-dev-guide.md

`my_assistant` 会调用：

```
send_agent(to="coding_agent", message="请审查 tool-dev-guide.md", wait=true)
```

链路：

```
my_assistant.run
  → send_agent 工具 → Router.send(msg, { wait: true })
  → coding_agent.receive → createAgentContext（coding_agent 视角）
  → read 文件 → 分析 → 回复
  → 回复作为新消息送达 my_assistant（wait=true 时阻塞带回结果）
```

## 5.3 消息路由核心（@agentchat/router）

| 模式 | 触发 | 行为 |
|------|------|------|
| 1v1 | `to=<agent_id>` | 单个 Agent receive |
| 广播 | `to='*'` | 遍历所有 Agent |
| 群组 | `group_id` 非空 | GroupManager 广播，参与者各自判断是否回复 |
| 等待回复 | `send(msg)` / `send(msg, { wait: true })` | 阻塞到 run 结束，返回 LLM 最终内容 |
| 异步 | `send(msg, { wait: false })` | fire-and-forget，受理后立即返回 |
| 自主推理 | `trigger()` | 无消息 ReAct（定时/归档/续推/群聊用）；**永远 fire-and-forget，不返回 run 结果**，需要收尾时用 `whenSessionIdle(convKey)` |
| 会话繁忙 | 同会话运行中再次投递 | `placement` 决策：默认 `steer`（注入 next-step，在下一个 ReAct **step** 消费；run 自然结束前会继续消费遗留 next-step）；`next-run` 则等待空闲后新开 run（trigger 带 `meta/maxSteps/deepThink` 时默认 `next-run`）。另有 `followup`（next-turn：run 结束后独立轮）与 `inject`（next-step 但不唤醒空闲会话） |

- 执行边界：`run` = 一次 `chat.start…chat.end` 生命周期；`step` = 一次 LLM 请求 + 其工具执行；
- `correlation_id` 透传（L5 WS 关联）；`maxHops` 为全局配置默认值，当前 AgentRouter 不消费；
- 会话级队列串行化：同一会话一条一条跑，不同会话并行；
- 优雅关闭/重启时：Router 进入关机模式，新消息落盘 `<ws>/.router_pending.jsonl`（trigger 完整保留 `maxSteps/meta/wrapHint` 等选项），重启后 `flushPendingMessages` 重投（失败保留待下次重试）。

## 5.4 群聊

WebUI「群聊管理 → 新建群聊」选参与者创建。群里每条消息广播给所有参与者，**每个 Agent 独立判断是否回复**（不会回声链无限循环）。

存储：`workspace/default/groups/<gid>/`（群组数据）与 `workspace/default/sessions/group~<gid>/messages.jsonl`（群聊本体，无思考/工具）；每个 Agent 的完整思考/工具轨迹按周归档到 `group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl`。

## 5.5 练习

1. 建 3 个不同身份的 Agent（如编辑/作者/读者），拉个群，观察它们如何互动。
2. 用 `send_agent(wait=true)` 与 `wait=false` 各做一次，对比 `my_assistant` 视角的回复时机。
3. 用 `read_agent_info` 看 `update_agent_profile` 改过的档案。

## 下一步

[第 6 步：定时与自主行动](06-timer-and-autonomy.md)
