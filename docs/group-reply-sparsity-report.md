# 群聊 Agent 回复「空转」问题排查与修复报告

> **历史复盘报告**：记录 2026-08-03 当时的事实，文中的源码路径（`agent.ts`/`router.ts` 等）属于旧结构，仅供追溯，不代表当前代码。
> 日期：2026-08-03
> 范围：群聊 trigger → Agent 回复链路 / 上下文构建
> 关键字：空转、send_group/reply_group 不调用、assistant 示范稀疏、相邻 user 合并、少样本漂移

---

## 1. 背景与现象

AgentChat 群聊中，收到群聊消息的 Agent 会通过 `router.trigger()` 触发自主推理，需调用
`send_group` / `reply_group` 工具才能把回复投递到群聊共享历史（`groups/<id>/messages.jsonl`）。

**现象**：Agent（如 `news`）收到群聊 trigger 后常**直接输出文本而不调用工具**。而直接输出文本
**不会投递到群聊**——投递唯一入口是 `deliverGroupMessage`，只有工具调用才会触发。结果是：

- Agent 在自身参与归档（`sessions/<A>/group__<id>/archive/history_*.jsonl`）里输出了完整"播报"，
- 但群聊里其他成员（风栗、小七、Neko）**根本看不到**，反复发消息却没人理，
- 形成负反馈死循环：想播报 → 没调工具 → 没人看到 → 用户继续问候 → 继续空转。

## 2. 证据

对比两个文件，同一时段（08-03 13:00–14:59 UTC）差异明显：

| 文件 | 内容 |
|:---|:---|
| 群聊共享历史 `messages.jsonl` | 仅 3 条：14:20 user「晚上好」、14:21 neko 冒泡、14:22 user「最近有什么趣事？」 |
| 参与归档 `history_2026-W32.jsonl` | 14:04 / 14:12 / 14:15 / 14:22 … news 输出了一大批"播报"文本，**全部未进群聊** |

即 news 从 08-03 晚间起几乎每次回复都是空转。

## 3. 根因分析

**先排除一个猜测**：不是"只有一轮会话时不传工具"。`agent.ts` 的 `executeLoop` 每轮**无条件**从
`this.tools` 生成 `toolDefs` 传给 LLM，工具定义始终存在。真正原因有三层：

### 3.1 引导太弱
`router.ts` 群聊 hint 为：
```
（选择不回应或调用工具 send_group 进行回应。）
```
给了"不回应"这个宽松出口，且提示写的是 `send_group`，而当天新增的回复语义工具
`reply_group` 没出现在提示里，模型在两者间无所适从，倾向直接输出文本。

### 3.2 系统提示词缺群聊规则
`agent-prompt` 扩展里的群聊协作指引被注释（`extension.ts` 第 251-252 行），
system prompt 中**没有任何一条**"收到群聊消息必须用工具回复"的规则。

### 3.3 稀疏示范（核心）
模型是否调用工具，高度依赖上下文历史里的**工具调用示范**（少样本效应）。群聊历史经
provider 视角转换（`resolveApiRole`：`agent_id===viewer → assistant`，`≠viewer → user`）后，
除当前 Agent 自己的回复外，其他人消息全部变 `user`，因此上下文天然是"连续 user + 稀疏 assistant"。

一旦某轮 Agent 空转（不调工具 → 不写 `messages.jsonl`），下一轮上下文里 **assistant 更稀疏、
全是 user**，示范更少 → 更倾向空转，形成负反馈放大。这才是"修复后效果明显"的根本原因——
修复同时抬高了上下文里的 assistant 密度。

## 4. 修复方案（已落地）

| # | 位置 | 改动 |
|:---|:---|:---|
| 1 | `src/routing/router.ts` | hint 强化：明确"若值得回应必须调用 reply_group，直接输出文本不会发送到群聊；无话可说则沉默"。保留沉默选项，避免踩"强制务必调用 → 全员刷屏回声"的坑 |
| 2 | `src/global/agent-core/extensions/agent-prompt/extension.ts` | 恢复群聊指引（`has('reply_group','send_group')` 时注入"必须用工具回群聊"）；`COLLAB_TOOLS` 与术语约定补 `reply_group` |
| 3 | `src/global/agent-core/extensions/agent-session/history.ts` | `loadGroupHistory` 合并相邻"对方视角纯发言"消息，减少连续 user 消息造成的 token 浪费与注意力稀释 |

**位置取舍**：合并逻辑放在 agent-session 装载历史时（`loadGroupHistory`），**而非**
provider 层 `toProviderMessages`——后者是通用视角转换，有严格单测约束（`toProviderMessages.test.ts`
期望保留多个 `user`），业务优化放那里会破坏测试。

## 5. 验证结果

- `tsc --noEmit` 通过；`toProviderMessages / loadHistoryDangling / truncateTail` 等 25 个单测全绿。
- 修复 1/2 后：`news` 恢复调用 `reply_group` / `send_group`，回复真正写入 `messages.jsonl`。
- 合并逻辑真实数据实测：上下文 65 条、13 个块合并了 2+ 条连续发言，最近块把 5 条连续发言合成 1 条。
  极端情况：早期长时间无回复时，中间发言会合成超大单块（实测最多 112 条）——token 上仍更省，
  但需留意是否过度影响注意力。

## 6. 结论与后续建议

**结论**：问题的本质不是"单轮不调用工具"，而是**弱引导 + assistant 示范稀疏**共同导致的行为漂移。
修复三处后：群聊规则显式化、提示语给足语义、连续 user 消息被合并压缩，既省 token 又抬高示范密度。

**后续可选**：
1. 超长合并块加"块内摘要"或限制合并上限；
2. 评估 1:1 会话 `loadHistory` 是否也需要同类合并；
3. 增加"空转率"观测（参与归档中有输出但群聊共享历史无投递的轮次占比），便于持续监控。
