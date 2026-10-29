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
import { readJournal, readLedger, stepsOfRun, stepsOfLedger } from 'ac-ledger';
import type { Context } from '@agentchat/cordis';

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
}

/** 编排面最小面（OrchestratorHandle 的结构子集——同 admin-preview 的接缝纪律） */
export interface ShellAdminPort {
  ensureAgent(agentId: string): Promise<{ control(frame: Record<string, unknown>): Promise<unknown> }>;
  /** 控制面统一入口（cr-675：池外活壳经 socket manage 通道受控——在则优先） */
  control?(agentId: string, frame: Record<string, unknown>): Promise<unknown>;
  /** 盘上活壳清单（含宿主换代前拉起的孤壳；缺席 = 退化为句柄池枚举） */
  liveShellIds?(): string[];
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
  /** 控制帧往返（cr-675）：编排面统一入口优先——池外活壳（宿主换代后的
   *  孤壳）经它自己的 transportHint 答帧；缺此入口才退回「按需拉起 → 句柄
   *  控制」（壳已在跑时那条链必被单例锁拒）。 */
  const shellCall = async (agentId: string, frame: Record<string, unknown>): Promise<unknown> => {
    const port = deps.port();
    if (port === null) {
      throw new Error('编排面未就绪（orchestrate:false 或 boot 未完成）——壳内服务面不可用');
    }
    if (port.control !== undefined) return port.control(agentId, frame);
    const handle = await port.ensureAgent(agentId);
    return handle.control(frame);
  };
  const call = <T>(agentId: string, frame: Record<string, unknown>): Promise<T> =>
    shellCall(agentId, { ctrl: 'admin', agentId, ...frame }) as Promise<T>;

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
    return shellCall(agentId, { ctrl: 'interrupt' });
  });

  // 活壳枚举（interaction/jobs 这类无 agentId 入参的聚合面）：优先盘上活壳
  // 清单（cr-675——宿主换代后孤壳不在句柄池，聚合面不能因换代而空），
  // 无非侵入清单时退回句柄池。
  const liveShells = (): Array<{ agentId: string; control(frame: Record<string, unknown>): Promise<unknown> }> => {
    const port = deps.port();
    if (port === null) return [];
    const unified = port.control;
    if (unified !== undefined && port.liveShellIds !== undefined) {
      return port.liveShellIds()
        .map((agentId) => ({ agentId, control: (frame: Record<string, unknown>) => unified(agentId, frame) }))
        .sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
    }
    if (port.handles === undefined) return [];
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
  // 聚合面逐壳容错（cr-675）：活壳清单取自盘上锁（含换代前拉起的孤壳以及
  // 改动前装载的老壳），单只壳不应答不该让整张面板失败——跳过并计数。
  // jobWire（cr-677）：meta 预览化与主线 ac-web-api 同款（500 字 + 省略号；
  // jobs/list·kill 共用）——WireJob.meta.output 为预览，全文走 read。
  const jobWire = (job: Record<string, unknown>): Record<string, unknown> => {
    const meta = job.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return job;
    const wired: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      wired[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
    }
    return { ...job, meta: wired };
  };
  web.registerRpc('jobs/list', async () => {
    const out: unknown[] = [];
    let skipped = 0;
    for (const shell of liveShells()) {
      try {
        const reply = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'jobs-list' }) as { jobs?: unknown[] } | null;
        for (const job of reply?.jobs ?? []) out.push(jobWire({ ...(job as Record<string, unknown>), agentId: shell.agentId }));
      } catch { skipped += 1; }
    }
    return { jobs: out, skipped };
  });

  web.registerRpc('jobs/kill', async (params) => {
    const id = reqStr(obj(params), 'id');
    for (const shell of liveShells()) {
      try {
        const reply = await shell.control({ ctrl: 'admin', agentId: shell.agentId, op: 'jobs-kill', id }) as
          | { outcome?: string; job?: Record<string, unknown> }
          | null;
        if (reply?.outcome !== undefined) {
          return { outcome: reply.outcome, ...(reply.job !== undefined ? { job: jobWire(reply.job) } : {}) };
        }
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
    // 子壳账本是 agent 域文件（不是 user 投影账本）——直接读 messages.jsonl；
    // 行形状对齐 session/history（role/agent_id/content/timestamp/run + steps）。
    // 在途 run 的内容只住 journal/partials.jsonl（收束才物化进账本，cr-697）——
    // cr-725 起按 run 键投影 journal 步行（steps + partial），运行中点开子会话
    // 不再只见到任务行。口径与 web-api session/history 的活投影同构。
    const all: Array<Record<string, unknown>> = [];
    if (convs.length > 0) {
      const dir = path.join(root, 'sessions', latest);
      const rows = readLedger(dir).rows;
      const lines = readJournal(dir);
      const linkedRuns = new Set<string>();
      for (const r of rows) {
        if (r.run !== undefined && r.run !== '') linkedRuns.add(r.run);
        const projected = r.role === 'agent' && r.agent_id === id && r.run !== undefined && r.run !== ''
          ? stepsOfLedger(rows, r.run) ?? stepsOfRun(lines, r.run)
          : null;
        all.push({
          role: r.agent_id === id ? 'assistant' : 'user',
          ...(r.agent_id !== '' ? { agent_id: r.agent_id } : {}),
          content: r.content,
          timestamp: r.timestamp,
          ...(r.run !== undefined && r.run !== '' ? { run: r.run } : {}),
          ...(projected !== null ? { steps: projected.steps, ...(projected.partial ? { partial: true } : {}) } : {}),
        });
      }
      // journal 步行盲区（在途 run / 收束即清前的存量）：账本无对应行的一律投出
      const candidates = new Set<string>();
      for (const l of lines) {
        if (l.run !== '' && (l.type === 'journal-step' || l.type === 'journal-inject')) candidates.add(l.run);
      }
      for (const run of candidates) {
        if (linkedRuns.has(run)) continue;
        const p = stepsOfLedger(rows, run) ?? stepsOfRun(lines, run);
        if (p === null) continue;
        all.push({ role: 'assistant', agent_id: id, content: '', run, steps: p.steps, ...(p.partial ? { partial: true } : {}) });
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

  // 子 Agent 持久化清单（cr-677）：跨父盘读聚合——subagents/updated 帧（壳
  // 旁带桥接）驱动前端 subagentBoard 重拉本面（帧载荷仅触发器）。数据源 =
  // children/ 物化树（跨重启完整）：与 ShellSubagentService.infoOf 同口径投影
  // （盘上直读——会话账本统计 runs/task，config.json 读 name）。busy/exited
  // 是父壳进程内态，盘读不可见——cr-725 起叠加活壳清单（subagents-list 管理
  // 帧只问在跑的壳，不因清单查询拉起壳；壳死/答错跳过，盘读兜底），否则
  // 运行中徽章恒 idle。query/runningOnly 在叠加后过滤。
  // include_deleted：preview 域 delete = 物理删除（无墓碑），deleted 恒 false
  // ——参数兼容接受（前端照传），空墓碑集为终态。
  web.registerRpc('subagents/list', async (params) => {
    const p = obj(params);
    const query = optStr(p.query);
    const runningOnly = p.running_only === true;
    let limit = 50;
    if (typeof p.limit === 'number' && p.limit > 0) limit = Math.min(Math.floor(p.limit), 100);
    const subs: Array<Record<string, unknown>> = [];
    let agents: fs.Dirent[] = [];
    try { agents = fs.readdirSync(path.join(deps.dataRoot, 'agents'), { withFileTypes: true }); } catch { /* 无 agents 目录 */ }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const childrenDir = path.join(deps.dataRoot, 'agents', a.name, 'children');
      let children: fs.Dirent[] = [];
      try { children = fs.readdirSync(childrenDir, { withFileTypes: true }); } catch { continue; }
      for (const c of children) {
        if (!c.isDirectory()) continue;
        const root = path.join(childrenDir, c.name);
        let name = '';
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8')) as { name?: unknown };
          if (typeof raw.name === 'string') name = raw.name;
        } catch { continue; }
        let task = '';
        let runs = 0;
        let createdAt = 0;
        let updatedAt = 0;
        let sessions: string[] = [];
        try { sessions = fs.readdirSync(path.join(root, 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 未开跑 */ }
        for (const s of sessions) {
          const dir = path.join(root, 'sessions', s);
          let rows: Array<{ role: string; agent_id?: string; content: string; run?: string }> = [];
          try {
            const text = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8');
            for (const line of text.split('\n')) {
              if (line.trim() === '') continue;
              try { rows.push(JSON.parse(line)); } catch { continue; }
            }
          } catch { continue; }
          if (task === '') {
            // 首条任务行 = 对端写的行（agent_id !== 子——viewer 投影同判据）
            const first = rows.find((r0) => r0.role === 'agent' && r0.agent_id !== c.name);
            if (first !== undefined) task = first.content.slice(0, 120);
          }
          runs += rows.filter((r0) => r0.role === 'agent' && r0.agent_id === c.name && typeof r0.run === 'string' && r0.run !== '').length;
          try {
            const st = fs.statSync(path.join(dir, 'messages.jsonl'));
            if (createdAt === 0 || st.birthtimeMs < createdAt) createdAt = st.birthtimeMs;
            if (st.mtimeMs > updatedAt) updatedAt = st.mtimeMs;
          } catch { /* 账本已读——时间戳缺席保零 */ }
        }
        subs.push({
          id: c.name,
          parentId: a.name,
          name,
          status: 'ready',
          // 盘读面无进程内 busy 态：终稿在场 = 曾收束（done）；实时运行徽章
          // 由 subagents/updated 帧驱动重拉保持（帧载荷携带 displayStatus）。
          displayStatus: runs > 0 ? 'done' : 'idle',
          task,
          runs,
          createdAt,
          updatedAt,
          deleted: false,
        });
      }
    }
    // 活壳态叠加（cr-725）：对每个在跑壳问 subagents-list，把 busy/exited
    // 覆盖到对应行（displayStatus 口径与 ShellSubagentService.infoOf 一致：
    // busy → running；aborted 硬退 → error；exited → stopped；否则盘读值）。
    const port = deps.port();
    if (port !== null && port.handles !== undefined) {
      const byId = new Map(subs.map((s) => [String(s.id), s]));
      await Promise.all([...port.handles().entries()].map(async ([shellId, handle]) => {
        let agents: Array<{ childId?: unknown; status?: unknown; busy?: unknown; exit?: { aborted?: unknown } | null }> | undefined;
        try {
          const out = await handle.control({ ctrl: 'admin', agentId: shellId, op: 'subagents-list' }) as { agents?: unknown };
          if (Array.isArray(out.agents)) agents = out.agents as typeof agents;
        } catch { /* 壳正死于途/答错——盘读值兜底 */ }
        if (agents === undefined) return;
        for (const e of agents) {
          if (typeof e.childId !== 'string') continue;
          const row = byId.get(e.childId);
          if (row === undefined) continue;
          row.status = typeof e.status === 'string' ? e.status : row.status;
          row.displayStatus = e.busy === true ? 'running'
            : e.exit?.aborted === true ? 'error'
            : e.status === 'exited' ? 'stopped'
            : row.displayStatus;
        }
      }));
    }
    const filtered = subs
      .filter((s) => query === undefined || String(s.id).includes(query) || String(s.name).includes(query))
      .filter((s) => !runningOnly || s.displayStatus === 'running')
      .sort((x, y) => Number(y.updatedAt) - Number(x.updatedAt))
      .slice(0, limit);
    return { activeCount: subs.filter((s) => s.displayStatus === 'running').length, total: subs.length, subs: filtered };
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
          | { busy?: unknown; conversationId?: unknown; runs?: unknown }
          | null;
        // cr-746 per-门：多 run 壳按 runs 数组对拍（旧壳顶层单 run 字段兼容）
        const hit = Array.isArray(st?.runs)
          ? (st.runs as Array<{ conversationId?: unknown }>).some((r) => r.conversationId === conversationId)
          : st?.busy === true && st.conversationId === conversationId;
        if (!hit) continue;
        const out = await shell.control({ ctrl: 'interrupt', conversationId }) as { interrupted?: unknown } | null;
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