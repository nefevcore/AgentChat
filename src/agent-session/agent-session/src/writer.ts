// ============================================================
// @agentchat/agent-session/src/writer.ts —— step 级增量会话写入
//
// 把 runEnd 一次性全量写盘升级为增量 checkpoint：
//   · toolExecutionStart：先持久化 assistant(tool_calls) 再执行工具
//   · stepEnd：持久化本步新增 assistant/tool 消息
//   · runEnd：持久化剩余 delta + 最终 flush
//
// 写入队列按 dialogId 串行；flush 为 quiescence barrier。
// 失败时保留 pending 批次并抛出，调用方（tool checkpoint）fail-closed。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CurrentContext,
  RunResult,
  StepOutcome,
  ToolExecutionStartContext,
  ToolExecutionStartHook,
  StepEndHook,
  RunEndHook,
} from '@agentchat/agent-loop';
import type { AgentMessage } from '@agentchat/types';
import { META_ARCHIVE_REVIEW, groupHistoryFile, groupIdOfDialog, sessionFileOf } from '@agentchat/tools';
import { isGroupDialog } from '@agentchat/contracts';
import { createLogger } from '@agentchat/util';
import { toPersisted } from './session';

const log = createLogger('[agent-session:writer]');

/** 每次 flush 后 fsync（与旧 saveSession 的 appendFileSync 对齐；checkpoint 语义要求 true） */
const FSYNC = true;

interface LogQueue {
  file: string;
  pending: string[];
  active?: Promise<void>;
  barrier?: Promise<void>;
  /** 已入队过的消息对象引用（本文件）。会话日志 append-only：同一对象只应落盘一次；
   *  重复投递派生的第二个 run 换数组引用重新 slice(0) 入队时，在此拦截。 */
  seen: WeakSet<object>;
}

export class SessionLogWriter {
  /** file 路径 → 写队列（路径变化（测试切工作区）时旧队列自然隔离） */
  private queues = new Map<string, LogQueue>();
  /** dialogId → 当前目标 file（flush 定位用） */
  private dialogFiles = new Map<string, string>();

  /** 入队持久化行（不写盘，等待 flush / 后续批量）。
   *  引用级幂等：同一消息对象对同一文件只入队一次（跨数组/跨 run 防重复落盘）。 */
  enqueue(dialogId: string, selfId: string, messages: AgentMessage[]): void {
    if (messages.length === 0) return;
    const file = this.fileOf(dialogId, selfId);
    this.dialogFiles.set(dialogId, file);
    const queue = this.queueOf(file);
    for (const message of messages) {
      if (queue.seen.has(message)) continue;
      queue.seen.add(message);
      queue.pending.push(JSON.stringify(toPersisted(message, selfId)));
    }
  }

  /** 排空 dialogId 当前目标文件的所有 pending 与 active 写，直到 quiescence */
  async flush(dialogId: string): Promise<void> {
    const file = this.dialogFiles.get(dialogId);
    if (!file) return;
    const queue = this.queues.get(file);
    if (!queue) return;
    if (queue.barrier) return queue.barrier;
    const barrier = this.drain(queue).finally(() => {
      if (this.queues.get(file) === queue) queue.barrier = undefined;
    });
    queue.barrier = barrier;
    return barrier;
  }

  /** 进程退出/测试用：排空全部会话队列 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => this.drain(queue)));
  }

  dispose(): void {
    this.queues.clear();
    this.dialogFiles.clear();
  }

  private fileOf(dialogId: string, selfId: string): string {
    return isGroupDialog(dialogId)
      ? groupHistoryFile(groupIdOfDialog(dialogId), selfId)
      : sessionFileOf(dialogId);
  }

  private queueOf(file: string): LogQueue {
    let queue = this.queues.get(file);
    if (!queue) {
      queue = { file, pending: [], seen: new WeakSet() };
      this.queues.set(file, queue);
    }
    return queue;
  }

  private async drain(queue: LogQueue): Promise<void> {
    await Promise.allSettled(queue.active ? [queue.active] : []);
    while (queue.pending.length > 0) {
      const batch = queue.pending.splice(0);
      const active = this.write(queue.file, batch);
      queue.active = active;
      try {
        await active;
      } catch (err) {
        // 失败批次放回队首，保持顺序；barrier 调用方得到失败并决定 fail-closed
        queue.pending = [...batch, ...queue.pending];
        throw err;
      } finally {
        queue.active = undefined;
      }
    }
  }

  /** 一次 append + fsync；单写者假设（AgentChat 当前进程形态） */
  private async write(file: string, lines: string[]): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, lines.join('\n') + '\n', null, 'utf-8');
      if (FSYNC) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

