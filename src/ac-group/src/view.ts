// ============================================================
// ac-group/src/view.ts —— 群消息视图（`<msg>` 包装唯一构造点，零依赖）
//
// 原样继承 src contracts/view.ts（四次消息重复事故的教训：包装格式
// 只允许一个构造点，锚点增量/历史回放/触发通知共用）。
// ADR-3：包装归本包（拼接层）；LLM 层只收已合法的 OpenAI 形消息。
// ============================================================

/** 转义 <msg> 标签属性值（防注入） */
function escapeMsgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 群消息视图参数 */
export interface GroupMsgViewParams {
  /** 发送者 id（'user' 或 Agent id） */
  from: string;
  /** 发送者显示名（缺省回退 from） */
  displayName?: string;
  /** 群显示名 */
  groupName: string;
  /** 消息正文 */
  content: string;
}

/**
 * 构造群消息的 `<msg>` 视图封装。own 消息不包装的规则由调用方持有
 * （readSince 按 viewer 判定；与将来的 history() 回放层一致）。
 */
export function wrapGroupMsg(params: GroupMsgViewParams): string {
  const name =
    params.displayName && params.displayName !== params.from ? params.displayName : params.from;
  return `<msg from="${escapeMsgAttr(params.from)}" name="${escapeMsgAttr(name)}" group="${escapeMsgAttr(params.groupName)}">${params.content}</msg>`;
}
