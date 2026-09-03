// ============================================================
// api/tasks.ts —— 任务追踪读面（goal / todo Port B）
//
// goal/get · todo/get RPC 直连（桶键 = conversationId：1v1 对键 /
// singles sid）。写路径归 Agent 工具（goal/todo）——本面只读；
// 变更随 tool/after-execute 帧触发上层刷新（composables/useTaskTracking）。
//
// 另含会话流卡片的数据归一化纯函数（normalizeTodoCard /
// normalizeGoalCard）：live 帧（stringifyToolResult = output 的
// JSON.stringify）与历史回放（JSON.stringify(ToolResult 全对象)）
// 两形统一，测试锁定。
// ============================================================

import { wireRpc } from './wire.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 目标记录（= ac-goal GoalRecord） */
export interface TaskGoal {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  note?: string;
  blockedReason?: string;
  /** 宿主自动暂停原因（轮次上限/异常收束；resume 即清除） */
  autoPausedReason?: string;
  /** 已完成 goal-round 数 */
  roundsDone?: number;
  /** 轮次预算上限 */
  maxRounds?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** 目标桶快照（= ac-goal GoalSnapshot） */
export interface TaskGoalSnapshot {
  current?: TaskGoal;
  history: TaskGoal[];
}

/** 待办条目（= ac-todo TodoItem） */
export interface TaskTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 读取某会话桶的当前目标（服务未装载 → null，dock 静默隐藏） */
export async function fetchGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc = wireRpc,
): Promise<TaskGoalSnapshot | null> {
  try {
    const r = await rpc.call<{ goal?: TaskGoalSnapshot }>('goal/get', { agentId, conversationId });
    return r.goal ?? { history: [] };
  } catch {
    return null; // 可选能力未装载 / 连接失败：不渲染，不报错
  }
}

/** 读取某会话桶的待办清单（服务未装载 → null，dock 静默隐藏） */
export async function fetchTodos(
  agentId: string,
  conversationId: string,
  rpc: Rpc = wireRpc,
): Promise<TaskTodo[] | null> {
  try {
    const r = await rpc.call<{ todos?: TaskTodo[] }>('todo/get', { agentId, conversationId });
    return Array.isArray(r.todos) ? r.todos : [];
  } catch {
    return null;
  }
}

// ============================================================
// 会话流卡片归一化（纯函数）：goal / todo 工具消息 → 卡片数据
// ============================================================

/** 工具消息内容两形归一：live = JSON.stringify(output)；历史 = JSON.stringify({ok,output}) */
function parseContent(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') {
    return content !== null && typeof content === 'object' ? (content as Record<string, unknown>) : null;
  }
  const trimmed = content.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const v = JSON.parse(trimmed);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed'];

/** 历史回放形信封解包：{ok, output} → output（live 形本就是裸 output，原样过） */
function unwrapToolResult(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  if (parsed === null) return null;
  if (typeof parsed.ok === 'boolean' && 'output' in parsed) {
    const inner = parsed.output;
    return inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : null;
  }
  return parsed;
}

function todoListOf(raw: unknown): TaskTodo[] | null {
  if (!Array.isArray(raw)) return null;
  const items: TaskTodo[] = [];
  for (const it of raw) {
    if (it === null || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!content) continue;
    const status = TODO_STATUSES.includes(String(o.status)) ? (o.status as TaskTodo['status']) : 'pending';
    items.push({ content, status });
  }
  return items;
}

export interface TodoCardData {
  todos: TaskTodo[];
  /** 结果已返回（false = 调用中，args 预览） */
  settled: boolean;
}

/**
 * todo 工具消息 → 卡片数据。优先序：output.todos（write/read 终值）→
 * args.todos（调用中预览）。空清单/不可解析 → null（卡片隐藏，不占位）。
 */
export function normalizeTodoCard(data: Record<string, unknown> | undefined): TodoCardData | null {
  const src = data ?? {};
  // 结果形：output 字段是字符串化 JSON（ToolMessage resultData 约定；
  // 历史回放为 {ok,output} 信封——unwrapToolResult 解包后同源）
  const output = unwrapToolResult(parseContent(src.output));
  const fromOutput = todoListOf(output?.todos ?? output);
  if (fromOutput && fromOutput.length > 0) return { todos: fromOutput, settled: true };
  const fromArgs = todoListOf(src.todos);
  if (!fromArgs || fromArgs.length === 0) return null;
  return { todos: fromArgs, settled: output !== null || src.output !== undefined };
}

const GOAL_STATUSES = ['active', 'paused', 'completed', 'blocked'];

function goalOf(raw: unknown): TaskGoal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const objective = typeof o.objective === 'string' ? o.objective.trim() : '';
  if (!objective) return null;
  const status = GOAL_STATUSES.includes(String(o.status)) ? (o.status as TaskGoal['status']) : 'active';
  return {
    id: typeof o.id === 'string' ? o.id : '',
    objective,
    status,
    ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
    ...(typeof o.blockedReason === 'string' && o.blockedReason ? { blockedReason: o.blockedReason } : {}),
    ...(typeof o.autoPausedReason === 'string' && o.autoPausedReason ? { autoPausedReason: o.autoPausedReason } : {}),
    ...(typeof o.roundsDone === 'number' ? { roundsDone: o.roundsDone } : {}),
    ...(typeof o.maxRounds === 'number' ? { maxRounds: o.maxRounds } : {}),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    ...(typeof o.completedAt === 'string' ? { completedAt: o.completedAt } : {}),
  };
}

export interface GoalCardData {
  goal: TaskGoal;
  /** 结果消息行（create/update 的 message；无则省略） */
  message?: string;
  /** 结果已返回（false = 调用中，args 预览） */
  settled: boolean;
}

/**
 * goal 工具消息 → 卡片数据。优先序：output.goal（create/update 终值）→
 * output.current（get 终值）→ args（objective/status 预览）。
 * 不可解析 → null（卡片隐藏）。
 */
export function normalizeGoalCard(data: Record<string, unknown> | undefined): GoalCardData | null {
  const src = data ?? {};
  const output = unwrapToolResult(parseContent(src.output));
  const settled = output !== null || src.output !== undefined;
  const fromOutput = goalOf(output?.goal) ?? goalOf(output?.current);
  if (fromOutput) {
    const message = typeof output?.message === 'string' ? output.message : undefined;
    return { goal: fromOutput, ...(message ? { message } : {}), settled: true };
  }
  const fromArgs = goalOf({ objective: src.objective, status: src.status });
  if (!fromArgs) return null;
  return { goal: fromArgs, settled };
}
