// ============================================================
// ac-client-ui-conversation/client/historyApi.ts —— 历史回放族
//（M27.2-2 随 conversation 件迁入：feed-core 的历史数据面）
//
// 自 webui api/runs.ts（toHistoryMessages/parseToolArgs/
// PMediaAttachment/PSessionRecord/fetchPairHistory）与 api/groups.ts
//（fetchGroupHistory/expandGroupRecord）迁入；webui 两侧 re-export
// 维持旧路径。rpc 契约面注入（webui 包装传 wireRpc 缺省）。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import { fmtElapsed } from './feed.ts';

type Rpc = Pick<RpcClientFace, 'call'>;

// ---- preview 形状（历史回放族） ----

/** 多模态附件引用（与后端 LlmAttachment 同形：image/video/file） */
export interface PMediaAttachment {
  kind: 'image' | 'video' | 'file';
  ref: string;
  mime?: string;
  filename?: string;
  detail?: string;
}

/** 会话历史行（中性格式；session/history RPC 载荷——导出供跨行 type-import，如 SubagentConversationView） */
export interface PSessionRecord {
  role: string;
  content: string;
  message_id: string;
  timestamp: string;
  /** 说话人端点（中性格式归属标记，M21/D13——一切真实发言 role:'agent' 必有） */
  agent_id?: string;
  /** 旧 baked 格式说话人标注（兼容读取） */
  name?: string;
  /** 事件来源标注（role:'event' 行；P3）/ context 行来源决策词（词汇 v2） */
  source?: string;
  /** context 行 UI 文案（词汇 v2；缺省按 source 回落） */
  label?: string;
  /** 思维链全文（agent 回复行；P3——刷新后恢复 thinking 折叠栏） */
  reasoning_content?: string;
  /** ReAct 步记录（agent 回复行；M18 #6——刷新后按步重建工具卡片） */
  steps?: PSessionStep[];
  /** 多模态附件引用（入站消息行；刷新后恢复附件 chips） */
  attachments?: PMediaAttachment[];
}

interface PSessionStep {
  content?: string;
  reasoning?: string;
  /**
   * 步身份键（2026-12 身份贯通）：= `${runId}:${index}——与直播流式帧
   * meta.stepId 同源。历史行带此键时，前端历史合并按键控对齐（直播行与
   * journal 行同键 = 同一步，不靠内容前缀猜测）；旧行无键回落启发式。
   */
  stepId?: string;
  /** 步完成时刻（epoch ms；落盘步级时序锚——收束行展开时恢复中途插行的渲染序） */
  ts?: number;
  /** 步内相位序（落盘透传）：true = 本步正文先于工具调用——步内卡片渲染序 */
  textBeforeTools?: boolean;
  /** 思考相位时长（毫秒；落盘透传）：历史回放恢复「已思考 · XmYs」耗时 */
  reasoningMs?: number;
  /** 本步 API 流时间（毫秒；dispatch 计时）+ 步用量——链头速率（输出口径）
   * 数据源：completion/elapsedMs 成对消费 */
  elapsedMs?: number;
  usage?: { prompt: number; completion: number; total?: number };
  toolCalls?: Array<{
    id: string;
    name: string;
    /** 参数原始 JSON 字符串 */
    arguments: string;
    /** 工具体返回的 ToolResult（对象原样） */
    result: unknown;
    /** run_code 子调用标记（session subcalls 投影注入的条目——平铺卡片缩进样式） */
    subcall?: boolean;
  }>;
}

/** pair 历史消息（宽松形态，按 role 渲染；feed.pairMessageToChatMessage 消费） */
interface PairHistoryMessage {
  role: string;
  content: string | null;
  agent_id?: string;
  message_id?: string;
  timestamp?: string;
  label?: string;
  reasoning_content?: string;
}

