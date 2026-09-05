// ============================================================
// utils/feed.ts —— 统一信息流纯函数层
//
// 单一真相源原则：
//   rawMessages（append-only 事件流） → buildTurns() 纯函数 → Turn[]
//   视图只消费派生结果，不直接维护第二份展示数据。
//
// 设计文档：docs/feed-architecture.md
// ============================================================

import type { ChatMessage, FileAttachment, Turn, TurnStep } from '../types';
import { VIEWER_ID } from '../constants';

// ── Dialog 标识 ──

/**
 * DialogKind（M19/D4：direct 分区废除——viewer 直答也是对桶）：
 *   pair   = 对桶（含 viewer ⇒ 直答可写会话；不含 ⇒ 矩阵只读视角）
 *   group  = 群聊
 *   single = 独立会话（P3：同一 Agent 的多个隔离上下文）
 */
export type DialogKind = 'pair' | 'group' | 'single';

/**
 * 对话 ID（前端统一信息流的路由键，M19/D4 全对键统一）：
 *   pair:${a}|${b}（对桶：两端点排序后 | 连接——含 viewer 的即原直答
 *                会话，可写；不含 viewer 为 Agent 对只读视角）
 *   group:${groupId}（群聊）
 *   single:${sessionId}（独立会话）
 */
export type DialogId = `pair:${string}` | `group:${string}` | `single:${string}`;

/** 后端对桶键的镜像（pairKey(a,b)：排序 `~` 连接；与 conversationId 同词表） */
export function bucketKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

/** 构造 pair 对话 ID（两端点排序去序，保证同对会话共享分区缓存） */
export function pairDialog(a: string, b: string): DialogId {
  return `pair:${[a, b].sort().join('|')}`;
}

/**
 * 直答会话 ID（viewer⇄agent 对桶）：M19/D4 废除 direct: 分区——统一
 * pair: 键，本函数是"点开 Agent 即对话"的 viewer 相对糖（对端 = agent）。
 */
export function directDialog(agentId: string): DialogId {
  return pairDialog(VIEWER_ID.value, agentId);
}

/**
 * pair 分区键（'a|b'）→ 对端解析：含 viewer 取另一端（直答对端）；
 * 不含 viewer（Agent 对视角）取首端（真实身份由流式帧的 streamAgent 覆盖）。
 */
export function pairPartnerOf(key: string): string {
  const parts = key.split('|');
  if (parts.length !== 2) return key;
  const viewer = VIEWER_ID.value;
  if (parts[0] === viewer) return parts[1];
  if (parts[1] === viewer) return parts[0];
  return parts[0];
}

/** pair 分区是否含 viewer（可写直答会话判定；不含 = 矩阵只读视角） */
export function pairHasViewer(key: string): boolean {
  return key.split('|').includes(VIEWER_ID.value);
}

/** 构造 group 对话 ID */
export function groupDialog(groupId: string): DialogId {
  return `group:${groupId}`;
}

/** 构造 single 对话 ID（独立会话） */
export function singleDialog(sessionId: string): DialogId {
  return `single:${sessionId}`;
}

/** 解析 DialogId → { kind, key } */
export function parseDialogId(id: DialogId): { kind: DialogKind; key: string } {
  const sep = id.indexOf(':');
  const kind = id.slice(0, sep) as DialogKind;
  const key = id.slice(sep + 1);
  return { kind, key };
}

// ── 历史分页合并（原 chat.ts 迁移，保持纯函数）──

/** 耗时格式：45s / 12m34s / 1h2m5s（时/分为 0 的前导单位隐藏，数字均
 *  不补零——99h59m59s 形态）。思考消息「已思考 | XmYs」与链栏耗时共用。 */