// ============================================================
// 每 run 写入状态（loopMessages 数组引用是 run 内稳定键）
// ============================================================

interface RunWriteState {
  writer: SessionLogWriter;
  dialogId: string;
  selfId: string;
  /** 已持久化到的 loopMessages 下标 */
  persisted: number;
  /** 归档整理 run 不落盘 */
  skip: boolean;
  /** 同一 messages 数组的持久化互斥锁：并发 toolExecutionStart 钩子共享同一数组，
   *  若不串行会各自 slice(0) 重复入队同一 delta，导致 messages.jsonl 出现重复消息。
   *  （第二层防御：enqueue 的 WeakSet 引用守卫兜底跨数组/跨 run 的重复对象。） */
  persistLock?: Promise<void>;
}

const runStates = new WeakMap<AgentMessage[], RunWriteState>();

function stateFor(
  writer: SessionLogWriter,
  messages: AgentMessage[],
  ctx: CurrentContext,
  fallbackSelfId: string,
): RunWriteState {
  let state = runStates.get(messages);
  if (!state) {
    state = {
      writer,
      dialogId: ctx.dialogId ?? '',
      selfId: ctx.agentId ?? fallbackSelfId,
      persisted: 0,
      skip: ctx.meta?.[META_ARCHIVE_REVIEW] === true,
    };
    runStates.set(messages, state);
  }
  return state;
}

async function persistDelta(state: RunWriteState, messages: AgentMessage[]): Promise<void> {
  if (state.skip || !state.dialogId) return;

  // 串行化同一 loopMessages 的持久化：多个 toolExecutionStart 钩子并行触发时，
  // 都看到 persisted=0 会重复入队同一 delta。先等前一个持久化完成，再重新计算 delta。
  const prev = state.persistLock ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.persistLock = gate;
  try {
    await prev;
    const delta = messages.slice(state.persisted);
    if (delta.length === 0) return;
    state.writer.enqueue(state.dialogId, state.selfId, delta);
    await state.writer.flush(state.dialogId);
    state.persisted = messages.length;
  } finally {
    release();
    if (state.persistLock === gate) state.persistLock = undefined;
  }
}

// ============================================================
// 钩子工厂（经 HooksService automatic 条目注入每个 run）
// ============================================================

let sharedWriter: SessionLogWriter | undefined;

/** 进程级共享 writer（多个钩子工厂共享同一队列） */
export function getSessionLogWriter(): SessionLogWriter {
  sharedWriter ??= new SessionLogWriter();
  return sharedWriter;
}

export function makeToolPersistHook(config: { agent_id: string }): ToolExecutionStartHook {
  return async (_toolName, _args, execution: ToolExecutionStartContext) => {
    const ctx = execution.context;
    const state = stateFor(getSessionLogWriter(), execution.messages, ctx, config.agent_id);
    try {
      await persistDelta(state, execution.messages);
      return { allow: true };
    } catch (err: any) {
      log.error(`工具执行前持久化 checkpoint 失败（fail-closed）: ${err?.message ?? String(err)}`);
      return { allow: false, reason: `会话持久化 checkpoint 失败，已阻止工具执行：${err?.message ?? String(err)}` };
    }
  };
}

export function makeStepPersistHook(config: { agent_id: string }): StepEndHook {
  return async (ctx, _outcome: StepOutcome, loopMessages: AgentMessage[]) => {
    const state = stateFor(getSessionLogWriter(), loopMessages, ctx, config.agent_id);
    try {
      await persistDelta(state, loopMessages);
    } catch (err: any) {
      log.error(`stepEnd 持久化失败（本步消息可能延迟到后续 checkpoint）: ${err?.message ?? String(err)}`);
    }
  };
}

export function makeSaveSessionHook(config: { agent_id: string }): RunEndHook {
  return async (ctx, result: RunResult) => {
    const state = stateFor(getSessionLogWriter(), result.messages, ctx, config.agent_id);
    try {
      await persistDelta(state, result.messages);
      if (state.dialogId) await state.writer.flush(state.dialogId);
    } catch (err: any) {
      log.error(`runEnd 持久化失败（${state.dialogId}）: ${err?.message ?? String(err)}`);
    }
  };
}
