import type { MessageSource, ToolCall as SharedToolCall } from '@agentchat/protocol';

// ============================================================
// 前端 WebSocket 消息类型
// ============================================================

// AgentInfo 已随行走迁 ac-client-ui-agents/client（M27 S3-1b——owning = 行包双半边；
// re-export 维持旧路径；行包版含 tags 能力标签超集，结构兼容本处旧形）
export type { AgentInfo } from 'ac-client-ui-agents/client';

/** 思维链中的一个子步骤：一次 assistant thinking + 其触发的工具执行 */
export interface TurnStep {
  /** 发起工具调用的 assistant 消息（含 thinking + toolCalls） */
  assistant: ChatMessage;
  /** 匹配 tool_call_id 的工具执行结果 */
  tools: ChatMessage[];
  /** 是否仍在流式传输中 */
  isStreaming: boolean;
}

/** 一个完整的对话轮次：任意 Agent（含用户）的思考+回复 */
export interface Turn {
  agent_id: string;
  /** 轮身份键（cr-1286 P4-1）：轮首行 turnId（启发域轮缺席）——渲染 key 源 */
  turnId?: string;
  steps: TurnStep[];
  /** 最终纯文本回复（无 toolCalls 的 assistant），可为 null */
  final: ChatMessage | null;
  /**
   * 挂靠注入卡（2026-09-26 注入卡·数据层归位）：buildTurns 中注入型
   * context 行不拆轮，原位挂进当前在场轮（afterStep = 挂靠时刻步数
   * ——run 中途注入落在两步之间，还原落盘序）；cur 为空/viewer 轮时
   * 暂存挂下一 agent 轮头部。渲染在思考过程折叠链内（TurnDisplayItem
   * 步循环按 afterStep 插卡）。
   */
  injects?: InjectCard[];
}

/**
 * 注入卡数据（Turn.injects 携带；独立降级卡 item 同形）：
 * label = 落账行 UI 文案（如「已加载技能 demo」）；content = 注入体原文
 * （缺席 = 直播行，仅收起态可看）；kind = 存储 source 决策词（降级位
 * 重建 event turn 用）；afterStep = 链内插入位（挂靠时刻所在轮已积步数
 * ——渲染时插在该步之后；0/缺省 = 链头，= steps.length = 链尾）。
 */
export interface InjectCard {
  label: string;
  content?: string;
  kind?: string;
  /** 注入归属 agent（cr-765 #6）：挂轮按归属匹配轮次，群聊不挂错轮 */
  agent_id?: string;
  /** 结构化载荷（cr-765 #4：问答卡 Q/A——questions/answers/outcome；
   *  旧行缺席 → UI 回落纯文本） */
  payload?: { questions?: Array<{ question: string; options?: string[]; multi?: boolean }>; answers?: Array<string | string[] | null>; outcome?: 'answered' | 'timeout' };
  /** 注入体字节数（cr-765 #5：直播行载入态 meta——content 缺席窗口期显示「载入中 · N KB」） */
  bytes?: number;
  /** 挂靠锚（cr-1132：投影层派生——时间线上最近 agent 发言行 message_id；
   *  窗口内按锚精确挂轮，锚被窗口边界切掉时挂下一 agent 轮头） */
  anchor?: string;
  /** run 归口键（cr-1285 P3-4）：直播帧与刷新投影行同键——注入卡挂到
   *  该 run 所在轮（afterStep 按同 run 步序定位），取代位置启发 */
  runId?: string;
  ts?: number;
  afterStep?: number;
  key: string;
}

/** ChatView 的渲染单元 */
export interface DisplayItem {
  type: 'turn' | 'time-separator' | 'event' | 'error' | 'inject';
  turn?: Turn;
  timeText?: string;
  /** 事件/错误分隔符自身的毫秒时间戳，用于在分隔符内显示时间 */
  timestamp?: number;
  /** 连排 hint（event/error）时间戳归并：false = 窗口内已有时间锚，不显示自身时间 */
  showTime?: boolean;
  /** （event）run 中插播：前后均為同 agent 轮（仅被 event 打断）→ 紧凑内联样式 */
  midRun?: boolean;
  /** （turn）延续轮：前面仅隔 event 分隔的同 agent 轮 → 不再重复头像/名称 */
  continuation?: boolean;
  /** 稳定渲染 key（内容标识而非数组下标）：历史前插时下标全量平移会导致
   *  整个消息列表重建（展开态/卡片内部状态丢失、长会话上翻闪烁卡顿） */
  key?: string;
  /** （inject 独立降级卡）注入卡数据（前后皆无 agent 轮可挂时占位） */
  inject?: InjectCard;
}

