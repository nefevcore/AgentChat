// ============================================================
// ac-todo —— 待办清单（ctx.todos）：跨 run 工作清单 + todo 工具
//
// 定位：多步工作的「当下计划面」——整表全量重写（DSH todo_write 同款
// 语义：每次发送完整清单替换旧表，无逐条增删接口），Agent 随做随更
// （开工标 in_progress、完成即标 completed，不批量补记）。
//
// 状态到达模型的通道 = **消息面**（todo 工具调用与结果的历史行 +
// goal-round 消息的对齐提示），**不改写 system**——清单逐轮变化，
// system 注入会使 [system+tool schema] 前缀每轮失效（KV cache 全
// miss）；消息面追加只扩展前缀尾部（M21/D4 同口径，system 恒定）。
// 需要对齐状态时模型经 todo(action="read") 主动读。
//
// 状态归属（与 ac-goal 同规约，对齐 ac-memory 键口径）：
//   · 桶键 = conversationId ?? agentId——清单随会话桶走：1v1 对话、
//     群、独立会话（sid）、Agent 自会话（a~a）各一份，互不串扰；
//   · 持久化归 ac-agent-store（ADR-5：entry key 'todo'，单 entry 存
//     该 Agent 全部桶；桶数上限 32 按 updatedAt 淘汰）；
//   · 每表上限 50 条；条目 = { content, status }，status 缺省 pending。
//
// 工具面（repo 惯例：单工具 + action 枚举）：
//   todo(action=write/read) —— write 携带整表（todos 数组，空表 = 清单
//   清空），read 查看当前清单。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type {} from 'ac-agent-store'; // ctx.agentStore 服务类型（type-only）

/** 待办状态：pending 未开始 / in_progress 进行中 / completed 已完成 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 待办条目（顺序即清单序，由模型维护） */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** 会话桶内的待办清单 */
export interface TodoBucket {
  items: TodoItem[];
  updatedAt: string;
}

/** agentStore entry 'todo' 的持久形态（单 entry 存该 Agent 全部桶） */
export interface TodoStore {
  version: 1;
  buckets: Record<string, TodoBucket>;
}

/** agentStore entry key（param-case；机制数据归 agent-store 唯一写口） */
const TODO_ENTRY_KEY = 'todo';
/** 桶数上限（按 updatedAt 淘汰最旧） */
const MAX_BUCKETS = 32;
/** 每表条目上限 */
const MAX_ITEMS = 50;
/** content 长度上限 */
const MAX_CONTENT = 1000;

function isTodoStatus(v: unknown): v is TodoStatus {
  return v === 'pending' || v === 'in_progress' || v === 'completed';
}

