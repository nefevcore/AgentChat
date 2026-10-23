// ============================================================
// face-runs.test.ts —— 宿主聚合面（cr-574）：session/tokens +
// runs/snapshot（digest 短路 + 活壳 run-state 合并）
//
// 数据源 = 临时数据根真文件（user 投影账本 + agent 域 journal 计量）；
// 编排面 = 假端口（run-state 帧形与活跃集投影）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { registerOpsFace } from '../src/face-ops.ts';
import type { ShellAdminPort } from '../src/face-shell.ts';

type Handler = (params: unknown) => unknown;

function collect(): { web: { registerRpc(m: string, h: Handler): void }; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return { web: { registerRpc: (m, h) => { handlers.set(m, h); } }, handlers };
}

/** ctx.get 全 undefined（config/usage 可选服务缺席 = 良定义降级） */
const ctx = { get: () => undefined } as unknown as Context;

function fakePort(states: Record<string, unknown>): ShellAdminPort {
  return {
    async ensureAgent() { throw new Error('不该拉起壳'); },
    handles() {
      return new Map(Object.entries(states).map(([agentId, st]) => [
        agentId,
        { control: async (frame: Record<string, unknown>) => {
          if (frame.op !== 'run-state') throw new Error('意外帧：' + String(frame.op));
          return st;
        } },
      ]));
    },
  };
}

