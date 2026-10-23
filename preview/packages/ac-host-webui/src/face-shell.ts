// ============================================================
// face-shell.ts —— 壳内服务面的宿主 RPC 半边（cr-569）
//
// 这些状态只能由壳进程答（R0a 判据 1）：goal/todo 的会话桶、工具目录、
// 运行队列。通道 = 控制帧（cr-552 同一条：stdin 行协议 → 壳 control() →
// ctrl.done 回执），编排面按需拉起壳（ensureAgent 幂等）。
//
// 时序：web 面先装配、orchestrator 后创建 → 端口经**惰性 getter**注入
//（boot 在创建编排面后回填），此处只按调用时刻取。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pairKey } from 'ac-core-utils';
import type { Context } from '@agentchat/cordis';

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
}

/** 编排面最小面（OrchestratorHandle 的结构子集——同 admin-preview 的接缝纪律） */
export interface ShellAdminPort {
  ensureAgent(agentId: string): Promise<{ control(frame: Record<string, unknown>): Promise<unknown> }>;
  /** 活壳清单（jobs / interaction 这类「无 agentId 入参」的面按活壳枚举——
   *  只查已在跑的壳，不因一次查询拉起全部 Agent） */
  handles?(): Map<string, { control(frame: Record<string, unknown>): Promise<unknown> }>;
}

export interface ShellFaceDeps {
  dataRoot: string;
  /** 编排面惰性端口（boot 创建后回填；null = 编排面缺失） */
  port: () => ShellAdminPort | null;
}

