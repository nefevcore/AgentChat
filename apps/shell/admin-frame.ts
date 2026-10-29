// ============================================================
// admin-frame.ts —— 壳内管理面控制帧（cr-569）
//
// 背景：goal / todo / 工具目录 / 队列这类**会话桶状态与壳内服务**住壳进程
//（R0a 判据 1：只有壳内 agent-loop 与行服务才知道它们的真实态），宿主 RPC
// 面只能经控制帧往返。帧形 = { ctrl: 'admin', op, agentId, ... }——
// 与 cr-552 的 preview 帧同一通道（stdin 行协议 → control() → ctrl.done）。
//
// 桶键语义与主线一致：conversationId ?? agentId（目标/清单随会话桶走）。
// ============================================================
import type { Context } from '@agentchat/cordis';

/** admin 帧的 op 词表（宿主 RPC 面的壳内半边） */
export type AdminOp =
  | 'goal-get' | 'goal-update' | 'goal-delete' | 'todo-get'
  | 'interaction-reply' | 'interaction-list' | 'jobs-list' | 'jobs-kill' | 'session-archive' | 'subagents-stop' | 'subagents-list'
  | 'run-state' | 'queue-list' | 'queue-remove' | 'queue-steer'
  | 'tool-defs' | 'tools-catalog';

export interface AdminFrame {
  ctrl: 'admin';
  op: AdminOp;
  agentId: string;
  conversationId?: string;
  /** goal-update 的补丁（字段语义与主线同：undefined = 不动） */
  patch?: Record<string, unknown>;
  /** interaction-reply 的目标 + 答案 */
  id?: string;
  answer?: unknown;
  /** interaction-list 的过滤（主线 DurableInteractionFilter 子集——state/key/owner） */
  filter?: { state?: 'pending' | 'answered' | 'closed'; key?: string; owner?: string };
}

/** 桶键（会话级优先——与主线 goal/todo 服务同口径） */
function bucketKeyOf(frame: AdminFrame): string {
  return frame.conversationId ?? frame.agentId;
}

function requireService<T>(ctx: Context, key: string, label: string): T {
  const service = ctx.get(key, false) as T | undefined;
  if (service === undefined) throw new Error(label + ' 服务缺席——行集不含该行');
  return service;
}

