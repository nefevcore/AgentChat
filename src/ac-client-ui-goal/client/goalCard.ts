// ============================================================
// ac-client-ui-goal/client/goalCard.ts —— goal 会话流卡片归一化
//（M28 P1 §4.1 原案：自 tool 随域迁入——ToolResultGoal/GoalBar/
// useGoalTracking 共用的数据管线纯函数）
//
// live 帧（output 的 JSON.stringify）与历史回放
//（JSON.stringify({ok,output})）两形统一。webui api/tasks re-export
// 维持旧路径。
// ============================================================

/** 目标记录（= ac-goal GoalRecord 的前端视图形） */
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
