// ============================================================
// api/runs.ts —— 运行跟踪 Port B（阶段二第五梯）
//
// runs/snapshot·interrupt + session/history（pair 视角）直连。
// RunsSnapshot 合成（src 矩阵契约：members/pairs/groups/running/
// convKey ~ 分隔格式）与 convKey→conversationId 换算是本模块视图
// 代码；热力时间窗（h1/dN）preview 无面对全零（显式降级，README 记录）。
// ============================================================

import { wireRpc } from './wire.ts';
import type { PAgentConfig } from './roster.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ---- src 视图契约（M27 S3：owning package = ac-client-ui-runview/client——
// 契约随行走；本模块 re-export 维持既有消费面 import 路径不变） ----
export type {
  RunsMember, WindowCounts, RunsPairSession, RunsGroupSession,
  RunsSingleSession, RunsRunningEntry, RunsGroupArchive, RunsSnapshot,
} from 'ac-client-ui-runview/client';
import { toRunsSnapshot } from 'ac-client-ui-runview/client';
import type { PRunsSnapshot, RosterAgentView, RunsSnapshot } from 'ac-client-ui-runview/client';
export type { PRunsSnapshot, RosterAgentView } from 'ac-client-ui-runview/client';
export { toRunsSnapshot } from 'ac-client-ui-runview/client';

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

// ---- preview 形状（历史回放族；矩阵族已随 ac-client-ui-runview/client 走） ----

/** 多模态附件引用（与后端 LlmAttachment 同形：image/video/file） */
export interface PMediaAttachment {
  kind: 'image' | 'video' | 'file';
  ref: string;
  mime?: string;
  filename?: string;
  detail?: string;
}

interface PSessionRecord {
  role: string;
  content: string;
  message_id: string;
  timestamp: string;
  /** 说话人端点（中性格式归属标记，M21/D13——一切真实发言 role:'agent' 必有） */
  agent_id?: string;
  /** 旧 baked 格式说话人标注（兼容读取） */
  name?: string;
  /** 事件来源标注（role:'event' 行；P3） */
  source?: string;
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
  /** 步完成时刻（epoch ms；落盘步级时序锚——收束行展开时恢复中途插行的渲染序） */
  ts?: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** 参数原始 JSON 字符串 */
    arguments: string;
    /** 工具体返回的 ToolResult（对象原样） */
    result: unknown;
  }>;
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
        for (let i = 0; i < r.steps.length; i++) {
          const s = r.steps[i];
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
          }));
          out.push({
            role: 'agent',
            content: s.content || '',
            thinking: s.reasoning || undefined,
            reasoning_content: s.reasoning,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            agent_id: agentId,
            name: r.name,
            message_id: `${r.message_id}-s${i}`,
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
        ...(r.reasoning_content !== undefined ? { reasoning_content: r.reasoning_content } : {}),
        // 附件引用透传（多模态一期：中性 role:'agent' 行的入站消息也可能带图）
        ...(r.attachments?.length ? { attachments: r.attachments } : {}),
      });
      continue;
    }
    if (r.role === 'error') {
      // run 错误收束（D12/F7）：错误分隔符（feed 渲染 system 级错误行）
      out.push({ role: 'error', content: r.content, agent_id: 'system', message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    if (r.role === 'tool') {
      out.push({ role: 'tool', content: r.content, agent_id: r.agent_id ?? r.name ?? conversationId, name: r.name, tool_call_id: r.message_id, message_id: r.message_id, timestamp: r.timestamp });
      continue;
    }
    out.push({ role: 'event', content: r.content, agent_id: r.agent_id ?? r.name ?? 'system', message_id: r.message_id, timestamp: r.timestamp });
  }
  // 稳定时间排序（步级 ts 展开后恢复与落盘事件序一致的渲染序；等时刻/
  // 不可解析时刻保持输入序——旧行为兼容）
  return out
    .map((m, i) => ({ m, i, t: Date.parse(String(m.timestamp ?? '')) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => e.m);
}

/** 工具参数 JSON 字符串 → 对象（失败降级原串——卡片少显示参数不崩）。
 *  导出供群历史展开（groups.ts）同款复用——唯一解析点，防两处漂移 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> | string {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

/** src convKey（chat~a~b / group~g~a / single~s）→ preview conversationId（M19：
 *  chat 对键双向保留——'chat~a~b' → 'a~b'，不再剥 user 特判） */
export function convKeyToId(convKey: string): string {
  if (convKey.startsWith('single~')) return convKey.slice('single~'.length);
  if (convKey.startsWith('group~')) return convKey.split('~')[1] ?? convKey;
  if (convKey.startsWith('chat~')) return convKey.slice('chat~'.length);
  return convKey;
}

// ---- API ----

/** 运行跟踪快照（3s 轮询；snapshot + agents/list 双 RPC 聚合） */
export async function fetchRuns(rpc: Rpc = wireRpc): Promise<RunsSnapshot> {
  const [snapshot, agentsR] = await Promise.all([
    rpc.call<PRunsSnapshot>('runs/snapshot'),
    rpc.call<{ agents?: PAgentConfig[] }>('agents/list'),
  ]);
  return toRunsSnapshot(snapshot ?? {}, agentsR.agents ?? []);
}

/** 中断指定会话键的运行中 run（软中断：run 走完 runEnd 落盘后退出） */
export async function interruptRun(convKey: string, rpc: Rpc = wireRpc): Promise<{ success: boolean; error?: string }> {
  const r = await rpc.call<{ aborted?: number }>('runs/interrupt', { conversationId: convKeyToId(convKey) });
  return { success: (r.aborted ?? 0) > 0 };
}

/** Agent 会话对（pair）只读历史（矩阵格子点击视角；conversationId = 对桶键
 *  pairKey(a,b)——M19 与后端寻址同词表） */
export async function fetchPairHistory(from: string, to: string, limit = 100, offset = 0, rpc: Rpc = wireRpc): Promise<{ messages: PairHistoryMessage[] }> {
  void from; // from 仅参与对键（与 to 合成）；保留签名兼容
  const conversationId = [from, to].sort().join('~');
  const r = await rpc.call<{ records?: PSessionRecord[] }>('session/history', {
    conversationId,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  return { messages: toHistoryMessages(r.records ?? [], conversationId) as unknown as PairHistoryMessage[] };
}