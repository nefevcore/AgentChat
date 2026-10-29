// ============================================================
// admin-frame.test.ts —— 壳内管理面控制帧（cr-569）
// ============================================================
import { describe, it, expect } from 'vitest';
import type { Context } from '@agentchat/cordis';
import { handleAdminFrame, type AdminFrame } from '../admin-frame.ts';

/** 假 ctx：get(key) 返回注入的服务面 */
function fakeCtx(services: Record<string, unknown>): Context {
  return { get: (key: string) => services[key] } as unknown as Context;
}

describe('admin 控制帧路由（goal / todo）', () => {
  it('goal-get/update/delete 走 goals 服务，桶键 = conversationId ?? agentId', () => {
    const calls: string[] = [];
    const ctx = fakeCtx({
      goals: {
        snapshot: (agentId: string, key: string) => { calls.push('snapshot:' + agentId + ':' + key); return { id: 'g1' }; },
        update: (agentId: string, key: string, patch: Record<string, unknown>) => { calls.push('update:' + key + ':' + JSON.stringify(patch)); return { id: 'g1' }; },
        remove: (agentId: string, key: string) => { calls.push('remove:' + key); return { id: 'g1' }; },
      },
    });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'goal-get', agentId: 'a1', conversationId: 'c1' }))
      .toEqual({ goal: { id: 'g1' } });
    // 补丁字段名映射：blocked_reason → blockedReason、max_rounds → maxRounds；未给字段不出现
    expect(handleAdminFrame(ctx, {
      ctrl: 'admin', op: 'goal-update', agentId: 'a1', conversationId: 'c1',
      patch: { status: 'active', blocked_reason: 'r', max_rounds: 3, jUnk: 1 },
    })).toEqual({ goal: { id: 'g1' } });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'goal-delete', agentId: 'a1' }))
      .toEqual({ goal: { id: 'g1' }, deleted: true });
    expect(calls).toEqual([
      'snapshot:a1:c1',
      'update:c1:{"status":"active","blockedReason":"r","maxRounds":3}',
      'remove:a1', // 无 conversationId → 桶键回落 agentId
    ]);
  });

  it('todo-get 走 todos 服务（同桶键语义）', () => {
    const ctx = fakeCtx({ todos: { list: (agentId: string, key: string) => [{ id: 't1', key }] } });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'todo-get', agentId: 'a1', conversationId: 'c1' }))
      .toEqual({ todos: [{ id: 't1', key: 'c1' }] });
  });

  it('interaction / jobs / archive：路由到壳内 owning 服务（帧只带 id/answer）', () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      durableInteraction: { reply: (id: string, answer: unknown) => { seen.push('reply:' + id + ':' + JSON.stringify(answer)); return { status: 'ok' }; } },
      jobs: {
        list: () => [{ id: 'j1', status: 'running' }],
        kill: (id: string) => { seen.push('kill:' + id); return { outcome: 'cancellation-requested' }; },
      },
      archive: { requestArchive: async (uuid: string) => { seen.push('archive:' + uuid); } },
    });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'interaction-reply', agentId: 'a1', id: 'i1', answer: { answers: ['A'] } }))
      .toEqual({ status: 'ok' });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'jobs-list', agentId: 'a1' }))
      .toEqual({ jobs: [{ id: 'j1', status: 'running' }] });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'jobs-kill', agentId: 'a1', id: 'j1' }))
      .toEqual({ outcome: 'cancellation-requested' });
    expect(seen).toEqual(['reply:i1:{"answers":["A"]}', 'kill:j1']);
  });

  it('subagents-stop 走 subagents.stopOp（实体保留可续聊）', async () => {
    const ctx = fakeCtx({ subagents: { stopOp: async (childId: string) => ({ stopped: childId === 'kid1' }) } });
    await expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'subagents-stop', agentId: 'a1', id: 'kid1' }))
      .resolves.toEqual({ stopped: true });
    await expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'subagents-stop', agentId: 'a1', id: 'kid2' }))
      .resolves.toEqual({ stopped: false });
  });

  it('subagents-list 走 subagents.listOp（busy/exited 进程内态出口，cr-725）', () => {
    const ctx = fakeCtx({ subagents: { listOp: () => [{ childId: 'kid1', status: 'ready', pid: 1, busy: true }] } });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'subagents-list', agentId: 'a1' }))
      .toEqual({ agents: [{ childId: 'kid1', status: 'ready', pid: 1, busy: true }] });
  });

  it('session-archive 返回受理回执（整理 run 后台进行）', async () => {
    const ctx = fakeCtx({ archive: { requestArchive: async () => ({}) } });
    await expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'session-archive', agentId: 'a1', conversationId: 'c1' }))
      .resolves.toEqual({ triggered: true, conversationId: 'c1' });
    expect(() => handleAdminFrame(ctx, { ctrl: 'admin', op: 'session-archive', agentId: 'a1' })).toThrow(/conversationId/);
  });

  it('queue 三 op 走 conversation 队列面（帧带 conversationId / id）', async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      conversation: {
        queue: (conversationId?: string) => { seen.push('queue:' + conversationId); return [{ id: 'r1', preview: '甲', sender: 'user', queuedAt: 1 }]; },
        removeQueued: (id: string) => { seen.push('remove:' + id); return true; },
        steerQueued: async (id: string) => { seen.push('steer:' + id); return id === 'r1' ? 'steered' : 'requeued'; },
      },
    });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'queue-list', agentId: 'a1', conversationId: 'c1' }))
      .toEqual({ items: [{ id: 'r1', preview: '甲', sender: 'user', queuedAt: 1 }] });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'queue-remove', agentId: 'a1', conversationId: 'c1', id: 'r1' }))
      .toEqual({ removed: true });
    await expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'queue-steer', agentId: 'a1', conversationId: 'c1', id: 'r1' }))
      .resolves.toEqual({ outcome: 'steered' });
    expect(() => handleAdminFrame(ctx, { ctrl: 'admin', op: 'queue-remove', agentId: 'a1', id: '' })).toThrow(/缺 id/);
    expect(seen).toEqual(['queue:c1', 'remove:r1', 'steer:r1']);
  });

  it('run-state 走 conversation.runState（runs/snapshot 活跃集数据源）', () => {
    const ctx = fakeCtx({ conversation: { runState: () => ({ busy: true, conversationId: 'c1', runId: 'r1', startedAt: 5, queuedTurns: 1 }) } });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'run-state', agentId: 'a1' }))
      .toEqual({ busy: true, conversationId: 'c1', runId: 'r1', startedAt: 5, queuedTurns: 1 });
    expect(() => handleAdminFrame(fakeCtx({}), { ctrl: 'admin', op: 'run-state', agentId: 'a1' })).toThrow(/conversation 服务缺席/);
  });

  it('行缺席 fail-loud（不静默空态）', () => {
    const ctx = fakeCtx({});
    expect(() => handleAdminFrame(ctx, { ctrl: 'admin', op: 'goal-get', agentId: 'a1' })).toThrow(/goals 服务缺席/);
    expect(() => handleAdminFrame(ctx, { ctrl: 'admin', op: 'todo-get', agentId: 'a1' })).toThrow(/todos 服务缺席/);
  });

  // cr-582 工具面：估算面（agents/tool-defs）与目录（tools/list）路由到 conversation 服务
  it('tool-defs / tools-catalog：路由到壳内 conversation 服务', () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      conversation: {
        toolDefs: (conversationId?: string) => { seen.push('tool-defs:' + (conversationId ?? '')); return { names: ['read'], defs: [] }; },
        toolsCatalog: () => { seen.push('tools-catalog'); return [{ name: 'read', owner: 'fs-tools' }]; },
      },
    });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'tool-defs', agentId: 'a1', conversationId: 'c1' }))
      .toEqual({ names: ['read'], defs: [] });
    expect(handleAdminFrame(ctx, { ctrl: 'admin', op: 'tools-catalog', agentId: 'a1' }))
      .toEqual({ tools: [{ name: 'read', owner: 'fs-tools' }] });
    expect(seen).toEqual(['tool-defs:c1', 'tools-catalog']);
  });
});