/** 工具调用（来自 shared 契约，保持单源） */
export type ToolCall = SharedToolCall;

export interface ChatMessage {
  id: string;
  role: 'agent' | 'user' | 'tool' | 'event' | 'error';
  content: string;
  /**
   * 步身份键（2026-09-24 身份贯通）：直播行由流式帧 meta 驻留、历史行由
   * steps[].stepId 展开透传——两表示同键 = 同一事实。历史合并与 subcall
   * 宿主定位按键配对（取代位置/内容前缀猜测）；旧行无键回落启发式路径。
   */
  stepId?: string;
  /**
   * run 身份键（cr-699 run 内连续性）：历史 steps 展开行由记录 run 透传。
   * buildTurns 对同 run 相邻消息豁免 solo/平文/时间间隔拆分——中断-续跑
   * 的长程 run 恒为一条思考链（run 边界（信封/收束行）才是拆轮判据）。
   */
  runId?: string;
  /**
   * 轮身份键（cr-1286 P4-1 投影分组）：前端轮分组的权威键——投影行 =
   * run（run 承载行）/ message_id（用户行）；直播步行随步帧 run 键驻留
   * （cr-1289：= run，与投影同语义）；用户本地行出生带键（cr-1319：
   * id = requestId = 落盘 message_id）。双方在场同值恒并轮、异值恒拆轮；
   * 缺席域收窄为 v0 旧写面存量（读侧按 sender 拆轮——cr-1321 判据退役）。
   */
  turnId?: string;
  /**
   * 投递标记（cr-1332 白名单词汇——历史行透传/直播行缺省）：入站 = true /
   *  终稿 = 'final'。白名单模式会话的行集判据（终稿独特值——用户裁决便于
   *  观察打标/不打标效果）；渲染层 IM 档终稿标记显示面。
   */
  delivered?: boolean | 'final';
  /** 持久化消息 ID，用于后端删除操作 */
  persistedMsgId?: string;
  /**
   * 行级单调序号（B1 行级 seq 持久化）：历史行随 session/history 行携带
   *（writer 跨实例续接后单调；存量行缺席）。直播帧侧配对/去重的水位锚
   *（B2 帧携带 runId+seq 后启用过滤）。
   */
  seq?: number;
  /** 消息来源 Agent ID */
  agent_id?: string;
  /** 事件/入站消息来源元数据（event 分隔符渲染用） */
  source?: MessageSource;
  toolCalls?: ToolCall[];
  toolName?: string;
  tool_call_id?: string;
  name?: string;
  /** 工具调用参数（对象或 OpenAI 风格 JSON 字符串）；用于结果返回前渲染专用卡片 */
  arguments?: unknown;
  /** 思考过程（reasoning_content） */
  thinking?: string;
  /** 思考过程（别名，兼容 maid_webui 组件） */
  reasoning_content?: string;
  /**
   * 步内相位序标记（直播 = llm/delta 首见先后自判；历史 = steps 展开透传）：
   * true = 本步正文先于工具调用分片到达——思考过程卡片步内渲染序据此
   * 排布（思考恒前；正文/工具卡相对序）。缺省 = 工具在前（常见形态）。
   */
  textBeforeTools?: boolean;
  /**
   * 中止步标记（cr-766）：LLM 流被 abort 时的部分聚合步——历史展开行
   * 透传（journal aborted）。渲染层据此显示中断态（部分正文 + 已中断
   * 标识）；工具卡无结果（调用未执行）。
   */
  aborted?: boolean;
  /** 思考标签（后端推送，含耗时信息） */
  label?: string;
  /**
   * 注入正文（context 注入行专用——2026-09-26 注入卡）：role:'event' 行的
   * content 是 label 文案；注入体原文（<system-reminder>…）放本字段随行
   * 透传，卡片展开体渲染之。历史行由 toHistoryMessages 展开携带；直播
   * 行缺席（帧不广播正文——瘦身纪律），settlement 重拉权威行后在场。
   */
  contextContent?: string;
  /**
   * 注入结构化载荷（cr-765 #4 问答卡：context 注入行专用）——Q/A 数据面
   *（questions/answers/outcome）；旧行缺席 → UI 回落纯文本正文。
   */
  payload?: InjectCard['payload'];
  /**
   * 注入体字节数（cr-765 #5：context 注入行专用——直播帧轻量 meta）。
   * content 缺席窗口期（落账 → settlement 重拉完成）卡片显示
   * 「载入中 · N KB」，不再「点击无反应」。
   */
  injectBytes?: number;
  /**
   * 挂靠锚（cr-1132：context 注入行专用——投影层派生的时间线锚，
   * 指向最近 agent 发言行 message_id）。buildTurns 据此挂轮，不再窗口
   * 局部猜测归属。
   */
  anchor?: string;
  /**
   * 思考相位起点（epoch ms；直播首个 reasoning 片到达时驻留消息——与
   * StreamState.reasoningStartAt 同源）：「思考中 · Xs」实时计时与收束
   * label（前端 closeThinking / 后端 reasoningMs）共用同一起点，收束时
   * 计时不倒跳。历史回放无此键（有落盘的 reasoningMs 定格 label）。
   */
  reasoningStartAt?: number;
  /**
   * 本 run 前端起点（epoch ms；loop/run-started 帧到达时驻留分区，
   * step-started 建占位时转驻消息）：链栏前端计时的过渡期起点
   * （首个 after-step 校准锚到达前）。多轮会话中每轮 run 独立计时——
   * 不得用会话首条消息/turn 首步时刻冒充（跨 run 并轮/定时触发场景
   * 会把轮间间隔算进去）。历史回放无此键。
   */
  runStartAt?: number;
  /**
   * 本步 API 流时间（ms；after-step 透传——dispatch 层计时，不含工具/
   * 编排）。与 apiCompletion 成对出现，链头速率（Σcompletion/Σms——
   * 输出口径：prompt 随上下文单调膨胀会令 total 比率持续虚高）逐步累计。
   */
  apiMs?: number;
  /** 本步补全输出 token（usage.completion） */
  apiCompletion?: number;
  /**
   * 链栏耗时校准对（直播 run 期间，after-step 逐步写入）：后端权威的
   * 「截至最近步收束」耗时锚（ms）+ 该锚到达本机的时刻（epoch ms）。
   * 显示 = anchorMs + (now - anchorAt)——前端在 backend 耗时基础上
   * 重新计时，下步收束再次覆盖（逐步收敛于真实值，消除前端计时随
   * 流式帧延迟漂移）。驻留消息分区，跨步重建不丢；run 收束后不再变化
   * （定格末次校准值，最终以收束重拉的权威行为准）。
   */
  runCalibMs?: number;
  runCalibAt?: number;
  /**
   * run 墙钟耗时（毫秒，cr-772；历史首步在场——终稿行 runMs 取源）。
   * 历史链栏「用时」段权威锚：无校准对（非流式回放）时直接消费；
   * 直播期缺席（校准对承担）。
   */
  runMs?: number;
  isStreaming?: boolean;
  status?: 'running' | 'success' | 'error';
  isError?: boolean;
  /**
   * run_code 子调用标记（2026-09-17 方向 B）：true = 本工具卡由 run_code
   * 程序内子调用产生（直播 = after-execute runCodeSubcall 平铺；历史 =
   * session subcalls 投影注入 steps）。渲染层加缩进样式（视觉归属
   * run_code 卡）；fileEdits 等追踪层据 toolCalls 天然收录。
   */
  subcall?: boolean;
  timestamp: number;
  files?: FileAttachment[];
}

export interface FileAttachment {
  hash: string;
  filename: string;
  filesize: number;
  text?: string;
}

// ============================================================
// 群组类型
// ============================================================

/** 群组信息（前端展示用） */
export interface GroupInfo {
  group_id: string;
  name: string;
  participants: string[];
  created_at: number;
  description?: string;
  /** 最近活动时间戳（毫秒），由前端 WS 消息驱动，与 Agent.lastActivity 统一排序 */
  lastActivity?: number;
}