function tmpRoot(tag: string): string {
  const root = path.join('preview', 'sandbox', 'test-runs-face-' + tag + '-' + process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  return root;
}

function writeSession(root: string, agent: string, cid: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(root, 'users', 'user', 'sessions', cid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  // agent 域账本在场（conversationDirs 判据）——journal 计量挂在同目录
  const agentDir = path.join(root, 'agents', agent, 'sessions', cid);
  fs.mkdirSync(path.join(agentDir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'messages.jsonl'), '', 'utf-8');
}

function writeJournal(root: string, agent: string, cid: string, lines: Array<Record<string, unknown>>): void {
  const file = path.join(root, 'agents', agent, 'sessions', cid, 'journal', 'partials.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

describe('session/tokens（宿主聚合）', () => {
  it('回放估算 + journal 计量 cache 面 + 预算分母（缺省 1M / settings.archive 覆盖）', async () => {
    const root = tmpRoot('tokens');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: '你好', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
      { role: 'agent', agent_id: 'a1', content: '在的', message_id: 'm2', timestamp: '2026-10-22T01:00:01Z' },
    ]);
    writeJournal(root, 'a1', 'c1', [
      { type: 'journal-settled', run: 'r1', finish: 'ok', usage: { prompt: 100, completion: 10, promptAccumulated: 300, steps: 2, cacheHit: 50, cacheMiss: 20 } },
      { type: 'journal-settled', run: 'r2', finish: 'ok', usage: { prompt: 200, completion: 5, promptAccumulated: 400, steps: 1, cacheHit: 70, cacheMiss: 30 } },
    ]);
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const out = await handlers.get('session/tokens')!({ conversationId: 'c1' }) as Record<string, unknown>;
      expect(out.messageCount).toBe(2);
      // estimateTokens：'你好' = 1.2 → 2；'在的' = 1.2 → 2
      expect(out.contextTokens).toBe(4);
      expect(out.maxContextTokens).toBe(1_000_000);
      expect(out.status).toBe('normal');
      expect(out.agentId).toBe('a1');
      expect(out.cache).toEqual({ lastHit: 70, lastMiss: 30, hit: 120, miss: 50, lastRunPrompt: 200 });

      // agent 差异层覆盖预算分母
      fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
      fs.writeFileSync(path.join(root, 'agents', 'a1', 'config.json'), JSON.stringify({ id: 'a1', settings: { archive: { maxContextTokens: 500 } } }), 'utf-8');
      const out2 = await handlers.get('session/tokens')!({ conversationId: 'c1' }) as Record<string, unknown>;
      expect(out2.maxContextTokens).toBe(500);
      expect(out2.usagePercent).toBe(0.8);
      expect(out2.status).toBe('normal');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('无账本会话 = 全零载荷（不抛）', async () => {
    const root = tmpRoot('tokens-empty');
    fs.mkdirSync(root, { recursive: true });
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const out = await handlers.get('session/tokens')!({ conversationId: 'ghost' }) as Record<string, unknown>;
      expect(out).toMatchObject({ conversationId: 'ghost', messageCount: 0, contextTokens: 0, maxContextTokens: 1_000_000, status: 'normal' });
      expect(out.cache).toEqual({ lastHit: 0, lastMiss: 0, hit: 0, miss: 0, lastRunPrompt: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runs/snapshot（宿主聚合 + digest 短路）', () => {
  it('会话扫描（messageCount/size/last）+ 活壳 run-state 合并 + digest 短路', async () => {
    const root = tmpRoot('snap');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: '问题', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
      { role: 'agent', agent_id: 'a1', content: '长回答'.repeat(50), message_id: 'm2', timestamp: '2026-10-22T01:00:01Z' },
    ]);
    writeSession(root, 'a2', 'c2', [
      { role: 'agent', agent_id: 'user', content: 'hi', message_id: 'm3', timestamp: '2026-10-22T02:00:00Z' },
    ]);
    try {
      const { web, handlers } = collect();
      const port = fakePort({
        a1: { busy: true, conversationId: 'c1', runId: 'r1', startedAt: 42, queuedTurns: 1 },
        a2: { busy: false, conversationId: null, runId: null, startedAt: null, queuedTurns: 0 },
      });
      registerOpsFace(web, ctx, { dataRoot: root, shellPort: () => port });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect(typeof snap.digest).toBe('string');
      expect(snap.groups).toEqual([]);
      expect(snap.running).toEqual([{ agentId: 'a1', conversationId: 'c1', runId: 'r1', handle: 'c1~a1', startedAt: 42 }]);
      const convs = snap.conversations as Array<Record<string, unknown>>;
      expect(convs).toHaveLength(2);
      const c1 = convs.find((c) => c.conversationId === 'c1')!;
      expect(c1.messageCount).toBe(2);
      expect(c1.size).toBeGreaterThan(0);
      expect(c1.last).toMatchObject({ role: 'assistant', agent_id: 'a1' });
      expect((c1.last as { text: string }).text).toHaveLength(120); // 尾部摘要截断
      const c2 = convs.find((c) => c.conversationId === 'c2')!;
      expect(c2.last).toMatchObject({ role: 'user', text: 'hi' });
      expect((c2.last as { agent_id?: string }).agent_id).toBeUndefined();

      // 同 digest 二轮 → unchanged 轻载荷
      const again = await handlers.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(again).toMatchObject({ unchanged: true, digest: snap.digest });

      // 账本变化 → digest 变、重新展开
      fs.appendFileSync(path.join(root, 'users', 'user', 'sessions', 'c2', 'messages.jsonl'),
        JSON.stringify({ role: 'agent', agent_id: 'a2', content: 'x', message_id: 'm4', timestamp: '2026-10-22T03:00:00Z' }) + '\n', 'utf-8');
      const third = await handlers.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(third.unchanged).toBeUndefined();
      expect((third.conversations as Array<Record<string, unknown>>).find((c) => c.conversationId === 'c2')!.messageCount).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('群面（cr-579）：groups/<gid>/group.json 扫描 → 主线同形载荷 + 入指纹（成员变更 digest 变）', async () => {
    const root = tmpRoot('snap-groups');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: 'q', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    const gdir = path.join(root, 'groups', 'g1');
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'group.json'), JSON.stringify({ id: 'g1', name: '群一', members: ['a1', 'a2'], createdAt: 1 }), 'utf-8');
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect(snap.groups).toEqual([{ groupId: 'g1', name: '群一', memberCount: 2, members: ['a1', 'a2'] }]);
      const again = await handlers.get('runs/snapshot')!({ digest: snap.digest as string }) as Record<string, unknown>;
      expect(again.unchanged).toBe(true);
      // 成员表变更（join）→ 指纹元素变化 → digest 变
      fs.writeFileSync(path.join(gdir, 'group.json'), JSON.stringify({ id: 'g1', name: '群一', members: ['a1', 'a2', 'a3'], createdAt: 1 }), 'utf-8');
      const third = await handlers.get('runs/snapshot')!({ digest: snap.digest as string }) as Record<string, unknown>;
      expect(third.unchanged).toBeUndefined();
      expect((third.groups as Array<{ memberCount: number }>)[0].memberCount).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('编排面缺席 = 空活跃集（会话扫描照常）', async () => {
    const root = tmpRoot('snap-noport');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: 'q', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect(snap.running).toEqual([]);
      expect(snap.conversations).toHaveLength(1);
      expect(snap.usageTotals).toBeUndefined(); // usage 行缺席 = 不垫假数
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