export function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h${m}m${ss}s`;
  if (m > 0) return `${m}m${ss}s`;
  return `${ss}s`;
}

/**
 * 历史分页合并：新返回的较早消息在前 + 已有较晚消息在后，按 message_id 去重防重复。
 * 返回 [合并去重后的消息, 该页 user 链数]（userCount 用于按轮次校准分页 offset）。
 * viewerId：用户侧身份（调用方传 VIEWER_ID，此前硬编码 'user'——若未来
 * VIEWER_ID 可配置，分页 offset 校准会错算）。
 */
export function mergeHistoryPage(
  incoming: ChatMessage[],
  existing: ChatMessage[],
  isFirstPage: boolean,
  viewerId = 'user',
): { merged: ChatMessage[]; userCount: number } {
  const raw = isFirstPage ? incoming : [...incoming, ...existing];
  const seen = new Set<string>();
  const merged = raw.filter((m) => {
    if (m.persistedMsgId && seen.has(m.persistedMsgId)) return false;
    if (m.persistedMsgId) seen.add(m.persistedMsgId);
    return true;
  });
  const userCount = incoming.filter((m) => m.agent_id === viewerId).length;
  return { merged, userCount };
}

// ── Turn 构建（rawMessages → Turn[]）──

/** 流式内部消息形态（thinking + tool_calls + content） */
interface FeedAgentMsg {
  thinking: string;
  tool_calls: any[];
  content: string;
  ts: number;
  label?: string;
  /** 流式中（用于派生 turns 保留 isStreaming，驱动流式渲染与思考相位判定） */
  isStreaming?: boolean;
  /** 原始消息 id：final 沿用之（此前合成 `final-<ts>` → edit/regenerate/delete
   *  按 id 查找 rawMessages 永远 -1，操作按钮静默失效） */
  id?: string;
  /** 用户附件（final 渲染附件 chips 用；派生时丢失会导致附件不显示） */
  files?: any[];
  agent_id?: string;
}

/** 同 sender 连续消息的时间合并阈值：间隔超过该值视为不同会话轮次（如定时广播），不合并 */
const MERGE_GAP_MS = 10 * 60 * 1000;

/**
 * 将 AgentMsg 数组转换为 TurnStep[] + final ChatMessage（原 _agentMsgsToSteps）。
 * 纯函数：输入不可变，输出全新对象。
 */
function buildTurnFromAgentMsgs(msgs: FeedAgentMsg[], streaming: boolean, agentId: string): Turn {
  const steps: TurnStep[] = msgs.map((t, i) => {
    const ts = t.ts || Date.now();
    const stepStreaming = streaming || (i === msgs.length - 1 && !!t.isStreaming);
    const asst: ChatMessage = {
      id: `step-${ts}-${i}`, role: 'agent', content: t.content || '',
      label: t.label || '', thinking: t.thinking, reasoning_content: t.thinking,
      toolCalls: (t.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) as any,
      isStreaming: stepStreaming && i === msgs.length - 1, timestamp: ts,
    };
    const tools: ChatMessage[] = (t.tool_calls || []).map((tc: any) => ({
      id: `tool-${tc.id}`, role: 'tool', content: tc.result || '',
      name: tc.name, toolName: tc.name, tool_call_id: tc.id, label: tc.label || tc.name || '',
      // 携带工具参数：让 ToolMessage 在"结果返回前"即可按参数渲染专用卡片
      // （如 bash 显示命令、edit/read 显示文件路径），无需等结果 JSON。
      arguments: tc.arguments,
      isStreaming: stepStreaming ? (tc.running || !tc.result) : !tc.result,
      status: stepStreaming && (tc.running || !tc.result) ? 'running' : undefined, timestamp: ts,
    } as ChatMessage));
    return { assistant: asst, tools, isStreaming: stepStreaming && i === msgs.length - 1 };
  });
  // final 的强生命周期语义（loop/after-run）：
  //   · loop 进行中——final 悬置（null）：正文尚属链内在出的口述、不是
  //     定稿，展示层以步骤流式渲染。在途判定 = run 级 streaming（步间
  //     静默窗口：上一步 after-step 已关闭消息级标记、下一步 step-started
  //     未到——整个 LLM API 往返期间消息级全关，只有 run 级信号在场）
  //     ∨ 轮内有消息仍带 isStreaming 标记；
  //   · after-run（熄灭点 = 自然收束步（无工具调用）/ loop/after-run 帧
  //     → closeAllStreaming 关闭全部标记）——final 一次性物化为「最后
  //     step 的正文」：取最后一条有正文的消息（与收束行 result.text
  //     一致；末步无正文时为其前最后的正文），全轮无正文退回末条
  //     （与原行为一致），恒非流式。
  // 修复史：final 曾 ≡ 字面末条消息——新步以空 thinking 开始即翻空 →
  // 正文气泡闪退 + stableKey（含 final 正文长度）反复变化整轮重挂载；
  // 又曾只看消息级标记——步间静默窗口被误判收束，口述正文闪现成 final。
  // steps 内与 final 同正文的步由展示层去重（既有逻辑）。
  const inFlight = streaming || msgs.some(m => m.isStreaming);
  let src = msgs[msgs.length - 1];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if ((msgs[i].content || '').trim()) { src = msgs[i]; break; }
  }
  const final: ChatMessage | null = inFlight ? null : {
    // 沿用原始消息 id（缺省才合成）：edit/regenerate/delete 按 id 定位 raw 消息，
    // 合成 id 永远查不到 → 操作按钮静默失效
    id: src.id || `final-${src.ts || Date.now()}`, role: 'agent',
    content: src.content || '',
    reasoning_content: '', thinking: '',
    files: src.files, agent_id: src.agent_id,
    isStreaming: false,
    timestamp: src.ts || Date.now(),
  } as ChatMessage;
  return { agent_id: agentId, steps, final };
}

/**
 * 由原始消息流构建 Turn[]（原 _buildAgentTurnsForHistory）。
 * - event 消息（定时/归档/继续/重启等系统事件）→ 独立 system turn（渲染为分隔符）
 * - agent/user 消息按 sender 分组为 turn 链；同 sender 但间隔过长 → 拆分为独立轮次
 * - tool 消息匹配 tool_call_id 补 result/label
 */
export function buildTurns(msgs: ChatMessage[], streaming = false): Turn[] {
  const allTurns: Turn[] = [];
  let cur: { agent_id: string; turns: FeedAgentMsg[] } | null = null;

  // 预计算（自尾向头）：各位置之后下一条 agent/user 消息的 sender——
  // 判定"平文中段插行"（同 sender 后续还有消息 → 拆轮保位渲染）与
  // "组尾终稿"（后续无同 sender 消息 → 并入当前轮作 final）。
  // 背景（2026-09-02 顺序反馈）：run 中途的插行（send_agent 投递、机制
  // 通知前后的步）按步级 ts 排序后会落在同 sender 步骤之间——不拆轮会被
  // 吞进"思考过程"折叠链（视觉消失）；拆轮则渲染位置与落盘序一致。
  const nextSenderOf: Array<string | null> = new Array(msgs.length).fill(null);
  let nextSender: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    nextSenderOf[i] = nextSender;
    const m = msgs[i];
    if (m.role === 'agent' || m.role === 'user') nextSender = m.agent_id || '';
  }

  // live：run 级流式态只作用于「末尾轮」——中段 flush 的轮次被后续消息
  // 关闭、按定义已完成（否则 run 中的历史轮会被误标流式）
  const flush = (live = false) => {
    if (cur?.turns.length) {
      allTurns.push(buildTurnFromAgentMsgs([...cur.turns], live, cur.agent_id));
      cur = null;
    }
  };

  /** 上一条 agent/user 消息是否为"中段插行平文"（其后的同 sender 消息须另起一轮——插行才独立成轮） */
  let afterSolo = false;

  for (let k = 0; k < msgs.length; k++) {
    const msg = msgs[k];
    // event 系统事件消息：渲染为独立系统分隔符，不进普通 turn 链。
    // 兼容历史 API 归一化后的旧 trigger：user + source.legacyRole==='trigger'。
    const isEventMsg = msg.role === 'event'
      || (msg.role === 'user' && (msg.source as any)?.legacyRole === 'trigger');
    if (isEventMsg) {
      flush();
      const ts = msg.timestamp || Date.now();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        // 时间线分隔符展示完整事件正文（可多行换行）；source.summary 仅用于列表/活动摘要
        final: { id: `event-${ts}-${allTurns.length}`, role: 'event', content: msg.content || msg.source?.summary || '', timestamp: ts, agent_id: 'system', source: msg.source },
      });
      continue;
    }
    // error 消息（如 LLM 调用失败）：独立系统 turn，渲染为红色错误分隔符（同 event 分隔）
    if (msg.role === 'error') {
      flush();
      const ts = msg.timestamp || Date.now();
      allTurns.push({
        agent_id: 'system',
        steps: [],
        final: { id: `error-${ts}-${allTurns.length}`, role: 'error', content: msg.content || '', timestamp: ts, agent_id: 'system' },
      });
      continue;
    }
    if (msg.role === 'agent' || msg.role === 'user') {
      // 跳过完全空白的流式占位（thinking/content/toolCalls 皆空），避免产生空气泡；
      // 附件 chips 在场（纯附件消息 content 为空）不算空白——否则刷新后
      // chips-only 用户气泡整条消失
      const empty = !msg.content && !msg.thinking && !msg.reasoning_content && !(msg.toolCalls?.length) && !(msg.files?.length);
      if (empty) continue;
      const senderId = msg.agent_id || '';
      const ts = msg.timestamp || Date.now();
      const lastTurn = cur?.turns[cur.turns.length - 1];
      const gapTooLong = !!cur && !!lastTurn && (ts - lastTurn.ts) > MERGE_GAP_MS;
      // 无思考无工具的纯正文消息（如 send_agent 投递）：若当前轮已有完整正文，
      // 单独成轮 —— 否则它会把上一条正经回复吞进思维链折叠栏（正文被折叠）。
      const isPlainBody = !!msg.content && !msg.thinking && !msg.reasoning_content && !(msg.toolCalls?.length);
      const prevComplete = !!lastTurn && !!lastTurn.content && !(lastTurn.tool_calls?.length);
      const plainAfterComplete = isPlainBody && prevComplete;
      // 平文中段插行：同 sender 后续还有消息 → 独立成轮（拆轮保位，不被
      // 折叠链吞掉）；其后的下一条同 sender 消息另起一轮（afterSolo）——
      // 否则后续步骤会并入插行所在轮、把插行顶回链内。组尾平文（final
      // 文本）不拆，正常并入作终稿。
      const senderContinues = nextSenderOf[k] === senderId;
      const solo = isPlainBody && senderContinues;
      if (!cur || cur.agent_id !== senderId || gapTooLong || plainAfterComplete || solo || afterSolo) {
        flush();
        cur = { agent_id: senderId, turns: [] };
      }
      afterSolo = solo;
      cur.turns.push({
        thinking: msg.reasoning_content || msg.thinking || '',
        label: (msg as any).label || '',
        // 幻影调用（id/name 双空——provider 空冲洗片的聚合残片）不进派生
        tool_calls: (msg.toolCalls || []).filter((tc: any) => tc.id || tc.name || tc.function?.name).map((tc: any) => ({
          id: tc.id, name: tc.name || tc.function?.name || '',
          arguments: tc.arguments || tc.function?.arguments || '',
          result: '', label: tc.label || tc.name || '',
        })),
        content: msg.content || '',
        ts,
        isStreaming: msg.isStreaming,
        // 透传原始 id/附件/身份：final 沿用（edit/regenerate/delete 按 id 命中、附件渲染）
        id: msg.id,
        files: msg.files,
        agent_id: msg.agent_id,
      });
    }
    if (msg.role === 'tool' && cur?.turns.length) {
      const last = cur.turns[cur.turns.length - 1];
      const tc = last.tool_calls.find((t: any) => t.id === msg.tool_call_id);
      if (tc) { tc.result = msg.content || ''; tc.label = msg.label || msg.name || tc.name; }
    }
  }
  // run 级流式只归 agent 轮：step-started 已点亮 d.streaming 而首个
  // thinking token 未到时（空占位被跳过），末尾轮仍是用户轮——不得悬置
  // 用户消息的 final（否则用户气泡误走 assistant 分支）
  flush(streaming && !!cur && cur.agent_id !== VIEWER_ID.value);
  return allTurns;
}

// ── 增量 Turn 构建（流式性能核心）──

/** 单条消息的稳定签名（内容级变化 → 签名变化；仅 O(1) 长度计算，不做全量哈希）。
 *  注意 toolCalls 必须覆盖每个调用的 result/running/label——onToolEnd/onToolUpdate
 *  会原地改写这些字段，签名漏掉会让 buildTurnsIncremental 误判"无变化"复用
 *  过期 turns（工具卡永久转圈、结果不刷新）。 */
function toolCallsSig(tcs: any[] | undefined | null): string {
  if (!tcs?.length) return '0';
  let s = `${tcs.length}`;
  for (const tc of tcs) {
    s += `|${tc?.id ?? ''}:${(tc?.result?.length ?? 0)}:${tc?.running ? 1 : 0}:${(tc?.label?.length ?? 0)}`;
  }
  return s;
}
function msgSig(m: ChatMessage): string {
  return `${m.id}|${m.role}|${m.content?.length ?? 0}|${m.thinking?.length ?? 0}|${m.reasoning_content?.length ?? 0}|${toolCallsSig(m.toolCalls)}|${m.label?.length ?? 0}|${m.isStreaming ? 1 : 0}`;
}

/** 增量 Turn 构建的缓存状态 */
export interface TurnsMemo {
  /** 已构建的 Turn 列表（完成轮次保持对象身份，可安全复用） */
  turns: Turn[];
  /** 与 msgs 一一对应的消息签名（用于判断"哪些消息变化了"） */
  sigs: string[];
  /** run 级流式态（参与复用判定：d.streaming 翻转 = 生命周期变化，
   *  即使消息签名全同也须重建——final 悬置/物化依赖它） */
  streaming: boolean;
}

/**
 * 增量 Turn 构建。
 *
 * 流式更新只改写最后一条消息（content/thinking/toolCalls/label/isStreaming 原地追加），
 * 前缀消息与 turn 分组均不变 → 复用先前 turn 的对象身份，仅重建最后一个 turn。
 * Vue 中其余 TurnDisplayItem 因 props 身份不变而完全跳过重渲染，
 * 消除"每个 token 全列表刷新"的卡顿（即"逐帧刷新全部消息"的根源）。
 *
 * 判定规则（O(n) 指针/签名比较，常数极小，远低于 markdown/DOM 开销）：
 * - streaming 标志或签名完全相同 → 零重建，整体复用；
 * - 仅最后一条消息签名变化 → 前缀 turn 复用身份，只重建最后一个 turn；
 * - 其余任何变化（结构性增删 / 多条消息变化 / 前缀消息被替换）→ 全量重建。
 *   注意：结构性变更（removeMessage/replaceMessage/setRaw/mergeHistory 等）会
 *   由 feed store 显式失效 memo，这里仍是纯函数兜底。
 *
 * 纯函数：输入 prev 状态 + 消息数组 + run 级流式态，输出新状态（含可复用的 turns）。
 */
export function buildTurnsIncremental(prev: TurnsMemo | null, msgs: ChatMessage[], streaming = false): TurnsMemo {
  const sigs = msgs.map(msgSig);
  const stateSame = !!prev && prev.streaming === streaming;
  if (stateSame && prev && prev.sigs.length === sigs.length) {
    let same = true;
    let onlyLast = true;
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i] !== prev.sigs[i]) {
        same = false;
        if (i < sigs.length - 1) onlyLast = false;
      }
    }
    if (same) return prev; // 无实际变化 → 完全复用
    const full = buildTurns(msgs, streaming);
    // 仅最后一条消息变化且分组结构稳定 → 复用前缀 turn，只替换最后一个
    if (onlyLast && full.length > 0 && full.length === prev.turns.length) {
      return {
        turns: [...prev.turns.slice(0, full.length - 1), full[full.length - 1]],
        sigs,
        streaming,
      };
    }
    // 分组结构变化（罕见）→ 全量
    return { turns: full, sigs, streaming };
  }
  return { turns: buildTurns(msgs, streaming), sigs, streaming };
}

/** 从消息中查找最后一条流式消息（可选 role 过滤） */
export function lastStreaming(msgs: ChatMessage[], role?: 'agent' | 'tool'): ChatMessage | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isStreaming && (!role || m.role === role)) return m;
  }
  return null;
}

/** 关闭所有流式标记 */
export function closeAllStreaming(msgs: ChatMessage[]): void {
  for (const m of msgs) { if (m.isStreaming) m.isStreaming = false; }
}

/** 附件引用数组 → ChatMessage.files（多模态 M3/M4：text=ref 即 workspace
 *  路径，chips 点击预览/图片缩略图共用；无合法项 → undefined 不落键） */
export function attachmentFilesOf(
  atts: Array<{ kind?: string; ref?: string; filename?: string }> | undefined,
): import('../types').FileAttachment[] | undefined {
  if (!Array.isArray(atts) || atts.length === 0) return undefined;
  const files = atts
    .filter((a) => a && typeof a.ref === 'string' && a.ref)
    .map((a) => ({
      hash: '',
      filename: a.filename ?? a.ref ?? '附件',
      filesize: 0,
      text: a.ref as string,
    }));
  return files.length > 0 ? files : undefined;
}

// ── [附件] 行剥离（刷新后气泡与实况同形）──

/** [附件] 行格式（chat store composeContent 的合成词表）：发送侧把附件
 *  合成为正文尾部的 `[附件] <ref>` 行，本函数在展示转换层把它剥回附件
 *  chips——互为镜像，改一处须同步另一处。 */
const ATTACHMENT_LINE_RE = /^\[附件\]\s+(.+)$/;
/** 上传路径未登记时的降级形后缀（composeContent 的 fallback 词表） */
const UNREGISTERED_SUFFIX = '（已上传，路径未记录）';

/** ref 是否可安全视为附件引用（防误吞用户手打的同形文本行）：已有 chips
 *  覆盖（attachments 旁挂，text=ref）、workspace 上传路径（files/ 前缀）、
 *  或路径未登记降级形——三者皆否即用户正文，原样保留。 */
function isAttachmentRef(ref: string, files: FileAttachment[] | undefined): boolean {
  if (files?.some((f) => f && f.text === ref)) return true;
  return ref.startsWith('files/') || ref.endsWith(UNREGISTERED_SUFFIX);
}

/**
 * 用户消息正文尾部的 `[附件]` 行 → 剥离 + 恢复附件 chips。
 *
 * 刷新/回放路径的持久化正文含发送时合成的 `[附件] files/...` 行（LLM 通
 * 路——非视觉模型靠它拿路径 read 附件），直接渲染会与附件 chips 重复且
 * 突兀。本函数只在展示转换层剥离：落盘正文不动，LLM 行为零变化。
 *
 * - 只剥**尾部连续**行（compose 只在正文末尾追加）；任一行不过安全门
 *   即停（其上同形行视为用户正文）；
 * - 行恢复的 chips 与 attachments 旁挂 chips（files 入参）按 ref 去重
 *   合并，顺序 = 行序（= 发送时 files 序）；未被行覆盖的原 chips 保留
 *   （attachments 在场但正文无对应行的旧记录）；
 * - 路径形 ref 取 basename 作文件名（可预览）；降级形保留全文（无路径
 *   不可预览，说明文字不丢）。
 */
export function splitAttachmentLines(
  content: string,
  files?: FileAttachment[],
): { content: string; files?: FileAttachment[] } {
  if (!content.includes('[附件]')) return { content, ...(files?.length ? { files } : {}) };
  const lines = content.split('\n');
  const refs: string[] = [];
  while (lines.length > 0) {
    const ref = ATTACHMENT_LINE_RE.exec(lines[lines.length - 1].trim())?.[1];
    if (!ref || !isAttachmentRef(ref, files)) break;
    refs.unshift(ref);
    lines.pop();
  }
  if (refs.length === 0) return { content, ...(files?.length ? { files } : {}) };
  const used = new Set<FileAttachment>();
  const merged: FileAttachment[] = refs.map((ref) => {
    const hit = files?.find((f) => f && f.text === ref && !used.has(f));
    if (hit) { used.add(hit); return hit; }
    const unregistered = ref.endsWith(UNREGISTERED_SUFFIX);
    return {
      hash: '',
      filename: unregistered ? ref : (ref.split('/').pop() || ref),
      filesize: 0,
      ...(unregistered ? {} : { text: ref }),
    };
  });
  for (const f of files ?? []) if (f && !used.has(f)) merged.push(f);
  return { content: lines.join('\n'), files: merged };
}

/** 群组持久化消息 → ChatMessage（REST 群组历史加载用）。
 *  D11：tool_calls / tool_call_id / reasoning_content 透传（群成员工具
 *  卡片与思维链——与 pairMessageToChatMessage 同款词汇） */
export function groupMessageToChatMessage(m: {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
  attachments?: Array<{ kind?: string; ref?: string; filename?: string }>;
}): ChatMessage {
  const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // [附件] 行剥离（刷新后与实况同形）：正文尾部的合成路径行 → chips
  const split = splitAttachmentLines(m.content ?? '', attachmentFilesOf(m.attachments));
  return {
    id,
    role: (m.role === 'tool' ? 'tool' : 'agent') as ChatMessage['role'],
    content: split.content,
    agent_id: m.agent_id,
    name: m.name,
    label: m.label,
    timestamp: new Date(m.timestamp).getTime(),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(split.files ? { files: split.files } : {}),
  };
}

/**
 * 会话对（pair）持久化消息 → ChatMessage（REST /api/history 加载用）。
 * 与群组转换的差异：event/system/error 角色保留（buildTurns 渲染为分隔符，
 * 系统注入/触发事件在时间线上可见）；tool_calls / reasoning 透传（完整思维链）。
 */
export function pairMessageToChatMessage(m: {
  role: string;
  /** tool 行为 ToolResult 对象（toHistoryMessages steps 展开）；其余为文本 */
  content: unknown;
  agent_id?: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  reasoning_content?: string | null;
  label?: string;
  message_id?: string;
  timestamp?: string;
  attachments?: Array<{ kind?: string; ref?: string; filename?: string }>;
}, fallbackAgentId: string): ChatMessage {
  const id = `pair-${m.message_id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`;
  const role = (m.role === 'tool' ? 'tool'
    : m.role === 'event' || m.role === 'system' ? 'event'
      : m.role === 'error' ? 'error'
        : 'agent') as ChatMessage['role'];
  const files = attachmentFilesOf(m.attachments);
  // tool 行 content 是 ToolResult 对象（toHistoryMessages 的 steps 展开）：
  // 与 historyMsgToChatMessage 同款字符串化——对象漏进 buildTurns 会让
  // parseToolResult 的 content.trimEnd() 抛错（整个分区渲染失败）
  const rawContent = typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content);
  // [附件] 行剥离（刷新后与实况同形）：正文尾部的合成路径行 → chips
  const split = splitAttachmentLines(rawContent, files);
  return {
    id,
    role,
    content: split.content,
    agent_id: m.agent_id ?? fallbackAgentId,
    name: m.name,
    label: m.label,
    reasoning_content: (m.reasoning_content ?? '') || undefined,
    tool_call_id: m.tool_call_id,
    toolCalls: m.tool_calls as any,
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
    ...(split.files ? { files: split.files } : {}),
  } as ChatMessage;
}