function obj(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error('参数 ' + key + ' 缺失或非非空字符串');
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 注册壳内服务面（goal / todo / 运行中断） */
export function registerShellFace(web: WebFace, ctx: Context, deps: ShellFaceDeps): void {
  void ctx;
  const call = async <T>(agentId: string, frame: Record<string, unknown>): Promise<T> => {
    const port = deps.port();
    if (port === null) {
      throw new Error('编排面未就绪（orchestrate:false 或 boot 未完成）——壳内服务面不可用');
    }
    const handle = await port.ensureAgent(agentId);
    return handle.control({ ctrl: 'admin', agentId, ...frame }) as Promise<T>;
  };

  web.registerRpc('goal/get', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    return call(agentId, { op: 'goal-get', conversationId: reqStr(p, 'conversationId') });
  });

  web.registerRpc('goal/update', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const patch = p.patch;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数 patch 须为对象');
    return call(agentId, { op: 'goal-update', conversationId: reqStr(p, 'conversationId'), patch });
  });

  web.registerRpc('goal/delete', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    return call(agentId, { op: 'goal-delete', conversationId: reqStr(p, 'conversationId') });
  });

  web.registerRpc('todo/get', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    return call(agentId, { op: 'todo-get', conversationId: reqStr(p, 'conversationId') });
  });

  // 运行中断（stop 按钮）：壳 conversation 服务的中止面（ADR-2 步边界检查）
  web.registerRpc('conversation/interrupt', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const port = deps.port();
    if (port === null) throw new Error('编排面未就绪（orchestrate:false 或 boot 未完成）——中断面不可用');
    const handle = await port.ensureAgent(agentId);
    return handle.control({ ctrl: 'interrupt' });
  });

  const liveShells = (): Array<{ agentId: string; control(frame: Record<string, unknown>): Promise<unknown> }> => {
    const port = deps.port();
    if (port === null || port.handles === undefined) return [];
    return [...port.handles().entries()]
      .map(([agentId, handle]) => ({ agentId, control: (frame: Record<string, unknown>) => handle.control(frame) }))
      .sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  };

  // 待答清单的应答（参数只有 {id, answer}——条目住在某只壳的 durable 存储里，
  // 按活壳枚举直到命中；没有活壳持有该 id = 可读原因失败）
  web.registerRpc('interaction/reply', async (params) => {
    const p = obj(params);
    const id = reqStr(p, 'id');
    let last: unknown = null;
    for (const shell of liveShells()) {
      const outcome = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'interaction-reply', id, answer: p.answer ?? null });
      last = outcome;
      const status = (outcome as { status?: string } | null)?.status;
      if (status !== 'not-found') return outcome;
    }
    if (last === null) throw new Error('未找到待答条目：当前没有活壳持有该 id（先让目标 Agent 跑起来）');
    return last;
  });

  // 待答清单（cr-580 前端恢复链——chat-core 启动/断连重拉 interaction/list
  // {state:'pending'}；活壳聚合：壳内 durable store 是唯一权威面，只读不拉起）
  web.registerRpc('interaction/list', async (params) => {
    const p = obj(params);
    const state = optStr(p.state);
    const filter = {
      ...(optStr(p.key) !== undefined ? { key: optStr(p.key) } : {}),
      ...(optStr(p.owner) !== undefined ? { owner: optStr(p.owner) } : {}),
      ...(state === 'pending' || state === 'answered' || state === 'closed' ? { state } : {}),
    };
    const interactions: unknown[] = [];
    for (const shell of liveShells()) {
      try {
        const out = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'interaction-list', filter }) as { interactions?: unknown[] } | null;
        if (Array.isArray(out?.interactions)) interactions.push(...out.interactions);
      } catch { /* 壳在退出——跳过（活壳枚举的瞬态语义） */ }
    }
    return { interactions };
  });

  // 后台任务清单/终止：jobs 住壳进程（worker = 壳子进程），按活壳枚举汇总
  web.registerRpc('jobs/list', async () => {
    const out: unknown[] = [];
    for (const shell of liveShells()) {
      const reply = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'jobs-list' }) as { jobs?: unknown[] } | null;
      for (const job of reply?.jobs ?? []) out.push({ ...(job as Record<string, unknown>), agentId: shell.agentId });
    }
    return { jobs: out };
  });

  web.registerRpc('jobs/kill', async (params) => {
    const id = reqStr(obj(params), 'id');
    for (const shell of liveShells()) {
      try {
        const reply = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'jobs-kill', id }) as { outcome?: string } | null;
        if (reply?.outcome !== undefined) return reply;
      } catch { /* 该壳没有这个 job —— 继续找 */ }
    }
    throw new Error('未找到该后台任务：当前没有活壳持有 id ' + id);
  });

  /** 子 Agent 的父 Agent（children 嵌套域：agents/<parent>/children/<child>） */
  const parentOfChild = (childId: string): string | undefined => {
    let agents: fs.Dirent[] = [];
    try { agents = fs.readdirSync(path.join(deps.dataRoot, 'agents'), { withFileTypes: true }); } catch { return undefined; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      if (fs.existsSync(path.join(deps.dataRoot, 'agents', a.name, 'children', childId))) return a.name;
    }
    return undefined;
  };

  // 子 Agent 会话消息（展示口径）：读子壳自己的账本（children 嵌套域），
  // 与 session/history 同形（role/agent_id 投影 + 尾部 limit/offset 分页）
  web.registerRpc('subagents/history', (params) => {
    const p = obj(params);
    const id = reqStr(p, 'id');
    const parent = parentOfChild(id);
    if (parent === undefined) throw new Error('子 Agent 不存在：' + id);
    const root = path.join(deps.dataRoot, 'agents', parent, 'children', id);
    let convs: string[] = [];
    try { convs = fs.readdirSync(path.join(root, 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 未开跑 */ }
    // 最新会话（mtime）——子 Agent 的展示面是它当前那段对话
    const latest = convs
      .map((c) => ({ c, m: (() => { try { return fs.statSync(path.join(root, 'sessions', c)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m)[0]?.c;
    // 子壳账本是 agent 域文件（不是 user 投影账本）——直接读 messages.jsonl
    const all: Array<{ role: string; agent_id?: string; content: string }> = [];
    if (convs.length > 0) {
      let text = '';
      try { text = fs.readFileSync(path.join(root, 'sessions', latest, 'messages.jsonl'), 'utf-8'); } catch { /* 未开跑 */ }
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue;
        let row: Record<string, unknown>;
        try { row = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
        if (row.type === 'session-header') continue;
        const role = row.agent_id === id ? 'assistant' : 'user';
        all.push({
          role,
          ...(typeof row.agent_id === 'string' ? { agent_id: row.agent_id } : {}),
          content: typeof row.content === 'string' ? row.content : '',
        });
      }
    }
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : undefined;
    const offset = typeof p.offset === 'number' && p.offset >= 0 ? Math.floor(p.offset) : 0;
    const page = limit === undefined ? all : all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset));
    return {
      id,
      records: page,
      total: all.length,
      ...(limit !== undefined ? { hasMore: offset + limit < all.length } : {}),
    };
  });

  // 停止子 Agent 的当前推理（父壳内 stopOp → 子壳 interrupt；实体保留可续聊）
  web.registerRpc('subagents/stop', async (params) => {
    const p = obj(params);
    const id = reqStr(p, 'id');
    const parent = parentOfChild(id);
    if (parent === undefined) throw new Error('子 Agent 不存在：' + id);
    const port = deps.port();
    if (port === null) throw new Error('编排面未就绪——子 Agent 停止面不可用');
    const handle = await port.ensureAgent(parent);
    return handle.control({ ctrl: 'admin', agentId: parent, op: 'subagents-stop', id });
  });

  // 归档触发（D11 全壳内）：整理 run + 归档重建都在目标壳内执行，宿主只发帧
  web.registerRpc('session/archive', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const conversationId = reqStr(p, 'conversationId');
    return call(agentId, { op: 'session-archive', conversationId });
  });

  // 软中断（runs 面词汇——运行跟踪面板中止按钮，cr-575）：按会话键命中活壳
  // 在途 run（run-state 对拍），每命中壳一帧 interrupt（ADR-2 步边界中止）。
  // 无活壳/无在途 = aborted 0（不拉起壳——中断没有目标就是无动作）。
  web.registerRpc('runs/interrupt', async (params) => {
    const conversationId = reqStr(obj(params), 'conversationId');
    let aborted = 0;
    for (const shell of liveShells()) {
      try {
        const st = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'run-state' }) as
          | { busy?: unknown; conversationId?: unknown }
          | null;
        if (st?.busy !== true || st.conversationId !== conversationId) continue;
        const out = await shell.control({ ctrl: 'interrupt' }) as { interrupted?: unknown } | null;
        if (out?.interrupted === true) aborted += 1;
      } catch { /* 壳在退出——跳过 */ }
    }
    return { aborted };
  });

  // next-turn 排队面（cr-575 产品化）：队列住壳内 ConversationMachine——
  // 队列随壳生灭（机器队列在内存，壳 idle-exit 后必空），故只查活壳不拉起：
  // 无活壳 = 空清单 / not-found（与主线「已消费条目 not-found」同 UI 语义）。
  const shellOf = (agentId: string): { control(frame: Record<string, unknown>): Promise<unknown> } | null => {
    const port = deps.port();
    const handle = port?.handles?.().get(agentId);
    return handle ?? null;
  };
  const queueConvOf = (p: Record<string, unknown>, agentId: string): string =>
    optStr(p.conversationId) ?? pairKey(optStr(p.sender) ?? 'user', agentId);

  web.registerRpc('conversation/queue', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const shell = shellOf(agentId);
    if (shell === null) return { items: [] };
    return shell.control({ ctrl: 'admin', agentId, op: 'queue-list', conversationId: queueConvOf(p, agentId) });
  });

  web.registerRpc('conversation/queue-remove', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const shell = shellOf(agentId);
    if (shell === null) return { removed: false };
    return shell.control({ ctrl: 'admin', agentId, op: 'queue-remove', conversationId: queueConvOf(p, agentId), id: reqStr(p, 'id') });
  });

  // outcome：steered = 已注入活跃 run；requeued = 窗口已关放回原位（收敛竞态不报失败）
  // 生效工具集（cr-582，agents/tool-defs）：Token 仪表固定开销估算的唯一
  // 消费面——投影住壳内（与 run 同口径），经控制帧往返；会话覆盖可选。
  web.registerRpc('agents/tool-defs', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const conversationId = optStr(p.conversationId);
    const out = await call(agentId, {
      op: 'tool-defs',
      ...(conversationId !== undefined ? { conversationId } : {}),
    }) as Record<string, unknown>;
    return { agentId, ...out };
  });

  // 全量工具目录（cr-582，tools/list）：注册面住各壳（行集 per-agent）——
  // 活壳并集去重（同名工具同一注册方，首个胜）；冷启动无活壳时拉起
  // __standard__（缺省全集行集）取代表目录，ExtToolsPane 冷面不空白。
  web.registerRpc('tools/list', async () => {
    let shells = liveShells();
    if (shells.length === 0) {
      const port = deps.port();
      if (port === null) return { tools: [] };
      shells = [{
        agentId: '__standard__',
        control: (frame) => port.ensureAgent('__standard__').then((h) => h.control(frame)),
      }];
    }
    const byName = new Map<string, Record<string, unknown>>();
    for (const shell of shells) {
      try {
        const out = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'tools-catalog' }) as { tools?: unknown[] } | null;
        for (const t of out?.tools ?? []) {
          const name = (t as { name?: unknown }).name;
          if (typeof name === 'string' && !byName.has(name)) byName.set(name, t as Record<string, unknown>);
        }
      } catch { /* 壳在退出——跳过 */ }
    }
    return { tools: [...byName.values()].sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0)) };
  });

  web.registerRpc('conversation/queue-steer', async (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    const shell = shellOf(agentId);
    if (shell === null) return { outcome: 'not-found' };
    return shell.control({ ctrl: 'admin', agentId, op: 'queue-steer', conversationId: queueConvOf(p, agentId), id: reqStr(p, 'id') });
  });
}
