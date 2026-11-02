// ============================================================
// face-shell.test.ts —— 宿主 RPC → 壳内控制帧（cr-569）
//
// 只验端口契约与帧形（真壳往返由 e2e 覆盖）：惰性端口、ensureAgent 幂等
// 调用、帧载荷 {ctrl:'admin', op, agentId, conversationId} 逐字段对齐。
// ============================================================
import { describe, it, expect } from 'vitest';
import type { Context } from '@agentchat/cordis';
import * as fs from 'node:fs';
import { registerShellFace, type ShellAdminPort } from '../src/face-shell.ts';

type Handler = (params: unknown) => unknown;

function collect(): { web: { registerRpc(m: string, h: Handler): void }; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return { web: { registerRpc: (m, h) => { handlers.set(m, h); } }, handlers };
}

function fakePort(): { port: ShellAdminPort; frames: Array<Record<string, unknown>>; ensured: string[] } {
  const frames: Array<Record<string, unknown>> = [];
  const ensured: string[] = [];
  return {
    frames,
    ensured,
    port: {
      async ensureAgent(agentId: string) {
        ensured.push(agentId);
        return { control: async (frame: Record<string, unknown>) => { frames.push(frame); return { echo: frame.op }; } };
      },
    },
  };
}

/** ctx.get 全 undefined（convSettings 等可选服务缺席 = 良定义降级） */
const ctx = { get: () => undefined } as unknown as Context;

/** 仓库根（catalogFile 锚点——vitest chdir 后相对路径失效） */
const REPO = process.env.AGENTCHAT_REPO_ROOT ?? process.cwd();

