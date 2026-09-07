// ============================================================
// ac-client-ui-todo/client/tasks.ts —— todo 域前端数据管线（owning = 本 UI 行）
//
// 自 webui api/tasks.ts 迁入的 todo 半边（M27.1 随 UI 行走，owning = ac-client-ui-todo）：
//   · fetchTodos —— todo/get RPC 直连（桶键 = conversationId：1v1 对键 /
//     singles sid）；写路径归 Agent 工具（todo write/read）——本面只读；
//   · normalizeTodoCard —— 会话流卡片数据归一化（live 帧与历史回放两形
//     统一）。goal 半边留 webui（ac-goal 迁移时随行走）。
//
// 行 client 不 import webui 内部模块：RPC 经 ac-client-runtime 契约面
// （RpcClientFace，inject 'rpc'）。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';

/** 待办条目（= src/index.ts TodoItem 的前端视图形） */
export interface TaskTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 读取某会话桶的待办清单（服务未装载 → null，dock 静默隐藏） */
export async function fetchTodos(
  rpc: Pick<RpcClientFace, 'call'>,
  agentId: string,
  conversationId: string,
): Promise<TaskTodo[] | null> {
  try {
    const r = await rpc.call<{ todos?: TaskTodo[] }>('todo/get', { agentId, conversationId });
    return Array.isArray(r.todos) ? r.todos : [];
  } catch {
    return null; // 可选能力未装载 / 连接失败：不渲染，不报错
  }
}

// ============================================================
// 会话流卡片归一化（纯函数）：todo 工具消息 → 卡片数据
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
