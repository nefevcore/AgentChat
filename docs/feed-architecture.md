# 统一信息流架构（Feed Architecture）

> 目标：把"实时信息流"从"每个视图各自订阅"升级为"**一个统一模型 + 视图即筛选**"。
> 这是实现「多视角布局」（会话 / 过程 / 社区 / 工作区）的基础设施。
> 状态：设计草案，供重写实现时参考。

---

## 1. 结论

**方向正确。** 统一模型后，页面展示退化为"从同一个数据池筛选自己关心的 dialog"，天然支持：
- 会话视角（筛 1 个 dialog）
- 社区流（筛所有 dialog 的活动）
- 星图（读所有 dialog 的状态）
- 群聊（筛 1 个 group dialog，与普通会话同一渲染管线）

**关键修正**：`turnDisplay` 是**派生视图**，不是存储字段。模型只存 `rawMessages`（单一真相源）。

---

## 2. 设计原则

1. **单一真相源**：`rawMessages` 是每个 dialog 唯一的消息记录（append-only 事件流）。
2. **派生不存储**：`turnDisplay`（Turn[]）、时间分隔符、trigger 分隔、未读计数等全部由纯函数从 `rawMessages` 派生。
3. **视图即筛选**：任何视图 = `useFeed(dialogId)` 取数 + 本地展示逻辑；多视角 = 多个 selector。
4. **dialog 分区**：数据按 dialog 隔离，互不污染；流式状态、历史分页、未读都挂在 dialog 上。
5. **LRU 常驻**：只让"最近活跃的 N 个 dialog"的 `rawMessages` 常驻内存，其余仅保留元数据（供列表/星图）。
6. **事件驱动**：所有 WS 事件经统一 `ingest()` 入口流入模型，内部解析目标 dialog 并追加。

---

## 3. 数据模型

```ts
// ── Dialog 标识 ──
type DialogKind = 'direct' | 'group';
/** direct: 用户与某个 Agent 的对话；group: 群聊 */
type DialogId = `direct:${string}` | `group:${string}`;

// ── 原始消息（唯一真相源，append-only）──
interface RawMessage {
  id: string;               // 前端本地 uid 或后端 message_id
  persistedMsgId?: string;  // 后端持久化 ID（删除/编辑用）
  dialogId: DialogId;
  kind: DialogKind;
  role: 'agent' | 'tool' | 'trigger';
  agentId: string;          // 发送者（'user' 为用户）
  content: string;
  // 流式增量字段：同一消息多次 update 时原地替换此对象（引用变化触发重算）
  thinking?: string;
  reasoning?: string;
  label?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  status?: 'running' | 'success' | 'error';
  isStreaming?: boolean;
  files?: FileAttachment[];
  timestamp: number;
}

// ── Dialog 分区（FeedStore 内维护）──
interface DialogFeed {
  id: DialogId;
  kind: DialogKind;
  partner: string | null;        // direct: 对方 agentId；group: null
  rawMessages: RawMessage[];     // 唯一真相源
  // 历史分页
  status: 'idle' | 'loading' | 'ready';
  hasMore: boolean;
  offset: number;
  // 元数据（即使 raw 被 LRU 淘汰也保留，供列表/星图/社区流）
  lastActivity: number;
  lastMessage: { role: string; content: string; agentId: string; ts: number } | null;
  unread: number;
  streaming: boolean;            // 当前是否有流式 turn
}

// ── 全局活动索引（社区流 / 星图 / 会话列表排序的单一来源）──
interface ActivityEntry {
  dialogId: DialogId;
  ts: number;
  kind: DialogKind;
  agentId: string;
  summary: string;               // 消息摘要（列表/社区流展示）
  event: string;                 // 事件类型（消息/工具/归档…）
}
```

```ts
// ── Store 顶层形态 ──
interface FeedStoreState {
  dialogs: Map<DialogId, DialogFeed>;
  activity: ActivityEntry[];     // 按 ts 倒序，cap 500 条
  activeDialogId: DialogId | null;
}
```

**派生逻辑（纯函数，不落存储）**：

```ts
// rawMessages → Turn[]（含 trigger 分隔；时间分隔符由视图层插入）
function buildTurns(raw: RawMessage[], kind: DialogKind): Turn[];

// selector：订阅某个 dialog 的派生视图（带 memo，仅 raw 引用变化时重算）
function useFeed(id: DialogId): {
  turns: ComputedRef<Turn[]>;
  raw: ComputedRef<RawMessage[]>;
  status: Ref<'idle' | 'loading' | 'ready'>;
  hasMore: Ref<boolean>;
  unread: Ref<number>;
  lastActivity: Ref<number>;
  loadMore: () => void;
};
```

---

## 4. 数据流

```
WS 事件 ──→ feedStore.ingest(event) ──→ 解析 dialogId + 追加 rawMessage
                                        └→ 更新 dialog 元数据 + activity 索引
                                              ↓
视图（会话/群聊/社区流/星图）── useFeed(dialogId) ──→ computed 派生 turns
```

