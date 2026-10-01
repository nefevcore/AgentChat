# 远程 deliver 信封裁决：sender=user，设备溯源留链路层（cr-78）

> 日期：2026-10-01 · 裁决级：行为修改（forwardRpc 强制改写面）
> 前置：src/docs/remote-client-relay-plan.md §4.4 · archive/m1-remote-link-implementation-plan.md §1.4

## 0. 问题

移动端（已配对设备经 relay 链路）发起会话时，deliver 信封的 sender 该取
`user` 还是 `remote:<deviceId>`？M1 落地时按上游方案 §4.4 取了后者，本轮
全链审计发现它造成 1v1 直答路径的实际缺陷。

## 1. sender 与 source 的契约分工（ac-agent-loop/src/contract.ts）

- `sender` = 发送方端点 id（M19 全对键桶模型：user 只是端点之一，viewer
  虚拟 Agent id；委托 = 发起 Agent id）。
- `source` = 拓扑类（'user' 直答 / 'agent' 委托 / 'event' 机制触发）。

两者的机械消费点（sender 有、source 无——source 只进事件行与预算判定）：

| 消费点 | 位置 | 行为 | sender=remote:xxx 的后果 |
|---|---|---|---|
| 直答桶键派生 | ac-web-api conversation/deliver L693-697 | conversationId = pairKey(sender, agentId)（前端直答不传 conversationId） | 消息落桶 remote:xxx~agent，与桌面 user~agent 分裂 |
| 历史读侧 | feed-core requestHistoryPage L455 | 恒用 bucketKey(VIEWER_ID='user', agent) | 手机刷新后读不回自己发的消息 |
| 流式门控 | feed-core isForCurrentUser L1704 | sender≠'user' 且桶含 viewer → 帧被拦截 | 回复流式帧被丢弃或落矩阵格分区 |
| 提权水位/会话覆盖 | ac-conversation deliver L334 | 按 conversationId 写 conv-settings | 写入错桶——手机提权/模型覆盖对桌面会话不生效 |
| 排队/工具估算 | web-api queueConversationId L754 / tool-defs L948 | 同款 pairKey 派生 | 全部错位 |

注：前端直答路径不传 conversationId（chat-core deliver 注释：边界算则
前端透传，D3 原则）——sender 是桶键的唯一输入，前缀直接决定桶。

## 2. remote: 前缀无机械消费者

全仓 grep：`remote:` 只在 forwardRpc 的改写处出现，没有任何代码基于该前缀
做判定。安全审计（relay-security-audit-round2 链路 E）列举的缓解——剥
elevation、scopes 闸门、admin 档禁用——分别依赖 sanitizeElevation(source)
与方法白名单，均与 sender 前缀无关。`remote:` 只提供描述性溯源，不提供
强制力；为它付出桶分裂的代价不成立。

M1 时期该前缀合理（当时无 M19 对键桶模型，sender 尚未成为桶键输入）；
M19 后它成了缺陷源。

## 3. 裁决

1. **sender = 'user'**：手机是同一 viewer 端点的另一块表面，不是社交图里的
   新端点。直答桶键、流式门控、历史读侧、conv-settings 全部自然对齐。
2. **source = 'user'**（保持不变）：远程输入在拓扑上就是用户直答——这条
   原本就对，不动。
3. **保持强制改写，不删字段**：改写面本身就是防伪造屏障——配对设备可
   自行传 sender 冒充其他端点注入 agent⇄agent 桶（source 同理），必须由
   forwardRpc 强制覆盖。
4. **设备溯源留链路层**：remote-link 层已有 deviceId 在手（handleDevicePayload
   入口），审计/日志需要时打一行即可，不进信封。未来若真需信封级溯源，加
   专用字段（如 via），不挪用 sender。

## 4. 改动面

| 文件 | 改动 |
|---|---|
| ac-remote-link/src/service.ts | forwardRpc DELIVER_METHODS 改写：sender='user'（原 remote:+device.id），注释更新 |
| ac-remote-link/tests/remote-link.test.ts | 新增断言：chat 设备 deliver 转发参数 sender==='user'、source==='user'、无 elevation |
| src/docs/archive/m1-remote-link-implementation-plan.md | §1.4 判定逻辑行同步 |
| src/docs/mobile-link-diagram.html | 卡片文字同步（sender=user + 剥 elevation） |