// ============================================================
// interaction-recovery.ts —— ask_questions 崩溃恢复调和
//
// 依赖 step 级增量持久化：崩溃后 messages.jsonl 可能含有
// assistant(tool_calls) 而缺少对应 tool 结果。本模块扫描历史，
// 与 durable-interaction 记录（correlationId = tool_call_id）对账：
//   · answered 完整 → 合成 tool 结果，恢复可续跑
//   · 存在 pending → 不合成（由上层 park：不启动新 run，等回答）
//   · 非 ask_questions 的悬空调用 → 合成 unknown outcome 平衡转录
// ============================================================

import type { LLMRequestMessage, AgentMessage } from '@agentchat/types';
import type {
  DurableInteraction,
  DurableInteractionFilter,
} from '@agentchat/durable-interaction';

/** 恢复函数的最小依赖面（DurableInteractionService 结构满足） */
export interface InteractionRecoveryStore {
  list(filter?: DurableInteractionFilter): DurableInteraction[];
}

/** 悬空工具调用（assistant 已落盘、tool 结果缺失） */
interface DanglingCall {
  id: string;
  name: string;
}

/** 从 ToolCall | PersistedToolCall 联合中归一化 {id,name} */
function callsOf(message: AgentMessage): DanglingCall[] {
  return (message.tool_calls ?? [])
    .map((tc: any): DanglingCall => ({
      id: typeof tc.id === 'string' ? tc.id : '',
      name: typeof tc.name === 'string' ? tc.name : (typeof tc.function?.name === 'string' ? tc.function.name : ''),
    }))
    .filter((call) => call.id.length > 0);
}

/** 已有的 tool 结果 call id 集合 */
function existingToolResults(messages: readonly LLMRequestMessage[], afterIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'tool' && message.role !== 'error') continue;
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      ids.add(message.tool_call_id);
    }
  }
  return ids;
}

function answerText(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  try {
    return JSON.stringify(answer);
  } catch {
    return String(answer);
  }
}

function questionText(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const question = (payload as Record<string, unknown>).question;
    if (typeof question === 'string') return question;
  }
  return '';
}

/**
 * 扫描并修复一条历史转录。返回新数组（不修改调用方引用）。
 * 只在所有 ask_questions 相关记录 answered 时才合成；存在 pending 时
 * 保持该 assistant 块悬空（由上层 park 逻辑阻止 run 启动）。
 */
export function recoverInteractionHistory(
  store: InteractionRecoveryStore,
  history: readonly LLMRequestMessage[],
): LLMRequestMessage[] {
  const recovered: LLMRequestMessage[] = [];

  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    recovered.push(message);
    // loadHistory 返回的内存格式中持久化 assistant 发言为 role='agent'；两种都接受
    if ((message.role !== 'assistant' && message.role !== 'agent') || !message.tool_calls?.length) continue;

    const calls = callsOf(message);
    const existing = existingToolResults(history, i);
    const dangling = calls.filter((call) => !existing.has(call.id));
    if (dangling.length === 0) continue;

    // 该 assistant 块的 ask_questions 相关持久记录
    const askCalls = dangling.filter((call) => call.name === 'ask_questions');
    let blocked = false;
    const answerByCall = new Map<string, string[]>();
    const questionByCall = new Map<string, string[]>();

    for (const call of askCalls) {
      const records = store.list({ correlationId: call.id, kind: 'ask_questions' });
      const pending = records.filter((record) => record.state === 'pending');
      const answered = records.filter((record) => record.state === 'answered');
      if (pending.length > 0) {
        // 还有未回答的问题：不合成本块任何结果，保持挂起
        blocked = true;
        break;
      }
      if (answered.length > 0) {
        answerByCall.set(call.id, answered.map((record) => answerText(record.answer)));
        questionByCall.set(call.id, answered.map((record) => questionText(record.payload)));
      }
    }

    if (blocked) continue;

    // 有答案的 ask_questions 合成原工具返回；其余悬空调用合成 unknown outcome
    const synthesized: AgentMessage[] = [];
    for (const call of dangling) {
      if (call.name === 'ask_questions' && answerByCall.has(call.id)) {
        synthesized.push({
          role: 'tool',
          name: 'ask_questions',
          tool_call_id: call.id,
          content: JSON.stringify({
            status: 'ok',
            data: {
              answers: answerByCall.get(call.id),
              questions: questionByCall.get(call.id),
            },
          }),
          timestamp: new Date().toISOString(),
        });
      } else {
        synthesized.push({
          role: 'tool',
          name: call.name || 'unknown',
          tool_call_id: call.id,
          content: JSON.stringify({
            status: 'error',
            data: { message: `工具结果在崩溃恢复中丢失（unknown outcome），请核对状态后决定是否重试。` },
          }),
          timestamp: new Date().toISOString(),
        });
      }
    }
    recovered.push(...synthesized);
  }

  return recovered;
}

/** 是否有任一 ask_questions 调用仍 pending（供 park 判断） */
export function hasPendingInteractionFor(
  store: InteractionRecoveryStore,
  history: readonly LLMRequestMessage[],
  filter?: DurableInteractionFilter,
): boolean {
  for (const message of history) {
    if ((message.role !== 'assistant' && message.role !== 'agent') || !message.tool_calls?.length) continue;
    for (const call of callsOf(message)) {
      if (call.name !== 'ask_questions') continue;
      if (store.list({ ...filter, correlationId: call.id, kind: 'ask_questions' }).some(r => r.state === 'pending')) {
        return true;
      }
    }
  }
  return false;
}