/**
 * SessionRecord[] → src 历史消息行（pair 视角 + WS history.response 共用）。
 * 【M21/D13 中性格式】role:'agent' 行 = 一切真实发言，归属 agent_id（取代
 * name）；'error' 行 = run 错误收束（错误分隔符）。旧 baked 行（user/
 * assistant + name）兼容读取，产出同构输出。带 steps 的回复行（M18 #6）→
 * 按步重建：每步一个 assistant 气泡（含 thinking/toolCalls）+ 每个工具调用
 * 一个 tool 气泡（与直播/resume 快照同构——工具卡片刷新后不丢）；event 行
 * （P3：timer/机制触发）→ role:'event' 事件分隔符。
 * 【步级时序（2026-09-02 顺序反馈）】收束行把整轮 run 折叠为单行——run
 * 中途的插行（send_agent 投递、机制通知）在磁盘上按事件序与部分行交错，
 * 若整块展开会全部排到插行之后（渲染序 ≠ 落盘序）。steps[].ts 在场时每步
 * 以自身时刻展开，末尾对全列表做**稳定**时间排序：插行回到真实位置；无
 * 步级 ts 的旧行整块按行时刻排序（行为与此前一致）。
 */
export function toHistoryMessages(records: PSessionRecord[], conversationId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of records) {
    if (r.role === 'user') {
      out.push({ role: 'agent', content: r.content, agent_id: r.agent_id ?? r.name ?? 'user', message_id: r.message_id, timestamp: r.timestamp, ...(r.attachments?.length ? { attachments: r.attachments } : {}) });
      continue;
    }
    if (r.role === 'agent' || r.role === 'assistant') {
      const agentId = r.agent_id ?? r.name ?? conversationId;
      if (r.steps && r.steps.length > 0) {
        // reasoning 单份存储（2026-09-20 终版）读侧：正源 = steps[].reasoning
        // 直读；存量行级 reasoning_content（迁移前旧数据）挂首步保底
        // 行 id 基（2026-12 反馈 #3 后续）：步行（journal 活投影）message_id
        // 恒空——多行 steps 展开若都用 message_id-s{i} 会合成相同的 "-s0"，
        // mergeHistoryPage 按 persistedMsgId 去重把第二条起全部吞掉（运行中
        // 刷新「回放只到 journal-inject，后续 step 丢失」根因）。run 键在场
        // 即参与合成（行内 i 已保证步间唯一，run 键保证跨行唯一）；无 run
        // 的定稿行保持旧形（message_id 非空恒唯一）。
        // 行 id 基（2026-12 分支锚点修复）：步行 message_id = **收束行真实
        // message_id**（同 run 步行同锚）——服务端按 message_id 定位的操作
        //（singles/fork、session/truncate）才能命中；此前合成的 `<base>-s{i}`
        // 在后端不存在，分支/截断锚点失效。渲染 key 去重改用下行合成 sid。
        const ridBase = r.message_id;
        const legacyRc = r.reasoning_content || '';
        for (let i = 0; i < r.steps.length; i++) {
          const s = r.steps[i];
          const stepThinking = s.reasoning || (i === 0 ? legacyRc : '');
          const stepTs = typeof s.ts === 'number' ? new Date(s.ts).toISOString() : r.timestamp;
          // 幻影调用（id/name 双空的聚合残片——provider 空冲洗片曾产生）不
          // 展开：否则历史多一张无名工具卡（result null 永久转圈）
          // 键名用 src 持久化约定 tool_calls（historyMsgToChatMessage 消费下划线形）
          const toolCalls = (s.toolCalls ?? []).filter((tc) => tc.id || tc.name).map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: parseToolArgs(tc.arguments),
            result: tc.result ?? '',
            label: tc.name,
            ...(tc.subcall === true ? { subcall: true } : {}),
          }));
          out.push({
            role: 'agent',
            content: s.content || '',
            thinking: stepThinking || undefined,
            reasoning_content: stepThinking || undefined,
            // 步身份键透传（身份贯通）：直播 delta 帧 meta.stepId 与此同值——
            // 历史合并按键配对（mergeHistory 键控快路径）
            ...(typeof s.stepId === 'string' && s.stepId ? { stepId: s.stepId } : {}),
            // 思考耗时（与直播 closeThinking 同款构造）：<1s 不写（秒级以下
            // 不显示是既有产品约定）——组件回落「已思考」
            ...(s.reasoningMs !== undefined && s.reasoningMs >= 1000
              ? { label: `已思考 · ${fmtElapsed(s.reasoningMs / 1000)}` }
              : {}),
            ...(s.textBeforeTools !== undefined ? { textBeforeTools: s.textBeforeTools } : {}),
            // 步级 API 计时/token（直播/历史同源；成对在场才参与链头速率）
            ...(s.elapsedMs !== undefined && s.usage?.completion !== undefined
              ? { apiMs: s.elapsedMs, apiCompletion: s.usage.completion }
              : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            agent_id: agentId,
            name: r.name,
            // 真实收束行 id（服务端锚点）+ 合成 sid（渲染 key 去重——
            // mergeHistoryPage 仍按 persistedMsgId 去重，同锚步行第二条起
            // 靠本字段保 Vue key 唯一）
            message_id: r.message_id,
            ...(r.message_id ? { sid: `${ridBase}-s${i}` } : {}),
            timestamp: stepTs,
          });
          for (const tc of (s.toolCalls ?? []).filter((tc) => tc.id || tc.name)) {
            out.push({
              role: 'tool',
              content: tc.result ?? '',
              agent_id: agentId,
              name: tc.name,
              toolName: tc.name,
              tool_call_id: tc.id,
              label: tc.name,
              // run_code 子调用（session subcalls 投影）：平铺卡片带缩进标记；
              // 参数透传（工具卡按参数渲染专用视图——edit diff / write 预览）
              ...(tc.subcall === true ? { subcall: true, arguments: parseToolArgs(tc.arguments) } : {}),
              message_id: tc.id || `${r.message_id}-s${i}-t`,
              timestamp: stepTs,
            });
          }
        }
        continue;
      }
      out.push({
        role: 'agent',
        content: r.content,
        agent_id: agentId,
        name: r.name,
        message_id: r.message_id,
        timestamp: r.timestamp,
        // reasoning 单份存储读侧投影：行级缺场（新数据）从 steps[].reasoning
        // 拼整轮（replayTrajectory 关闭用户的折叠栏）；存量行级原样透传
        ...(r.reasoning_content !== undefined
          ? { reasoning_content: r.reasoning_content }
          : r.steps?.some((s) => s.reasoning)
            ? { reasoning_content: (r.steps ?? []).map((s) => s.reasoning ?? '').filter((x) => x.trim()).join('\n\n') }
            : {}),
        // 附件引用透传（多模态一期：中性 role:'agent' 行的入站消息也可能带图）
        ...(r.attachments?.length ? { attachments: r.attachments } : {}),
      });
      continue;
    }
    if (r.role === 'error' || (r.role === 'context' && r.source === 'error')) {
      // run 错误收束（D12/F7；词汇 v2：context+source:error 同形态）：错误分隔符
      out.push({ role: 'error', content: r.content, agent_id: 'system', message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    if (r.role === 'tool') {
      out.push({ role: 'tool', content: r.content, agent_id: r.agent_id ?? r.name ?? conversationId, name: r.name, tool_call_id: r.message_id, message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    // 词汇 v2：context 行（source:event 机制行 / source:skill 技能注入）与
    // 存量 event 行同渲染位（分隔符；label 条组件二期）——正文在场可查，
    // UI 不因新词汇断渲染
    out.push({ role: 'event', content: r.label ?? r.content, agent_id: r.agent_id ?? r.name ?? 'system', message_id: r.message_id, timestamp: r.timestamp, ...(r.source !== undefined ? { source: { summary: r.label ?? '', legacyRole: undefined, ...(typeof r.source === 'string' ? { kind: r.source } : {}) } as never } : {}) });
  }
  // 稳定时间排序（步级 ts 展开后恢复与落盘事件序一致的渲染序；等时刻/
  // 不可解析时刻保持输入序——旧行为兼容）
  return out
    .map((m, i) => ({ m, i, t: Date.parse(String(m.timestamp ?? '')) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => e.m);
}

/** 工具参数 JSON 字符串 → 对象（失败降级原串——卡片少显示参数不崩）。
 *  导出供群历史展开（expandGroupRecord）同款复用——唯一解析点，防两处漂移 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> | string {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

/** Agent 会话对（pair）只读历史（矩阵格子点击视角；conversationId = 对桶键
 *  pairKey(a,b)——M19 与后端寻址同词表）。rpc 契约面必传（webui 包装
 *  传 wireRpc / feed-core 闭传注入面） */
export async function fetchPairHistory(from: string, to: string, limit: number, offset: number, rpc: Rpc): Promise<{ messages: PairHistoryMessage[] }> {
  void from; // from 仅参与对键（与 to 合成）；保留签名兼容
  const conversationId = [from, to].sort().join('~');
  const r = await rpc.call<{ records?: PSessionRecord[] }>('session/history', {
    conversationId,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  return { messages: toHistoryMessages(r.records ?? [], conversationId) as unknown as PairHistoryMessage[] };
}

// ---- 群历史（本体投影展开） ----

/** 群历史行（feed.groupMessageToChatMessage 的宽松输入形状） */
interface GroupHistoryMessage {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  toolName?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
  attachments?: PMediaAttachment[];
}

/** group/history RPC 行（D11：本体投影——成员回复行带 steps[]/reasoning） */
interface PGroupRecord {
  id?: string;
  from?: string;
  content?: string;
  at?: number;
  reasoning?: string;
  attachments?: PMediaAttachment[];
  steps?: Array<{
    content?: string;
    reasoning?: string;
    /** 步内相位序（落盘透传）：true = 本步正文先于工具调用——步内卡片渲染序 */
    textBeforeTools?: boolean;
    /** 思考相位时长（毫秒；落盘透传）：历史回放恢复「已思考 · XmYs」耗时 */
    reasoningMs?: number;
    /** 本步 API 流时间（毫秒；dispatch 计时）+ 步用量——链头速率数据源 */
    elapsedMs?: number;
    usage?: { prompt: number; completion: number; total?: number };
    toolCalls?: Array<{ id: string; name: string; arguments: string; result?: unknown }>;
  }>;
}

/**
 * 本体行 → feed 消息（D11：steps 按步展开——与 toHistoryMessages 的
 * 1v1 展开同构：每步 agent 气泡[tool_calls/thinking] + 配对 tool 气泡；
 * 用户发言直通）。群成员工具卡片/思维链刷新后不丢。
 */
function expandGroupRecord(m: PGroupRecord): GroupHistoryMessage[] {
  const base = {
    agent_id: m.from ?? '',
    name: m.from,
    timestamp: new Date(m.at ?? Date.now()).toISOString(),
  };
  if (!m.steps || m.steps.length === 0) {
    return [
      {
        role: 'agent',
        content: m.content ?? '',
        ...base,
        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      },
    ];
  }
  const out: GroupHistoryMessage[] = [];
  for (const s of m.steps) {
    // 幻影调用（id/name 双空的聚合残片）不展开——同 toHistoryMessages
    const calls = (s.toolCalls ?? []).filter((tc) => tc.id || tc.name);
    const toolCalls = calls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: parseToolArgs(tc.arguments),
      result: tc.result ?? '',
      label: tc.name,
    }));
    out.push({
      role: 'agent',
      content: s.content || '',
      ...(s.reasoning ? { reasoning_content: s.reasoning } : {}),
      // 思考耗时（与 1v1 展开同款构造；<1s 不写）
      ...(s.reasoningMs !== undefined && s.reasoningMs >= 1000
        ? { label: `已思考 · ${fmtElapsed(s.reasoningMs / 1000)}` }
        : {}),
      ...(s.textBeforeTools !== undefined ? { textBeforeTools: s.textBeforeTools } : {}),
      ...(s.elapsedMs !== undefined && s.usage?.completion !== undefined
        ? { apiMs: s.elapsedMs, apiCompletion: s.usage.completion }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...base,
    });
    for (const tc of calls) {
      out.push({
        role: 'tool',
        content: JSON.stringify(tc.result ?? ''),
        tool_call_id: tc.id,
        label: tc.name,
        ...base,
        name: tc.name, // 工具名（覆盖基座的说话人标注——tool 气泡归工具）
        toolName: tc.name, // 与 1v1 展开（toHistoryMessages）同款词汇
      });
    }
  }
  return out;
}

/** 群组历史（分页：最新 limit 条 + offset 上翻更早；首屏满页 50 = hasMore）。
 *  rpc 契约面必传（webui 包装传 wireRpc / feed-core 闭传注入面） */
export async function fetchGroupHistory(
  groupId: string,
  offset: number,
  limit: number,
  rpc: Rpc,
): Promise<{ messages: GroupHistoryMessage[] }> {
  const r = await rpc.call<{ messages?: PGroupRecord[] }>('group/history', {
    groupId,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  return { messages: (r.messages ?? []).flatMap(expandGroupRecord) };
}