export class TodosService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'todos');
  }

  // ============================================================
  // 桶读写（agentStore entry 'todo'；读改写全量落盘，原子性由 store 保证）
  // ============================================================

  private loadStore(agentId: string): TodoStore {
    const stored = this.ctx.agentStore.readEntry<TodoStore>(agentId, TODO_ENTRY_KEY);
    if (stored === undefined || stored === null || typeof stored !== 'object'
      || stored.buckets === undefined || typeof stored.buckets !== 'object') {
      return { version: 1, buckets: {} };
    }
    return stored;
  }

  private saveStore(agentId: string, store: TodoStore): void {
    // 桶淘汰：超上限按 updatedAt 淘汰最旧（防无界增长）
    const keys = Object.keys(store.buckets);
    if (keys.length > MAX_BUCKETS) {
      const sorted = keys.sort((a, b) =>
        (store.buckets[a]?.updatedAt ?? '') < (store.buckets[b]?.updatedAt ?? '') ? -1 : 1);
      for (const k of sorted.slice(0, keys.length - MAX_BUCKETS)) delete store.buckets[k];
    }
    this.ctx.agentStore.saveEntry(agentId, TODO_ENTRY_KEY, store);
  }

  /** 桶键校验（空键拒绝；键为 JSON 字段非文件名，无路径词法约束） */
  private assertKey(agentId: string, key: string): void {
    if (!agentId) throw new Error('缺少 agentId（todo 状态按 Agent × 会话桶归属）');
    if (!key) throw new Error('缺少会话桶键（conversationId ?? agentId）');
  }

  // ============================================================
  // 查询 / 写 API（域规则违反抛错——工具面由 ac-tools 收敛）
  // ============================================================

  /** 当前清单（只读副本；无清单 = 空表） */
  list(agentId: string, key: string): TodoItem[] {
    this.assertKey(agentId, key);
    const bucket = this.loadStore(agentId).buckets[key];
    if (bucket === undefined || typeof bucket !== 'object' || !Array.isArray(bucket.items)) return [];
    return bucket.items.map((t) => ({ ...t }));
  }

  /** 全部桶视图（诊断） */
  listBuckets(agentId: string): Array<{ key: string; bucket: TodoBucket }> {
    const store = this.loadStore(agentId);
    return Object.entries(store.buckets).map(([key, bucket]) => ({ key, bucket }));
  }

  /**
   * 整表全量重写（DSH todo_write 语义：每次发送完整清单替换旧表）。
   * 校验：数组 ≤ 50 条；content 非空（trim）≤ 1000 字符；status 枚举
   * （缺省 pending）。空数组 = 清单清空。返回归一化后的清单。
   */
  write(agentId: string, key: string, items: unknown): TodoItem[] {
    this.assertKey(agentId, key);
    if (!Array.isArray(items)) throw new Error('todos 须为数组（整表全量重写；空数组 = 清空清单）');
    if (items.length > MAX_ITEMS) throw new Error(`todos 过长（上限 ${MAX_ITEMS} 条——拆分工作或收口已完成项）`);
    const normalized: TodoItem[] = items.map((raw, i) => {
      if (raw === null || typeof raw !== 'object') {
        throw new Error(`todos[${i}] 须为 { content, status? } 对象`);
      }
      const item = raw as { content?: unknown; status?: unknown };
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!content) throw new Error(`todos[${i}].content 不能为空`);
      if (content.length > MAX_CONTENT) throw new Error(`todos[${i}].content 过长（上限 ${MAX_CONTENT} 字符）`);
      if (item.status !== undefined && !isTodoStatus(item.status)) {
        throw new Error(`todos[${i}].status "${String(item.status)}" 非法（pending/in_progress/completed 之一）`);
      }
      return { content, status: (item.status as TodoStatus) ?? 'pending' };
    });
    const store = this.loadStore(agentId);
    store.buckets[key] = { items: normalized, updatedAt: new Date().toISOString() };
    this.saveStore(agentId, store);
    return normalized.map((t) => ({ ...t }));
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 待办清单服务（ac-todo 提供）：会话桶工作清单 + todo 工具（write 全量重写/read） */
    todos: TodosService;
  }
}

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

export const name = 'ac-todo';

export const inject = ['tools', 'agentStore'];

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'todo',
  label: '待办清单',
  description: '跨 run 工作清单（todo 工具 write 整表全量重写/read 查看；桶键 = conversationId ?? agentId，持久化 agent-store entry；状态经消息面到达模型，不改写 system——KV cache 友好）',
  automatic: true,
};

export function apply(ctx: Context) {
  // 服务直接挂本行 fiber（durable-interaction 形态）：service + 工具注册
  // + 注入监听同 fiber 归属，摘行整体回收
  const service = new TodosService(ctx);

  ctx.tools.register({
    name: 'todo',
    description:
      '管理工作清单：write 整表全量重写（todos 数组，每次发送完整清单替换旧表；空数组 = 清空）、read 查看。条目 = { content, status: pending|in_progress|completed（缺省 pending）}；随做随更——开工标 in_progress、完成即标，不批量补记；跨 run 推进时先 read 对齐当前清单。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'read'], description: '操作' },
        todos: {
          type: 'array',
          description: '[write] 整表（全量替换；上限 50 条）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '待办内容（祈使句，一条一个动作）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态（缺省 pending）' },
            },
            required: ['content'],
          },
        },
      },
      required: ['action'],
    },
    execute(args, call): ToolResult {
      const agentId = call.agentId;
      if (agentId === undefined) return err('缺少执行身份（agentId）——todo 需在 Agent run 内调用');
      const key = call.conversationId ?? agentId;
      const action = String(args.action ?? '');

      // ---- read ----
      if (action === 'read') {
        const items = service.list(agentId, key);
        return { ok: true, output: { count: items.length, todos: items } };
      }

      // ---- write ----（域规则违反由服务抛错，ac-tools 收敛）
      if (action === 'write') {
        if (args.todos === undefined) return err('write 需要 todos 参数（整表数组；空数组 = 清空清单）');
        const items = service.write(agentId, key, args.todos);
        return {
          ok: true,
          output: {
            count: items.length,
            todos: items,
            message: items.length === 0
              ? '清单已清空'
              : `清单已全量重写（${items.length} 条；进行中 ${items.filter((t) => t.status === 'in_progress').length}）`,
          },
        };
      }

      return err(`未知 action "${action}"（write/read 之一）`);
    },
  });
}
