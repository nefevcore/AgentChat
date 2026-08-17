// ============================================================
// @agentchat/contracts/src/group-feed.ts —— 群消息内容通道契约
//
// 单通道化（docs/group-single-channel-design.md）：群聊本体文件是群消息
// 内容的唯一事实源；trigger 降级为纯通知。Router（busy 注入）经本接口
// 读取"锚点之后的增量"，实现由 L4 GroupService 提供、boot 装配注入。
// ============================================================

/** 群消息增量读取锚点：message_id 优先定位，line 回退（本体轮转预留） */
export interface GroupFeedAnchor {
  message_id?: string;
  line?: number;
}

/** readSince 返回页 */
export interface GroupFeedPage {
  /** 已按群消息视图（wrapGroupMsg）包装的注入文本；空串 = 无增量 */
  injected: string;
  /** 增量包含的原始消息 id（诊断/测试用） */
  message_ids: string[];
  /** 推进后的锚点（= 本页最后一条；空页 = 当前文件尾） */
  anchor: GroupFeedAnchor;
}

/**
 * 群消息内容通道（无状态）：按锚点读取本体增量。
 * 实现方：L4 GroupService；消费方：Router 群通知处理器（busy 注入）。
 */
export interface GroupFeed {
  /** 锚点之后的增量（peer 消息已包装 <msg>，own 消息跳过包装——与 loadGroupHistory 一致） */
  readSince(
    gid: string,
    anchor: GroupFeedAnchor | undefined,
    opts?: { viewer?: string; maxTokens?: number },
  ): Promise<GroupFeedPage>;
  /** 当前本体文件尾锚点（最新一行 message_id + 行号，0 起） */
  currentAnchor(gid: string): Promise<GroupFeedAnchor>;
}