**统一 ingest 事件映射**（吸收现有 chat store 的 HANDLERS）：

| WS 事件 | 目标 dialog | 动作 |
|---|---|---|
| `chat.message.start/update/end/error` | `direct:${agentId}` | 追加 / 替换流式消息 |
| `chat.thinking.*` / `chat.toolcall.*` / `chat.tool_execution.*` | `direct:${agentId}` | 替换消息上的 thinking/toolCalls/status |
| `chat.turn.start/end` | `direct:${agentId}` | 更新 streaming 标志 |
| `chat.virtual.receive` | `direct:${agent}` | 追加（虚拟 Agent 主动推送） |
| `history.response` | 对应 dialog | 顶部合并 + 分页 offset |
| `group.message` | `group:${groupId}` | 追加 |
| `session.compressed/archived` | `direct:${agentId}` | 追加 trigger 消息 + 更新元数据 |

**所有 ingest 同时**：更新 `lastActivity`/`lastMessage`、非活跃 dialog 的 `unread+1`、写入 `activity` 索引。

---

## 5. 视图 = 筛选器（多视角对照）

| 视角 | 取数方式 | 说明 |
|---|---|---|
| 会话 Talk | `useFeed(activeDialogId).turns` | 与现 `ChatView` 同，但数据来自统一池 |
| 过程 Work | `useFeed(activeDialogId)` + 流式尾部 | 工作台复用同一 turns，只改变展示位置 |
| 群聊 | `useFeed(groupDialogId).turns` | **与普通会话同一渲染管线**（消灭双管线） |
| 社区流 | `activity` 索引 + 各 dialog 元数据 | 点击条目 → 切换 activeDialogId |
| 星图 | 所有 dialog 元数据 + streaming 状态 | 节点大小/光晕 = lastActivity |
| 会话列表 | 全部 dialog 按 lastActivity 排序 | 未读/摘要来自元数据（LRU 淘汰后仍可用） |

---

## 6. 解决的现状问题

| 现状问题 | 本架构的解法 |
|---|---|
| `ChatView` / `GroupChat` 双管线，逻辑重复 | 统一 dialog + 统一 `buildTurns` + 同一 `TurnDisplayItem` |
| `_agentMessages` / `_agentTurns` / `_turns` 三份数据手动同步 | 只有 `rawMessages` 一份真相源，turns 为派生 |
| 社区流 / 星图无数据来源 | `activity` 索引 + 全 dialog 元数据 |
| 虚拟 Agent 推送、定时广播难以全局感知 | 全部经 `ingest` 流入统一池 |
| 切换会话丢流式状态 | 流式挂在 dialog 上，与"是否聚焦"解耦 |
| 会话列表 / 未读 / 排序逻辑分散 | 收敛到 dialog 元数据 |

---

## 7. 边界与注意点

1. **流式性能**：`message.update` / `thinking.update` 高频触发。策略：流式中的消息**原地替换对象**（引用变化让 computed 只重算尾部）；完成后的 turn 才做不可变追加。可保留现有"增量构建"思路，但迁移为 per-dialog。
2. **内存**：LRU 常驻最近活跃的 N（≈20）个 dialog；淘汰只清 `rawMessages`，保留元数据；切回时若 raw 为空 → 重新 `history.request` 懒加载（现有分页机制）。
3. **历史分页**：每 dialog 独立 `offset`/`hasMore`；`history.response` 顶部合并需保持 `persistedMsgId` 去重（现有 `mergeHistoryPage` 可复用）。
4. **Agent↔Agent 对话**：目前 UI 主路径是 user↔agent 与群组；虚拟推送已覆盖 agent→user。若未来支持 agent 直接互聊，只需扩展 dialog 命名空间（如 `direct:${a}:${b}`），模型不变。
5. **trigger / 归档消息**：作为特殊 role 的 rawMessage 进入同一池，`buildTurns` 负责渲染为分隔符，不污染普通 turn 链。
6. **VIEWER_ID**：用户的 dialog 就是 `direct:${agentId}`（partner = agent），无需特殊处理。

---

## 8. 落地建议

1. **复用现有纯函数**：`mergeHistoryPage`、`insertTimeSeparators`、turn 构建逻辑（`_agentMsgsToSteps` 等）提取为 `utils/feed.ts` 的纯函数，直接搬进新模型。
2. **Store 拆分**：新建 `feed` store（dialogs + activity + ingest）；原 chat store 的"交互（ask_questions）、System Prompt / ToolDefs 预览、压缩反馈"等**非消息状态**保留为独立关注点，不再与消息混在一起。
3. **UI 层**：`useFeed()` 组合式函数 + `TurnDisplayItem`（已具复用性）+ 新增 `CommunityFeed`（社区流）/ `Starfield`（星图）视图组件。
4. **渐进迁移**：可先在现有 webui 中把 chat store 内部改为"per-dialog 分区"，UI 不变（风险低）；再切换视图层为 `useFeed`。
