// ============================================================
// ac-group/src/contract.ts —— 群域契约（纯类型，零运行时）
//
// 单通道 v3（src 四次消息重复事故的沉淀）：群本体（sessions/groups/<gid>/，
// D11 存储统一）是群消息内容的【唯一事实源】——hint 通知不承担内容权威。
// cr-4 后成员上下文 = 私有转录流（post 扇出投影），派生窗族（readSince/
// windowOf/deriveWindow）已退役。
// `<msg from name group>` 包装（view.ts）是唯一构造点（ADR-3：拼接层归
// 本包，LLM 层只收已合法的 OpenAI 形消息）。
// 投递通道：ctx.conversation.deliver(member, hint, { conversationId: gid })
// ——成员流键 = gid~member（每参与者独立串行化门），busy=steer、idle=新 run。
// ============================================================
import type { ConversationOutcome, ConversationPlacement } from 'ac-conversation';
import type { LlmAttachment } from 'ac-llm';

/** 群配置（成员表） */
export interface GroupConfig {
  /** 群 id（= 会话桶 conversationId） */
  id: string;
  name: string;
  /**
   * 参与者 Agent id 列表（'user' 是保留发送端点，不入成员表——但恒在群
   * 内：完整参与面〔展示/注入用〕走 membersWithUser，members 保持纯
   * Agent 语义〔send 触发目标、属主校验等〕）。
   */
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
   * 成员回复的 ReAct 步记录（**兼容字段**——M26 前回复曾随 reply-completed
   * 入群本体；M26 行为对齐后群本体只收真实发言 post 行，新数据不再产生
   * 本字段，旧文件/轮转归档段仍可能携带，读取侧照常透传）。
   */
  steps?: Array<{
    content: string;
    reasoning?: string;
    /** 步内相位序（兼容透传——同 SessionStepRecord.textBeforeTools） */
    textBeforeTools?: boolean;
    toolCalls?: Array<{
      id: string;
      name: string;
      /** 参数原始 JSON 字符串 */
      arguments: string;
      /** 工具体返回的 ToolResult（对象原样 JSON 往返） */
      result: unknown;
    }>;
  }>;
  /** 成员回复的整轮思维链（兼容字段——同上，M26 前遗留行透传） */
  reasoning?: string;
  /**
   * 多模态附件引用（M4 群聊图片：本体行 attachments 透传——用户发言
   * 可带 image/video/file 引用；成员流扇出投影与 UI 恢复消费）。
   */
  attachments?: LlmAttachment[];
}

export interface GroupSendOptions {
  /** 会话繁忙策略（透传 conversation.deliver；缺省 'steer'） */
  placement?: ConversationPlacement;
  /**
   * true = 等待全部投递收尾并在结果中给出逐参与者 outcome（编排/测试用）；
   * 缺省 false = trigger 语义 fire-and-forget（对齐 src：受理即返回）。
   */
  settle?: boolean;
  /**
   * 多模态附件引用（M4 群聊图片）：随本体行落盘（后续 run 经 historyFor
   * 可见）+ 随 hint 信封直达（首个 run 即可见）。
   */
  attachments?: LlmAttachment[];
}

export interface GroupSendResult {
  /** 已入流的消息记录（内容通道） */
  message: GroupMessageRecord;
  /** 已触发的参与者（不含发送者） */
  triggered: string[];
  /** settle:true 时的逐参与者投递结果 */
  delivery?: Record<string, ConversationOutcome>;
}