describe('壳内服务面 RPC（goal / todo / interrupt）', () => {
  it('goal/update、goal/delete：帧形逐字段对齐（ctrl=admin + op + agentId + conversationId）', async () => {
    const { web, handlers } = collect();
    const { port, frames, ensured } = fakePort();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await handlers.get('goal/update')!({ agentId: 'a1', conversationId: 'c1', patch: { status: 'active' } });
    await handlers.get('goal/delete')!({ agentId: 'a1', conversationId: 'c1' });
    expect(frames).toEqual([
      { ctrl: 'admin', agentId: 'a1', op: 'goal-update', conversationId: 'c1', patch: { status: 'active' } },
      { ctrl: 'admin', agentId: 'a1', op: 'goal-delete', conversationId: 'c1' },
    ]);
    expect(ensured).toEqual(['a1', 'a1']); // 写面保持拉起（ensureAgent 幂等）
  });

  // cr-824 批一 1-1/1-2：goal/get、todo/get 盘直读——壳不在场也 100% 可答，
  // 响应形状与壳内半边逐字段一致（{goal:{current,history}} / {todos:[...]}）。
  it('goal/get、todo/get：entries 盘直读（零控制帧），损坏/缺席 = 零值', async () => {
    const rootDir = 'sandbox/test-face-entry-' + process.pid;
    const entries = rootDir + '/agents/a1/entries';
    fs.mkdirSync(entries, { recursive: true });
    fs.writeFileSync(entries + '/goal.json', JSON.stringify({
      version: 1,
      buckets: {
        c1: {
          current: { id: 'g1', objective: '完成审计', status: 'active', createdAt: 'T1', updatedAt: 'T2' },
          history: [{ id: 'g0', objective: '旧目标', status: 'completed', createdAt: 'T0', updatedAt: 'T1', completedAt: 'T1' }],
          updatedAt: 'T2',
        },
      },
    }), 'utf-8');
    fs.writeFileSync(entries + '/todo.json', JSON.stringify({
      version: 1,
      buckets: { c1: { items: [{ content: '干活', status: 'in_progress' }], updatedAt: 'T2' } },
    }), 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null }); // 无编排面也照答
      expect(await handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'c1' })).toEqual({
        goal: {
          current: { id: 'g1', objective: '完成审计', status: 'active', createdAt: 'T1', updatedAt: 'T2' },
          history: [{ id: 'g0', objective: '旧目标', status: 'completed', createdAt: 'T0', updatedAt: 'T1', completedAt: 'T1' }],
        },
      });
      expect(await handlers.get('todo/get')!({ agentId: 'a1', conversationId: 'c1' })).toEqual({
        todos: [{ content: '干活', status: 'in_progress' }],
      });
      // 别桶 / entry 缺席 = 零值（history 空表、todos 空表——不报错不拉起）
      expect(await handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'other' })).toEqual({ goal: { history: [] } });
      expect(await handlers.get('todo/get')!({ agentId: 'ghost', conversationId: 'c1' })).toEqual({ todos: [] });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('conversation/interrupt：走既有 interrupt 帧', async () => {
    const { web, handlers } = collect();
    const { port, frames } = fakePort();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await handlers.get('conversation/interrupt')!({ agentId: 'a1' });
    expect(frames).toEqual([{ ctrl: 'interrupt' }]);
  });
  it('控制面统一入口优先（cr-675）：有 control 即直连，不 ensureAgent', async () => {
    const { web, handlers } = collect();
    const calls: Array<{ agentId: string; frame: Record<string, unknown> }> = [];
    const ensured: string[] = [];
    const port: ShellAdminPort = {
      async ensureAgent(agentId: string) {
        ensured.push(agentId);
        return { control: async () => ({ ok: true }) };
      },
      async control(agentId, frame) { calls.push({ agentId, frame }); return { echo: frame.op }; },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await handlers.get('goal/update')!({ agentId: 'a1', conversationId: 'c1', patch: { note: 'x' } });
    await handlers.get('conversation/interrupt')!({ agentId: 'a1' });
    expect(calls).toEqual([
      { agentId: 'a1', frame: { ctrl: 'admin', agentId: 'a1', op: 'goal-update', conversationId: 'c1', patch: { note: 'x' } } },
      { agentId: 'a1', frame: { ctrl: 'interrupt' } },
    ]);
    expect(ensured).toEqual([]); // 池外活壳不经拉起链（那链必被单例锁拒）
  });

  it('编排面缺席 fail-loud（bootHostWeb / orchestrate:false）', async () => {
    const { web, handlers } = collect();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => null });
    // goal/get 盘直读不受编排面缺席影响（cr-824 批一——空数据根零值照答）
    expect(await handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'c1' })).toEqual({ goal: { history: [] } });
    await expect(handlers.get('conversation/interrupt')!({ agentId: 'a1' })).rejects.toThrow(/编排面未就绪/);
  });

  it('jobs/list：逐壳容错（cr-675——单只不应答的壳不拖垮整张面板）', async () => {
    const { web, handlers } = collect();
    const port: ShellAdminPort = {
      async ensureAgent() { return { control: async () => ({ jobs: [] }) }; },
      async control(agentId) {
        if (agentId === 'stale') throw new Error('活壳 stale 不认控制帧');
        return { jobs: [{ id: 'j-' + agentId }] };
      },
      liveShellIds: () => ['a1', 'stale', 'b2'],
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    expect(await handlers.get('jobs/list')!({})).toEqual({
      jobs: [{ id: 'j-a1', agentId: 'a1' }, { id: 'j-b2', agentId: 'b2' }],
      skipped: 1,
    });
  });
  it('interaction/reply：按活壳枚举直到命中（not-found 继续，ok 返回）', async () => {
    const { web, handlers } = collect();
    const calls: string[] = [];
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      handles() {
        return new Map([
          ['a1', { control: async (f: Record<string, unknown>) => { calls.push('a1:' + String(f.op)); return { status: 'not-found' }; } }],
          ['b1', { control: async (f: Record<string, unknown>) => { calls.push('b1:' + String(f.op)); return { status: 'ok', answer: f.answer }; } }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    const out = await handlers.get('interaction/reply')!({ id: 'i1', answer: { answers: ['A'] } });
    expect(out).toMatchObject({ status: 'ok' });
    expect(calls).toEqual(['a1:interaction-reply', 'b1:interaction-reply']);
  });

  // cr-580 恢复链 + cr-824 批一 1-3：读面盘聚合——per-agent 域文件
  //（agents/<id>/ + children 嵌套域）全量聚合，壳不在场照样可读。
  it('interaction/list：盘聚合（agents 域 + children 域），filter 白名单窄化；坏域跳过不殃及', async () => {
    const rootDir = 'sandbox/test-face-inter-' + process.pid;
    const mk = (dir: string, rows: Array<Record<string, unknown>>) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dir + '/interactions.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    };
    const now = Date.now();
    mk(rootDir + '/agents/a1', [
      { id: 'i1', key: 'k1', kind: 'ask_questions', payload: {}, state: 'pending', createdAt: now, updatedAt: now },
      { id: 'i2', key: 'k2', kind: 'ask_questions', payload: {}, state: 'answered', answer: ['A'], createdAt: now - 1, updatedAt: now },
    ]);
    mk(rootDir + '/agents/p1/children/kid1', [
      { id: 'i3', key: 'k3', kind: 'ask_questions', payload: {}, state: 'pending', createdAt: now - 2, updatedAt: now },
    ]);
    // 损坏域（非法 JSON 行）——其余域照答
    fs.mkdirSync(rootDir + '/agents/bad', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/bad/interactions.jsonl', '{torn line', 'utf-8');
    try {
      const { web, handlers } = collect();
      const port: ShellAdminPort = {
        async ensureAgent() { throw new Error('不该拉起壳'); },
        handles: () => new Map(),
      };
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => port });
      const all = await handlers.get('interaction/list')!({}) as { interactions: Array<{ id: string }> };
      expect(all.interactions.map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i3']);
      const pending = await handlers.get('interaction/list')!({ state: 'pending', nonsense: 1 }) as { interactions: Array<{ id: string }> };
      expect(pending.interactions.map((i) => i.id).sort()).toEqual(['i1', 'i3']);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('interaction/reply：无活壳 fail-loud', async () => {
    const { web, handlers } = collect();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => ({ async ensureAgent() { throw new Error('x'); }, handles: () => new Map() }) });
    await expect(handlers.get('interaction/reply')!({ id: 'i1', answer: null })).rejects.toThrow(/未找到待答条目/);
  });

  it('jobs/list 汇总活壳（附 agentId）+ jobs/kill 命中所在壳', async () => {
    const { web, handlers } = collect();
    const killed: string[] = [];
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      handles() {
        return new Map([
          ['a1', { control: async (f: Record<string, unknown>) => {
            if (f.op === 'jobs-list') return { jobs: [{ id: 'j1' }] };
            if (f.id === 'j1') return { outcome: 'cancellation-requested' };
            throw new Error('no such job');
          } }],
          ['b1', { control: async (f: Record<string, unknown>) => { if (f.op === 'jobs-kill') { killed.push('b1'); throw new Error('no such job'); } return { jobs: [{ id: 'j2' }] }; } }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    const list = await handlers.get('jobs/list')!({}) as { jobs: Array<{ id: string; agentId: string }> };
    expect(list.jobs).toEqual([{ id: 'j1', agentId: 'a1' }, { id: 'j2', agentId: 'b1' }]);
    const kill = await handlers.get('jobs/kill')!({ id: 'j1' });
    expect(kill).toMatchObject({ outcome: 'cancellation-requested' });
    await expect(handlers.get('jobs/kill')!({ id: 'zzz' })).rejects.toThrow(/未找到该后台任务/);
  });

  it('session/archive：按 agentId 拉起壳后发归档帧', async () => {
    const { web, handlers } = collect();
    const { port, frames, ensured } = fakePort();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await handlers.get('session/archive')!({ agentId: 'a1', conversationId: 'c1' });
    expect(ensured).toEqual(['a1']);
    expect(frames[0]).toMatchObject({ ctrl: 'admin', op: 'session-archive', conversationId: 'c1' });
  });

  it('subagents/history 读子壳账本（children 嵌套域）；stop 按父壳拉起并发帧', async () => {
    const rootDir = 'sandbox/test-sub-face-' + process.pid;
    const childDir = rootDir + '/agents/parent1/children/kid1';
    fs.mkdirSync(childDir + '/sessions/c1', { recursive: true });
    fs.writeFileSync(childDir + '/sessions/c1/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1, participants: ['kid1', 'parent1'] }),
      JSON.stringify({ role: 'agent', agent_id: 'parent1', content: '干活' }),
      JSON.stringify({ role: 'agent', agent_id: 'kid1', content: '收到' }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      const { port, frames } = fakePort();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => port });
      const history = await handlers.get('subagents/history')!({ id: 'kid1' }) as { records: Array<{ role: string; content: string }>; total: number };
      expect(history.total).toBe(2);
      expect(history.records).toEqual([
        { role: 'user', agent_id: 'parent1', content: '干活' },
        { role: 'assistant', agent_id: 'kid1', content: '收到' },
      ]);
      await handlers.get('subagents/stop')!({ id: 'kid1' });
      expect(frames).toEqual([{ ctrl: 'admin', agentId: 'parent1', op: 'subagents-stop', id: 'kid1' }]);
      expect(() => handlers.get('subagents/history')!({ id: 'ghost' })).toThrow(/不存在/);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // cr-677：子 Agent 持久化清单——跨父盘读聚合（children 树 + 会话账本统计）
  it('subagents/list：跨父盘读聚合（runs/task 统计 + query 过滤 + limit 截断）；无 children = 空清单', async () => {
    const rootDir = 'sandbox/test-sub-list-' + process.pid;
    const childDir = rootDir + '/agents/parent1/children/kid1';
    fs.mkdirSync(childDir + '/sessions/s1', { recursive: true });
    fs.writeFileSync(childDir + '/config.json', JSON.stringify({ id: 'kid1', name: '调研员' }), 'utf-8');
    fs.writeFileSync(childDir + '/sessions/s1/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1 }),
      JSON.stringify({ role: 'agent', agent_id: 'parent1', content: '去查证 X' }),
      JSON.stringify({ role: 'agent', agent_id: 'kid1', content: '收到', run: 'run-1' }),
    ].join('\n') + '\n', 'utf-8');
    // 第二父：物化但未开跑（无 sessions）
    fs.mkdirSync(rootDir + '/agents/parent2/children/kid2', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/parent2/children/kid2/config.json', JSON.stringify({ id: 'kid2' }), 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null });
      const all = await handlers.get('subagents/list')!({ include_deleted: true }) as {
        activeCount: number; total: number;
        subs: Array<{ id: string; parentId: string; name: string; task: string; runs: number; displayStatus: string; deleted: boolean }>;
      };
      expect(all.total).toBe(2);
      const kid1 = all.subs.find((s) => s.id === 'kid1')!;
      expect(kid1).toMatchObject({ parentId: 'parent1', name: '调研员', task: '去查证 X', runs: 1, displayStatus: 'done', deleted: false });
      expect(all.subs.find((s) => s.id === 'kid2')!).toMatchObject({ parentId: 'parent2', name: '', runs: 0, displayStatus: 'idle' });
      // query 过滤 + limit 截断
      const q = await handlers.get('subagents/list')!({ query: 'kid1' }) as { total: number; subs: unknown[] };
      expect(q.subs).toHaveLength(1);
      const lim = await handlers.get('subagents/list')!({ limit: 1 }) as { total: number; subs: unknown[] };
      expect(lim.subs).toHaveLength(1);
      // 无 children 树的数据根 = 空清单（非错误）
      const { web: web2, handlers: h2 } = collect();
      registerShellFace(web2, ctx, { dataRoot: rootDir + '/nonexistent', port: () => null });
      expect(await h2.get('subagents/list')!({})).toMatchObject({ total: 0, subs: [] });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // cr-725：busy/exited 是父壳进程内态，盘读不可见——subagents/list 叠加
  // 活壳 subagents-list 回执（只问在跑的壳；壳答错 = 盘读值兜底）。
  it('subagents/list 活壳态叠加：busy → running（activeCount 口径同步）；壳死兜底盘读值', async () => {
    const rootDir = 'sandbox/test-sub-live-' + process.pid;
    const childDir = rootDir + '/agents/parent1/children/kid1';
    fs.mkdirSync(childDir + '/sessions/s1', { recursive: true });
    fs.writeFileSync(childDir + '/config.json', JSON.stringify({ id: 'kid1', name: '调研员' }), 'utf-8');
    fs.writeFileSync(childDir + '/sessions/s1/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1 }),
      JSON.stringify({ role: 'agent', agent_id: 'parent1', content: '去查证 X' }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const port: ShellAdminPort = {
        async ensureAgent() { throw new Error('不该拉起壳'); },
        handles() {
          return new Map([
            ['parent1', { control: async (f: Record<string, unknown>) => {
              if (f.op === 'subagents-list') return { agents: [{ childId: 'kid1', status: 'ready', pid: 1, busy: true }] };
              throw new Error('未知 op');
            } }],
            ['dead-shell', { control: async () => { throw new Error('壳已死'); } }],
          ]);
        },
      };
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => port });
      const out = await handlers.get('subagents/list')!({}) as { activeCount: number; subs: Array<{ displayStatus: string }> };
      expect(out.activeCount).toBe(1); // 运行中不再是空闲
      expect(out.subs.find(() => true)!.displayStatus).toBe('running');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // cr-725：在途 run 内容只住 journal/partials.jsonl（收束才物化进账本）——
  // subagents/history 按 run 键投影 journal 步行，运行中点开子会话可见过程。
  it('subagents/history journal 活投影：在途 run 步行投出（steps + partial）；未知 id fail-loud', async () => {
    const rootDir = 'sandbox/test-sub-hist-' + process.pid;
    const sessDir = rootDir + '/agents/parent1/children/kid1/sessions/c1';
    fs.mkdirSync(sessDir + '/journal', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/parent1/children/kid1/config.json', JSON.stringify({ id: 'kid1' }), 'utf-8');
    fs.writeFileSync(sessDir + '/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1, participants: ['kid1', 'parent1'] }),
      JSON.stringify({ role: 'agent', agent_id: 'parent1', content: '干活' }),
    ].join('\n') + '\n', 'utf-8');
    fs.writeFileSync(sessDir + '/journal/partials.jsonl', [
      JSON.stringify({ type: 'journal-step', run: 'run-9', step: 1, content: '先查证路径', ts: 1 }),
      JSON.stringify({ type: 'journal-step', run: 'run-9', step: 2, content: '再读源码', ts: 2 }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null });
      const out = await handlers.get('subagents/history')!({ id: 'kid1' }) as {
        total: number;
        records: Array<{ role: string; content: string; run?: string; partial?: boolean; steps?: Array<{ content: string }> }>;
      };
      expect(out.total).toBe(2); // 任务行 + 在途 run 投影行
      expect(out.records[0]).toMatchObject({ role: 'user', content: '干活' });
      const inFlight = out.records[1]!;
      expect(inFlight).toMatchObject({ role: 'assistant', run: 'run-9', content: '', partial: true });
      expect(inFlight.steps?.map((s) => s.content)).toEqual(['先查证路径', '再读源码']);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // cr-856（cr-803 续）：子 Agent 会话视角的 run_code 编排可见性回归锁——
  // 段行物化剥离 subcall 卡 + subcalls.jsonl 档案分流后，读面必须联查注入
  // 复原平铺（漏同步任一调用点 = 「回放看不到 run_code 编排」复发）。
  it('subagents/history 子域 run_code 编排：subcalls.jsonl 联查平铺复原', async () => {
    const rootDir = 'sandbox/test-sub-subcall-' + process.pid;
    const sessDir = rootDir + '/agents/parent1/children/kid1/sessions/parent1~kid1';
    fs.mkdirSync(sessDir + '/journal', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/parent1/children/kid1/config.json', JSON.stringify({ id: 'kid1' }), 'utf-8');
    const header = { type: 'session-header', version: 1, participants: ['kid1', 'parent1'] };
    const taskRow = { role: 'agent', agent_id: 'parent1', content: '调研任务', requestId: 't1' };
    const finalRow = { role: 'agent', content: '终稿', agent_id: 'kid1', run: 'run-1', requestId: 'reply-t1', message_id: 'm1', timestamp: new Date().toISOString(), seq: 3 };
    const hostCard = { id: 'call-h1', name: 'run_code', arguments: 'stub', result: { ok: true } };
    const segRow = { role: 'agent', content: '', agent_id: 'kid1', run: 'run-1', source: 'segment', message_id: 'seg-run-1-0', timestamp: new Date().toISOString(), seq: 2, steps: [{ content: '', toolCalls: [hostCard] }] };
    fs.writeFileSync(sessDir + '/messages.jsonl', [header, taskRow, finalRow, segRow].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const sub1 = { type: 'journal-tool-result', run: 'run-1', toolCallId: 'call-h1#1', subcall: true, name: 'read', arguments: '{}', result: { ok: true, output: { path: 'a.ts' } }, seq: 1 };
    const sub2 = { type: 'journal-tool-result', run: 'run-1', toolCallId: 'call-h1#2', subcall: true, name: 'grep', arguments: '{}', result: { ok: true, output: { total: 3 } }, seq: 2 };
    fs.writeFileSync(sessDir + '/subcalls.jsonl', [sub1, sub2].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null });
      const historyRpc = handlers.get('subagents/history');
      const out = historyRpc !== undefined ? await historyRpc({ id: 'kid1' }) : null;
      expect(out).not.toBeNull();
      const records = (out as { records: Array<{ run?: string; steps?: Array<{ toolCalls?: Array<{ name: string; subcall?: boolean }> }> }> }).records;
      const settled = records.find((r) => r.run === 'run-1' && r.steps !== undefined);
      expect(settled).toBeDefined();
      const flat = settled?.steps?.[0]?.toolCalls ?? [];
      expect(flat.map((tc) => [tc.name, tc.subcall ?? false])).toEqual([
        ['run_code', false],
        ['read', true],
        ['grep', true],
      ]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  it('runs/interrupt：按会话键命中活壳在途 run（interrupt 帧）；未命中 = aborted 0', async () => {
    const { web, handlers } = collect();
    const frames: Array<Record<string, unknown>> = [];
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      handles() {
        return new Map([
          ['a1', { control: async (f: Record<string, unknown>) => { frames.push(f); return f.op === 'run-state' ? { busy: true, conversationId: 'c1' } : { interrupted: true }; } }],
          ['b1', { control: async (f: Record<string, unknown>) => { frames.push(f); return { busy: false, conversationId: null }; } }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    const out = await handlers.get('runs/interrupt')!({ conversationId: 'c1' });
    expect(out).toEqual({ aborted: 1 });
    expect(frames).toEqual([
      { ctrl: 'admin', agentId: 'a1', op: 'run-state' },
      { ctrl: 'interrupt', conversationId: 'c1' }, // cr-746：多 run 壳按会话键中止
      { ctrl: 'admin', agentId: 'b1', op: 'run-state' },
    ]);
    expect(await handlers.get('runs/interrupt')!({ conversationId: 'ghost' })).toEqual({ aborted: 0 });
  });

  it('队列面（cr-575）：活壳帧往返（会话键缺省 = user 对桶）；无活壳 = 空清单/not-found 不拉起', async () => {
    const { web, handlers } = collect();
    const frames: Array<Record<string, unknown>> = [];
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      handles() {
        return new Map([
          ['a1', { control: async (f: Record<string, unknown>) => { frames.push(f); return { items: [{ id: 'r1' }] }; } }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    // queue：无 conversationId/sender → pairKey('user', agentId)
    await handlers.get('conversation/queue')!({ agentId: 'a1' });
    // queue-remove/steer：帧带 id + 显式会话键
    await handlers.get('conversation/queue-remove')!({ agentId: 'a1', conversationId: 'c1', id: 'r1' });
    await handlers.get('conversation/queue-steer')!({ agentId: 'a1', sender: 'bob', id: 'r1' });
    expect(frames).toEqual([
      { ctrl: 'admin', agentId: 'a1', op: 'queue-list', conversationId: 'a1~user' },
      { ctrl: 'admin', agentId: 'a1', op: 'queue-remove', conversationId: 'c1', id: 'r1' },
      { ctrl: 'admin', agentId: 'a1', op: 'queue-steer', conversationId: 'a1~bob', id: 'r1' },
    ]);
    // 无活壳（队列随壳生灭，壳不在 = 必空）——良定义降级不抛
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => null });
    expect(await handlers.get('conversation/queue')!({ agentId: 'zz' })).toEqual({ items: [] });
    expect(await handlers.get('conversation/queue-remove')!({ agentId: 'zz', id: 'x' })).toEqual({ removed: false });
    expect(await handlers.get('conversation/queue-steer')!({ agentId: 'zz', id: 'x' })).toEqual({ outcome: 'not-found' });
  });
  // cr-582 工具面 + cr-825 批三：估算面活壳真值优先、壳缺席静态算；目录 = 静态底座 ∪ 活壳增量（零拉起）
  it('agents/tool-defs：活壳真值往返；壳缺席静态算（mode 收窄 + 行展开），不拉起', async () => {
    const rootDir = 'sandbox/test-face-tdefs-' + process.pid;
    const dir = rootDir + '/agents/a1';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/config.json', JSON.stringify({ id: 'a1', model: 'mock', rows: ['fs-tools'] }), 'utf-8');
    try {
      // 活壳真值：壳在句柄池 → tool-defs 帧往返（与 run 同口径）
      const frames: Array<Record<string, unknown>> = [];
      const live: ShellAdminPort = {
        async ensureAgent() { throw new Error('活壳在场不走拉起链'); },
        handles: () => new Map([['a1', { control: async (f: Record<string, unknown>) => { frames.push(f); return { echo: 'tool-defs' }; } }]]),
      };
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => live });
      await expect(handlers.get('agents/tool-defs')!({ agentId: 'a1', conversationId: 'c1' })).resolves.toMatchObject({ agentId: 'a1', echo: 'tool-defs' });
      expect(frames).toEqual([{ ctrl: 'admin', agentId: 'a1', op: 'tool-defs', conversationId: 'c1' }]);
      // 壳缺席：句柄池空 → 静态算（catalogFile 指向真实快照——行展开 fs-tools → read/write/edit）
      const ensured: string[] = [];
      const absent: ShellAdminPort = {
        async ensureAgent(id) { ensured.push(id); return { control: async () => ({ names: [] }) }; },
        handles: () => new Map(),
      };
      const { web: w2, handlers: h2 } = collect();
      registerShellFace(w2, ctx, { dataRoot: rootDir, port: () => absent, catalogFile: REPO + '/apps/catalog/row-catalog.json' });
      const out = await h2.get('agents/tool-defs')!({ agentId: 'a1' }) as { names: string[]; defs: Array<{ name: string }> };
      expect(out.names.sort()).toEqual(['edit', 'read', 'write']);
      expect(ensured).toEqual([]); // 读面零拉起（cr-825 批三——估算不 spawn 壳）
      await expect(h2.get('agents/tool-defs')!({})).rejects.toThrow(/agentId/);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('tools/list：静态底座 ∪ 活壳增量（活壳真值覆盖）；冷启动零拉起', async () => {
    const { web, handlers } = collect();
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('冷启动不得拉起壳（cr-825）'); },
      handles() {
        return new Map([
          ['a1', { control: async () => ({ tools: [{ name: 'read', description: '活壳真值' }, { name: 'dyn-plugin-tool', owner: 'x' }] }) }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port, catalogFile: REPO + '/apps/catalog/row-catalog.json' });
    const out = await handlers.get('tools/list')!({}) as { tools: Array<{ name: string; description?: string }> };
    const byName = new Map(out.tools.map((t) => [t.name, t]));
    expect(out.tools.length).toBeGreaterThan(50); // 静态底座在场（快照 68 工具）
    expect(byName.get('read')?.description).toBe('活壳真值'); // 活壳覆盖静态
    expect(byName.get('dyn-plugin-tool')).toBeDefined(); // 动态增量并入
    expect(byName.get('goal')).toBeDefined(); // 静态条目（无活壳声明）保留
    // 冷启动：无活壳 = 纯静态底座，零拉起（ensureAgent 抛错守卫）
    const cold: ShellAdminPort = { async ensureAgent() { throw new Error('不该拉起'); }, handles: () => new Map() };
    const { web: w2, handlers: h2 } = collect();
    registerShellFace(w2, ctx, { dataRoot: 'X', port: () => cold, catalogFile: REPO + '/apps/catalog/row-catalog.json' });
    const coldOut = await h2.get('tools/list')!({}) as { tools: unknown[] };
    expect(coldOut.tools.length).toBeGreaterThan(50);
    // 编排面缺席 = 纯静态底座（良定义降级，不抛不空）
    const { web: w3, handlers: h3 } = collect();
    registerShellFace(w3, ctx, { dataRoot: 'X', port: () => null, catalogFile: REPO + '/apps/catalog/row-catalog.json' });
    const noPort = await h3.get('tools/list')!({}) as { tools: unknown[] };
    expect(noPort.tools.length).toBeGreaterThan(50);
  });
});

