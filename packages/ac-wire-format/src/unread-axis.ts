// ============================================================
// unread-axis.ts —— 未读轴键归一（cr-1157 判据单源）
//
// 「未读计数记在哪个轴键上」是**帧词汇面的投影**：run/settled 帧与私信帧
// 的 (agent, conversationId) → 计数器轴键。故住线格式纯库（零 Node 依赖
// ——宿主 tap 桥与 webui 前端两侧同源消费；判据写两份必走散：初版漏抄
// 「viewer 参与会话」门控即致双倍/串台两 bug）。
//
// 轴键词法与前端 feed 分区键同构：对桶 `a~b` / 群 `gid` / single `uuid`。
// ============================================================

/** single 会话键词法（uuid 形——与 ac-session-index sessionKindOf 同式） */
const SINGLE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** viewer⇄agent 对桶轴键（私信/直答——两端排序后 ~ 连接，与 pairKey 同式） */
export function userPairAxisKey(agent: string, viewer = 'user'): string {
  return [agent, viewer].sort().join('~');
}

/**
 * run 收束事件的未读轴键归一。只计 **viewer 参与会话**（cr-1144/cr-1057 口径）：
 *   · 含 `~` 对桶须一端为 `viewer`——自会话 `a~a`（机制 run：定时推送、
 *     复盘等）与 agent⇄agent 对不计（其动静走 roster 活动面；计入即在
 *     徽章按 Agent 聚合时与 user 对桶合流 = 一次推送亮两次）；
 *   · `g-` 群轴不计——群消息由 `group/message-posted` 单源计，群成员 run
 *     的 conversationId 就是 gid，在此再计即双计/串台；
 *   · uuid 形 = single 会话，直用；
 *   · 其余（agent 名直答旧形态）= userPairAxisKey(agent)。
 * 返回 undefined = 该事件不计未读。
 */
export function unreadAxisKeyOf(
  agent: string | undefined,
  conversationId: string | undefined,
  viewer = 'user',
): string | undefined {
  if (agent === undefined || agent === '' || conversationId === undefined || conversationId === '') return undefined;
  if (conversationId.includes('~')) {
    return conversationId.split('~').includes(viewer) ? conversationId : undefined;
  }
  if (SINGLE_KEY_RE.test(conversationId)) return conversationId;
  if (conversationId.startsWith('g-')) return undefined;
  return userPairAxisKey(agent, viewer);
}