/** 帧执行（纯路由——域规则全在 owning 服务；异常经 ctrl.error 回执） */
export function handleAdminFrame(ctx: Context, frame: AdminFrame): unknown {
  const key = bucketKeyOf(frame);
  if (frame.op === 'goal-get') {
    const goals = requireService<{ snapshot(agentId: string, key: string): unknown }>(ctx, 'goals', 'goals');
    return { goal: goals.snapshot(frame.agentId, key) };
  }
  if (frame.op === 'goal-update') {
    const goals = requireService<{ update(agentId: string, key: string, patch: Record<string, unknown>): unknown }>(ctx, 'goals', 'goals');
    const raw = frame.patch ?? {};
    const patch = {
      ...(typeof raw.objective === 'string' ? { objective: raw.objective } : {}),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
      ...(typeof raw.status === 'string' && raw.status !== '' ? { status: raw.status } : {}),
      ...(typeof raw.blocked_reason === 'string' && raw.blocked_reason !== '' ? { blockedReason: raw.blocked_reason } : {}),
      ...(typeof raw.max_rounds === 'number' && Number.isFinite(raw.max_rounds) ? { maxRounds: raw.max_rounds } : {}),
    };
    return { goal: goals.update(frame.agentId, key, patch) };
  }
  if (frame.op === 'goal-delete') {
    const goals = requireService<{ remove(agentId: string, key: string): unknown }>(ctx, 'goals', 'goals');
    return { goal: goals.remove(frame.agentId, key), deleted: true };
  }
  if (frame.op === 'interaction-reply') {
    const durable = requireService<{ reply(id: string, answer: unknown): unknown }>(ctx, 'durableInteraction', 'durableInteraction');
    if (frame.id === undefined || frame.id === '') throw new Error('admin 帧缺 id（interaction-reply）');
    return durable.reply(frame.id, frame.answer ?? null);
  }
  if (frame.op === 'interaction-list') {
    const durable = requireService<{ list(filter?: { state?: 'pending' | 'answered' | 'closed'; key?: string; owner?: string }): unknown[] }>(ctx, 'durableInteraction', 'durableInteraction');
    return { interactions: durable.list(frame.filter) };
  }
  if (frame.op === 'jobs-list') {
    const jobs = requireService<{ list(ownerAgentId?: string): unknown[] }>(ctx, 'jobs', 'jobs');
    return { jobs: jobs.list() };
  }
  if (frame.op === 'jobs-kill') {
    const jobs = requireService<{ kill(id: string, ownerAgentId?: string, reason?: string): unknown }>(ctx, 'jobs', 'jobs');
    if (frame.id === undefined || frame.id === '') throw new Error('admin 帧缺 id（jobs-kill）');
    return jobs.kill(frame.id);
  }
  if (frame.op === 'subagents-stop') {
    const subs = requireService<{ stopOp(childId: string): Promise<{ stopped: boolean }> }>(ctx, 'subagents', 'subagents');
    if (frame.id === undefined || frame.id === '') throw new Error('admin 帧缺 id（subagents-stop）');
    return subs.stopOp(frame.id);
  }
  if (frame.op === 'subagents-list') {
    // 在场清单（含 busy/exited 进程内态——cr-725：宿主 subagents/list 盘读面
    // 叠加活态的来源；纯路由同上，域规则在 ShellSubagentService.listOp）
    const subs = requireService<{ listOp(): unknown[] }>(ctx, 'subagents', 'subagents');
    return { agents: subs.listOp() };
  }
  if (frame.op === 'session-archive') {
    const archive = requireService<{ requestArchive(uuid: string): Promise<void> }>(ctx, 'archive', 'archive');
    if (frame.conversationId === undefined || frame.conversationId === '') throw new Error('admin 帧缺 conversationId（session-archive）');
    return archive.requestArchive(frame.conversationId).then(() => ({ triggered: true, conversationId: frame.conversationId }));
  }
  if (frame.op === 'tool-defs') {
    // 生效工具集（agents/tool-defs 估算面——Token 仪表固定开销，cr-582）
    const conversation = requireService<{ toolDefs(conversationId?: string): unknown }>(ctx, 'conversation', 'conversation');
    return conversation.toolDefs(frame.conversationId);
  }
  if (frame.op === 'tools-catalog') {
    // 全量工具目录（tools/list 的壳内半边——注册面 + owner 分组锚点，cr-582）
    const conversation = requireService<{ toolsCatalog(): unknown[] }>(ctx, 'conversation', 'conversation');
    return { tools: conversation.toolsCatalog() };
  }
  if (frame.op === 'run-state') {
    // 串行化门快照（宿主 runs/snapshot 活跃集——只读，不拉起 run）
    const conversation = requireService<{ runState(): unknown }>(ctx, 'conversation', 'conversation');
    return conversation.runState();
  }
  if (frame.op === 'queue-list' || frame.op === 'queue-remove' || frame.op === 'queue-steer') {
    // next-turn 排队面（排队 UI 数据面——读写都在壳内 ConversationMachine）
    const conversation = requireService<{
      queue(conversationId?: string): unknown[];
      removeQueued(id: string): boolean;
      steerQueued(id: string): Promise<'steered' | 'requeued' | 'not-found'>;
    }>(ctx, 'conversation', 'conversation');
    if (frame.op === 'queue-list') return { items: conversation.queue(frame.conversationId) };
    if (frame.id === undefined || frame.id === '') throw new Error('admin 帧缺 id（' + frame.op + '）');
    if (frame.op === 'queue-remove') return { removed: conversation.removeQueued(frame.id) };
    return conversation.steerQueued(frame.id).then((outcome) => ({ outcome }));
  }
  const todos = requireService<{ list(agentId: string, key: string): unknown[] }>(ctx, 'todos', 'todos');
  return { todos: todos.list(frame.agentId, key) };
}
