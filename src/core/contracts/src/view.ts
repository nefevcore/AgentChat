// ============================================================
// contracts/view.ts —— 群消息视图单一事实源（契约层，零依赖）
//
// `<msg from name group>` 封装只有一个构造点：router 的群 trigger hint、
// agent-session 的 loadGroupHistory、GroupFeed 的增量注入共用本模块。
// （此前 router 与 session 各拼一份、靠注释约定"逐字一致"——8/4~8/17
// 消息重复事件的根因结构之一，见 docs/group-single-channel-design.md §1.2）
//
// 2026-08-20 下沉契约层：router（agents）/server/agent-session 三方共用，
// 正典随 GroupFeed 契约（group-feed.ts）同层；agents/src/view.ts 保留
// re-export 兼容既有导入。
// ============================================================

/** 转义 <msg> 标签属性值（防 XML 注入） */
export function escapeMsgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 群消息视图参数 */
export interface GroupMsgViewParams {
  /** 发送者 Agent ID */
  from: string;
  /** 发送者显示名（缺省回退 from） */
  displayName?: string;
  /** 群显示名 */
  groupName: string;
  /** 消息正文（已按消费方需要清洗） */
  content: string;
}

/**
 * 构造群消息的 `<msg>` 视图封装（发送者视角无关：调用方决定是否包装，
 * own 消息不包装的规则由调用方持有——loadGroupHistory 与 GroupFeed 一致）。
 */
export function wrapGroupMsg(params: GroupMsgViewParams): string {
  const name = params.displayName && params.displayName !== params.from
    ? params.displayName
    : params.from;
  return `<msg from="${escapeMsgAttr(params.from)}" name="${escapeMsgAttr(name)}" group="${escapeMsgAttr(params.groupName)}">${params.content}</msg>`;
}
