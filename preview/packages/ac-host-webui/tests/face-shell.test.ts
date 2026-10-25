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

const ctx = {} as Context;

describe('壳内服务面 RPC（goal / todo / interrupt）', () => {
  it('goal/* 与 todo/get：帧形逐字段对齐（ctrl=admin + op + agentId + conversationId）', async () => {
    const { web, handlers } = collect();
    const { port, frames, ensured } = fakePort();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'c1' });
    await handlers.get('goal/update')!({ agentId: 'a1', conversationId: 'c1', patch: { status: 'active' } });
    await handlers.get('goal/delete')!({ agentId: 'a1', conversationId: 'c1' });
    await handlers.get('todo/get')!({ agentId: 'a1', conversationId: 'c1' });
    expect(frames).toEqual([
      { ctrl: 'admin', agentId: 'a1', op: 'goal-get', conversationId: 'c1' },
      { ctrl: 'admin', agentId: 'a1', op: 'goal-update', conversationId: 'c1', patch: { status: 'active' } },
      { ctrl: 'admin', agentId: 'a1', op: 'goal-delete', conversationId: 'c1' },
      { ctrl: 'admin', agentId: 'a1', op: 'todo-get', conversationId: 'c1' },
    ]);
    expect(ensured).toEqual(['a1', 'a1', 'a1', 'a1']); // ensureAgent 每次幂等拉起
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
    await handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'c1' });
    await handlers.get('conversation/interrupt')!({ agentId: 'a1' });
    expect(calls).toEqual([
      { agentId: 'a1', frame: { ctrl: 'admin', agentId: 'a1', op: 'goal-get', conversationId: 'c1' } },
      { agentId: 'a1', frame: { ctrl: 'interrupt' } },
    ]);
    expect(ensured).toEqual([]); // 池外活壳不经拉起链（那链必被单例锁拒）
  });

  it('编排面缺席 fail-loud（bootHostWeb / orchestrate:false）', async () => {
    const { web, handlers } = collect();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => null });
    await expect(handlers.get('goal/get')!({ agentId: 'a1', conversationId: 'c1' })).rejects.toThrow(/编排面未就绪/);
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

  // cr-580：待答清单恢复链——活壳聚合 + filter 白名单窄化
  it('interaction/list：活壳聚合并附 filter（state 白名单）；坏壳跳过不殃及', async () => {
    const { web, handlers } = collect();
    const frames: Array<Record<string, unknown>> = [];
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      handles() {
        return new Map([
          ['a1', { control: async (f: Record<string, unknown>) => { frames.push(f); return { interactions: [{ id: 'i1', kind: 'ask_questions' }] }; } }],
          ['b1', { control: async () => { throw new Error('壳退出中'); } }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    const out = await handlers.get('interaction/list')!({ state: 'pending', nonsense: 1 }) as { interactions: unknown[] };
    expect(out.interactions).toEqual([{ id: 'i1', kind: 'ask_questions' }]);
    expect(frames).toEqual([{ ctrl: 'admin', agentId: 'a1', op: 'interaction-list', filter: { state: 'pending' } }]);
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
    const rootDir = 'preview/sandbox/test-sub-face-' + process.pid;
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
    const rootDir = 'preview/sandbox/test-sub-list-' + process.pid;
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
      { ctrl: 'interrupt' },
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
// cr-582 工具面：估算面经 ensureAgent 往返；目录 = 活壳并集 / 冷启动回落 __standard__
  it('agents/tool-defs：ensureAgent 往返 + conversationId 可选 + 回显 agentId', async () => {
    const { web, handlers } = collect();
    const { port, frames } = fakePort();
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    await expect(handlers.get('agents/tool-defs')!({ agentId: 'a1', conversationId: 'c1' })).resolves.toMatchObject({ agentId: 'a1', echo: 'tool-defs' });
    await expect(handlers.get('agents/tool-defs')!({ agentId: 'a1' })).resolves.toMatchObject({ agentId: 'a1', echo: 'tool-defs' });
    expect(frames).toEqual([
      { ctrl: 'admin', agentId: 'a1', op: 'tool-defs', conversationId: 'c1' },
      { ctrl: 'admin', agentId: 'a1', op: 'tool-defs' },
    ]);
    await expect(handlers.get('agents/tool-defs')!({})).rejects.toThrow(/agentId/);
  });

  it('tools/list：活壳并集去重排序；冷启动拉起 __standard__；编排面缺席空目录', async () => {
    const { web, handlers } = collect();
    const port: ShellAdminPort = {
      async ensureAgent(agentId) {
        return { control: async () => ({ tools: [{ name: 'std-tool', owner: agentId }] }) };
      },
      handles() {
        return new Map([
          ['a1', { control: async () => ({ tools: [{ name: 'read', owner: 'fs-tools' }, { name: 'grep', owner: 'fs-search' }] }) }],
          ['b1', { control: async () => ({ tools: [{ name: 'read', owner: 'fs-tools' }, { name: 'math', owner: 'math' }] }) }],
        ]);
      },
    };
    registerShellFace(web, ctx, { dataRoot: 'X', port: () => port });
    const out = await handlers.get('tools/list')!({}) as { tools: Array<{ name: string }> };
    expect(out.tools.map((t) => t.name)).toEqual(['grep', 'math', 'read']); // 并集去重 + 名序
    // 冷启动：handles 空 → 拉起 __standard__（缺省全集行集代表目录）
    const coldPort: ShellAdminPort = { async ensureAgent(agentId) { return { control: async () => ({ tools: [{ name: 'std-tool', owner: agentId }] }) }; } };
    const { web: web2, handlers: h2 } = collect();
    registerShellFace(web2, ctx, { dataRoot: 'X', port: () => coldPort });
    await expect(h2.get('tools/list')!({})).resolves.toEqual({ tools: [{ name: 'std-tool', owner: '__standard__' }] });
    // 编排面缺席 = 空目录（良定义降级，不抛）
    const { web: web3, handlers: h3 } = collect();
    registerShellFace(web3, ctx, { dataRoot: 'X', port: () => null });
    await expect(h3.get('tools/list')!({})).resolves.toEqual({ tools: [] });
  });
});

