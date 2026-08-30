// ============================================================
// ac-group/src/contract.ts —— 群域契约（纯类型，零运行时）
//
// 单通道 v3（src 四次消息重复事故的沉淀，原样继承）：
//   · 群消息流（本服务的内存日志；M13 ac-group-store 换文件后端）
//     是群消息内容的【唯一事实源】——trigger 通知不承担内容权威；
//   · busy 参与者经 readSince(锚点) 读增量注入；idle 参与者触发新 run
//     （M9 用 tail 形态：通知携带 <msg> 全文 + 时间；notify 纯通知形态
//     随 M10 会话持久化落地）；
//   · `<msg from name group>` 包装（view.ts）是唯一构造点（ADR-3：
//     拼接层归本包，LLM 层只收已合法的 OpenAI 形消息）。
//
// 投递通道：ctx.conversation.deliver(member, hint, { conversationId: gid })
// ——handle = gid~member（每参与者独立串行化门），busy=steer、idle=新 run。
// ============================================================
import type { ConversationOutcome, ConversationPlacement } from 'ac-conversation';

/** 群配置（成员表） */
export interface GroupConfig {
  /** 群 id（= 会话桶 conversationId） */
  id: string;
  name: string;
  /** 参与者 Agent id 列表（'user' 是保留发送端点，不入成员表） */
  members: string[];
  description?: string;
  createdAt: number;
}

/**
 * 群消息记录（内容通道的唯一形态）。
 * D11：本体 = sessions/groups/<gid>/（SessionRecord 中性行）——本形状是
 * 本体行的群域投影（records()/group/history RPC 消费；UI 渲染词汇）。
 */
export interface GroupMessageRecord {
  /** 消息 id（= 本体行 message_id；锚点定位/幂等对账用） */
  id: string;
  groupId: string;
  /** 发送者：'user' 或成员 Agent id（= 本体行 agent_id） */
  from: string;
  content: string;
  /** 毫秒时间戳（= 本体行 timestamp） */
  at: number;
  /**
   * 成员回复的 ReAct 步记录（D11：本体行 steps[] 透传——群成员工具
   * 卡片/思维链刷新不丢；用户发言无此字段）。形状与 ac-session
   * SessionStepRecord 结构一致（纯类型域间结构化兼容，零运行时依赖）。
   */
  steps?: Array<{
    content: string;
    reasoning?: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      /** 参数原始 JSON 字符串 */
      arguments: string;
      /** 工具体返回的 ToolResult（对象原样 JSON 往返） */
      result: unknown;
    }>;
  }>;
  /** 成员回复的整轮思维链（本体行 reasoning_content 透传） */
  reasoning?: string;
}

/** 群消息增量读取锚点：messageId 优先定位，index 回退（轮转/修剪预留） */
export interface GroupFeedAnchor {
  messageId?: string;
  index?: number;
}

/** readSince 返回页 */
export interface GroupFeedPage {
  /** 已按群消息视图包装的注入文本（own 消息原文、peer 消息 <msg> 包装）；空串 = 无增量 */
  injected: string;
  /** 增量包含的原始消息 id（诊断/测试用） */
  messageIds: string[];
  /** 推进后的锚点（= 本页最后一条；空页 = 当前流尾） */
  anchor: GroupFeedAnchor;
}

export interface GroupSendOptions {
  /** 会话繁忙策略（透传 conversation.deliver；缺省 'steer'） */
  placement?: ConversationPlacement;
  /**
   * true = 等待全部投递收尾并在结果中给出逐参与者 outcome（编排/测试用）；
   * 缺省 false = trigger 语义 fire-and-forget（对齐 src：受理即返回）。
   */
  settle?: boolean;
}

export interface GroupSendResult {
  /** 已入流的消息记录（内容通道） */
  message: GroupMessageRecord;
  /** 已触发的参与者（不含发送者） */
  triggered: string[];
  /** settle:true 时的逐参与者投递结果 */
  delivery?: Record<string, ConversationOutcome>;
}
