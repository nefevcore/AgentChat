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
import { writeAgentConfig } from 'ac-agents-core';
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
  const root = path.join('sandbox', 'test-runs-face-' + tag + '-' + process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  return root;
}

function writeSession(root: string, agent: string, cid: string, rows: Array<Record<string, unknown>>): void {
  // cr-998：消息流单源 agent 域（viewer 投影域退役）
  const dir = path.join(root, 'agents', agent, 'sessions', cid);
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
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
      // 回放口径（cr-714）：'你好' = 1.2 → 2；'在的' = 1.2 → 2（agent 域
      // 终稿行与 viewer 投影行同源直估，无轨迹时两口径等值）
      expect(out.contextTokens).toBe(4);
      expect(out.maxContextTokens).toBe(1_000_000);
      expect(out.status).toBe('normal');
      expect(out.agentId).toBe('a1');
      expect(out.cache).toEqual({ lastHit: 70, lastMiss: 30, hit: 120, miss: 50, lastRunPrompt: 200 });

      // agent 差异层覆盖预算分母（cr-1036 批3：v3 写口——settings 拆 archive 单元）
      fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
      writeAgentConfig(root, { id: 'a1', settings: { archive: { maxContextTokens: 500 } } });
      const out2 = await handlers.get('session/tokens')!({ conversationId: 'c1' }) as Record<string, unknown>;
      expect(out2.maxContextTokens).toBe(500);
      expect(out2.usagePercent).toBe(0.8);
      expect(out2.status).toBe('normal');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('轨迹展开计入（cr-714）：物化段行 steps 轨迹按注入形状估算——工具型会话不再低估', async () => {
    const root = tmpRoot('tokens-traj');
    writeSession(root, 'a1', 't1', [
      { role: 'agent', agent_id: 'user', content: '查', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    // agent 域：物化段行（steps 轨迹——工具调用/结果大头）+ 终稿行
    const agentDir = path.join(root, 'agents', 'a1', 'sessions', 't1');
    fs.writeFileSync(path.join(agentDir, 'messages.jsonl'), [
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '查', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z', requestId: 'q1' }),
      JSON.stringify({
        role: 'agent', agent_id: 'a1', content: '', message_id: 'seg-r1-0', run: 'r1', source: 'segment',
        timestamp: '2026-10-22T01:00:02Z',
        steps: [{ content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}', result: { ok: true, output: '文件内容' } }] }],
      }),
      JSON.stringify({ role: 'agent', agent_id: 'a1', content: '结果', message_id: 'm2', run: 'r1', source: 'run:r1', timestamp: '2026-10-22T01:00:03Z' }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const out = await handlers.get('session/tokens')!({ conversationId: 't1' }) as Record<string, unknown>;
      // viewer 终稿（'查' + '结果'）+ agent 自著段行轨迹（工具名+参数+结果
      // JSON）都计入——旧口径（终稿层直估）只有 viewer 行
      expect((out.contextTokens as number) > 6).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cr-1191：压缩会话回落路径不计 shadowed 旧代 + V3 digest 行单源不双计（sessionIndex 缺席 = replayTokensOf 盘读）', async () => {
    const root = tmpRoot('tokens-archived');
    // 现场形态（01a1fd60）：旧代 user 行 + 旧代技能注入行 + digest 行 + compaction 事件
    const digestText = '# 会话总结（归档整理版）';
    writeSession(root, 'a1', 'c9', [
      { role: 'agent', agent_id: 'user', content: '旧代消息（很长——足以让旧代读数显著大于新代）' + 'x'.repeat(4000), message_id: 'm1', timestamp: '2026-11-21T12:00:00Z', seq: 10 },
      { role: 'context', source: 'skill', content: '<skill_content name="old">\n' + 'y'.repeat(4000) + '\n</skill_content>', agent_id: 'a1', timestamp: '2026-11-21T12:00:01Z', seq: 11 },
      { role: 'context', source: 'archive-summary', content: digestText, agent_id: 'a1', label: '归档总结', timestamp: '2026-11-21T13:01:24Z', seq: 12 },
      { type: 'compaction', run: 'r-arch', boundarySeq: 11, ts: Date.parse('2026-11-21T13:01:25Z') },
      { role: 'agent', agent_id: 'user', content: '新代消息', message_id: 'm2', timestamp: '2026-11-21T13:02:00Z', seq: 13 },
    ]);
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const out = await handlers.get('session/tokens')!({ conversationId: 'c9' }) as Record<string, unknown>;
      const tokens = out.contextTokens as number;
      // 旧代两行（~8000 字符 ≈ 2400+ est）被 shadow 不计；新代 = digest(短) + 新消息
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(500); // 旧代若漏滤将 >2400
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

describe('session/kv-timeline（cr-714 去 stub）', () => {
  it('usage 服务在场 → conversationTimeline 透传（points 键）', async () => {
    const root = tmpRoot('kv');
    try {
      const { web, handlers } = collect();
      const timeline = [{ ts: 1, hit: 90, miss: 10 }, { ts: 2, hit: 80, miss: 20 }];
      const ctxUsage = { get: (k: string) => (k === 'usage' ? { conversationTimeline: (id: string) => (id === 'c1' ? timeline : []) } : undefined) } as unknown as Context;
      registerOpsFace(web, ctxUsage, { dataRoot: root });
      const out = await handlers.get('session/kv-timeline')!({ conversationId: 'c1' }) as Record<string, unknown>;
      expect(out).toEqual({ conversationId: 'c1', points: timeline });
      // 会话键未入账 = 空序列（前端空态）
      const out2 = await handlers.get('session/kv-timeline')!({ conversationId: 'ghost' }) as Record<string, unknown>;
      expect(out2).toEqual({ conversationId: 'ghost', points: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('usage 行缺席 = 空序列（不抛、不垫假数）', async () => {
    const root = tmpRoot('kv-nousage');
    fs.mkdirSync(root, { recursive: true });
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root });
      const out = await handlers.get('session/kv-timeline')!({ conversationId: 'c1' }) as Record<string, unknown>;
      expect(out).toEqual({ conversationId: 'c1', points: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runs/snapshot（宿主聚合 + digest 短路）', () => {
  it('会话扫描（messageCount/size——SQL 单源）+ 活壳 run-state 合并 + digest 短路', async () => {
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
      // cr-1185 批3：无索引行（collect ctx 无 sessionIndex）= messageCount 0
      // 诚实值（SQL 单源——尾部摘要 last 已随名册脱离退役）
      expect(c1.messageCount).toBe(0);
      expect(c1.size).toBeGreaterThan(0);
      expect(c1.last).toBeUndefined();
      const c2 = convs.find((c) => c.conversationId === 'c2')!;
      expect(c2.messageCount).toBe(0);

      // 同 digest 二轮 → unchanged 轻载荷
      const again = await handlers.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(again).toMatchObject({ unchanged: true, digest: snap.digest });

      // 账本变化 → digest 变、重新展开
      fs.appendFileSync(path.join(root, 'agents', 'a2', 'sessions', 'c2', 'messages.jsonl'),
        JSON.stringify({ role: 'agent', agent_id: 'a2', content: 'x', message_id: 'm4', timestamp: '2026-10-22T03:00:00Z' }) + '\n', 'utf-8');
      const third = await handlers.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(third.unchanged).toBeUndefined();
      expect((third.conversations as Array<Record<string, unknown>>).find((c) => c.conversationId === 'c2')!.messageCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('观测失败（cr-802）：全部壳探测失败 → unchanged 轻载荷（running 不清空）；恢复后正常步进', async () => {
    const root = tmpRoot('snap-observe-fail');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: 'q', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    // 可切换观测态的 port：fail=true 时全部 run-state 帧抛错（模拟 manage 探针
    // 超时 / 慢帧挤兑——「偶发光环消失」的宿主侧源）
    let fail = false;
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      liveShellIds: () => ['a1'],
      async control(_agentId, frame) {
        if (fail && (frame as { op?: string }).op === 'run-state') throw new Error('manage 回执超时');
        return { runs: [{ conversationId: 'c1', runId: 'r1', startedAt: 42, queuedTurns: 0 }] };
      },
    };
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root, shellPort: () => port });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect((snap.running as unknown[]).length).toBe(1);
      // 观测失败拍：unchanged 轻载荷——running 投影不清空（光环不闪）
      fail = true;
      const degraded = await handlers.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(degraded.unchanged).toBe(true);
      // 观测恢复：正常投影（run 真收束后 digest 步进、running 清空）
      fail = false;
      const settled: ShellAdminPort = {
        async ensureAgent() { throw new Error('不该拉起壳'); },
        liveShellIds: () => ['a1'],
        async control() { return { runs: [] }; },
      };
      const { web: w2, handlers: h2 } = collect();
      registerOpsFace(w2, ctx, { dataRoot: root, shellPort: () => settled });
      const third = await h2.get('runs/snapshot')!({ digest: snap.digest }) as Record<string, unknown>;
      expect(third.unchanged).toBeUndefined();
      expect(third.running).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // cr-824 批二：poller 镜像优先——在场时读镜像（零现探），缺席退回现探。
  it('runningOf（cr-824 批二）：pollerSnapshot 在场 → 读镜像不走 run-state 帧；缺席 → 现探退路', async () => {
    const root = tmpRoot('snap-poller');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: 'q', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    // 现探 port 若被走到即抛（证明镜像优先、零现探）
    const port: ShellAdminPort = {
      async ensureAgent() { throw new Error('不该拉起壳'); },
      liveShellIds: () => ['a1'],
      async control() { throw new Error('镜像在场不得现探'); },
    };
    const mirror = new Map([
      ['a1', { bootId: 'b1', busy: true, runs: [{ conversationId: 'c1', runId: 'r1', startedAt: 42 }], recentSettled: [] }],
    ]);
    try {
      const { web, handlers } = collect();
      registerOpsFace(web, ctx, { dataRoot: root, shellPort: () => port, pollerSnapshot: () => mirror });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect(snap.running).toEqual([{ agentId: 'a1', conversationId: 'c1', runId: 'r1', handle: 'c1~a1', startedAt: 42 }]);
      // 镜像端口返回 null（orchestrate:false 形态）→ 退回现探（port 仍可答）
      const probe: ShellAdminPort = {
        async ensureAgent() { throw new Error('不该拉起壳'); },
        liveShellIds: () => ['a1'],
        async control() { return { runs: [{ conversationId: 'c1', runId: 'r2', startedAt: 7 }] }; },
      };
      const { web: w2, handlers: h2 } = collect();
      registerOpsFace(w2, ctx, { dataRoot: root, shellPort: () => probe, pollerSnapshot: () => null });
      const snap2 = await h2.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect(snap2.running).toEqual([{ agentId: 'a1', conversationId: 'c1', runId: 'r2', handle: 'c1~a1', startedAt: 7 }]);
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

  it('多 run 壳（cr-746 per-门）：run-state runs 数组逐条入活跃集；旧单 run 形状兼容', async () => {
    const root = tmpRoot('snap-multirun');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: 'q1', message_id: 'm1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    writeSession(root, 'a1', 'c2', [
      { role: 'agent', agent_id: 'user', content: 'q2', message_id: 'm2', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    try {
      const { web, handlers } = collect();
      const port = fakePort({
        // 新形状：一壳两会话并行 run
        a1: {
          busy: true, conversationId: 'c1', runId: 'r1', startedAt: 10, queuedTurns: 0,
          runs: [
            { conversationId: 'c1', runId: 'r1', startedAt: 10, queuedTurns: 0 },
            { conversationId: 'c2', runId: 'r2', startedAt: 20, queuedTurns: 1 },
          ],
        },
        // 旧形状：单 run 顶层字段（升级壳共存期）
        a2: { busy: true, conversationId: 'c3', runId: 'r3', startedAt: 30, queuedTurns: 0 },
      });
      registerOpsFace(web, ctx, { dataRoot: root, shellPort: () => port });
      const snap = await handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      expect((snap.running as Array<Record<string, unknown>>).sort((x, y) => String(x.startedAt) < String(y.startedAt) ? -1 : 1)).toEqual([
        { agentId: 'a1', conversationId: 'c1', runId: 'r1', handle: 'c1~a1', startedAt: 10 },
        { agentId: 'a1', conversationId: 'c2', runId: 'r2', handle: 'c2~a1', startedAt: 20 },
        { agentId: 'a2', conversationId: 'c3', runId: 'r3', handle: 'c3~a2', startedAt: 30 },
      ]);
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

describe('runs/snapshot 展开单源（cr-1185 批3：SQL roster 小表）', () => {
  it('索引未入账：messageCount 0 诚实值 + last 退役，且高频面不隐式建索引', async () => {
    const root = tmpRoot('roster-auth-cold');
    // 账本形态：发言行之后还有 v2 事件行（run-end 晚于终稿——真实数据常态）
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: '问', message_id: 'm1', timestamp: '2026-11-16T00:00:00Z' },
      { role: 'agent', agent_id: 'a1', content: '答', message_id: 'm2', run: 'r1', timestamp: '2026-11-16T00:00:01Z' },
      { type: 'run-end', run: 'r1', finish: 'completed', ts: 1794800000000 },
    ]);
    // 假 sessionIndex：走真 SessionIndex（SQLite 真账面——不 mock SQL 语义）。
    const { SessionIndex } = await import('ac-session-index/src/core.ts');
    const real = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    const idxCtx = { get: (key: string) => (key === 'sessionIndex' ? {
      // 忠实代理：refreshStats 只入 stat 面（不建 records 行）——把它写成
      // refreshConversation 会让「高频面不隐式建索引」的断言失去意义。
      refreshStats: (cid: string) => real.refreshStats(root, cid),
      catalog: () => real.catalog(),
      drop: (cid: string) => real.drop(cid),
      rosterSnapshot: () => real.rosterSnapshot(),
    } : undefined) } as unknown as Context;
    try {
      const withIdx = collect();
      registerOpsFace(withIdx.web, idxCtx, { dataRoot: root });
      const snap = await withIdx.handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      const c1 = (snap.conversations as Array<Record<string, unknown>>).find((c) => c.conversationId === 'c1')!;
      // 未入账（records 无行 → roster 小表无行）= 0 诚实值；尾部摘要 last 退役
      expect(c1.messageCount).toBe(0);
      expect(c1.last).toBeUndefined();
      // 硬约束：高频聚合面绝不可触发索引建立（cr-1138：全量预热是显式动作）。
      // 探针 = 只读 sessionMeta 仍返回 null（records 表无行）；files 表 stat 面
      // 由 refreshStats 正常入账，不作建索引证据。
      expect(real.sessionMeta(root, 'c1', { refresh: false })).toBeNull();
    } finally {
      real.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('索引已入账：messageCount = roster 小表 speech 口径（发言行数）', async () => {
    const root = tmpRoot('roster-auth-warm');
    // 账本形态：发言行之后还有 v2 事件行（run-end 晚于终稿——真实数据常态）
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: '问', message_id: 'm1', timestamp: '2026-11-16T00:00:00Z' },
      { role: 'agent', agent_id: 'a1', content: '答', message_id: 'm2', run: 'r1', timestamp: '2026-11-16T00:00:01Z' },
      { type: 'run-end', run: 'r1', finish: 'completed', ts: 1794800000000 },
    ]);
    // 用户末发言形态：入站行账本原形 = role:'agent' + agent_id:'user'（归一在投影层）
    writeSession(root, 'a2', 'c2', [
      { role: 'agent', agent_id: 'a2', content: '早', message_id: 'n1', timestamp: '2026-11-16T01:00:00Z' },
      { role: 'agent', agent_id: 'user', content: '收到', message_id: 'n2', timestamp: '2026-11-16T01:00:05Z' },
    ]);
    const { SessionIndex } = await import('ac-session-index/src/core.ts');
    const real = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    const idxCtx = { get: (key: string) => (key === 'sessionIndex' ? {
      refreshStats: (cid: string) => real.refreshStats(root, cid),
      catalog: () => real.catalog(),
      drop: (cid: string) => real.drop(cid),
      rosterSnapshot: () => real.rosterSnapshot(),
    } : undefined) } as unknown as Context;
    try {
      // 显式读面建索引（模拟 session/meta RPC / historyView 访问——预热归它们）
      real.refreshConversation(root, 'c1');
      real.refreshConversation(root, 'c2');
      expect(real.catalog().length).toBe(2);

      const warm = collect();
      registerOpsFace(warm.web, idxCtx, { dataRoot: root });
      const snap = await warm.handlers.get('runs/snapshot')!({}) as Record<string, unknown>;
      const c1 = (snap.conversations as Array<Record<string, unknown>>).find((c) => c.conversationId === 'c1')!;
      // SQL 发言行数口径：c1 = 2 发言行（run-end 事件行不计——旧 replay 口径同值）
      expect(c1.messageCount).toBe(2);
      expect(c1.last).toBeUndefined(); // 尾部摘要退役（名册单源 session/roster）
      const c2 = (snap.conversations as Array<Record<string, unknown>>).find((c) => c.conversationId === 'c2')!;
      expect(c2.messageCount).toBe(2);
    } finally {
      real.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runs/snapshot single-flight（cr-980 #1）', () => {
  it('并发调用共享同一趟（慢活跃集探测只发生一次），digest 各自对账', async () => {
    const root = tmpRoot('flight');
    writeSession(root, 'a1', 'c1', [
      { role: 'agent', agent_id: 'user', content: '问', message_id: 'm1', timestamp: '2026-11-10T00:00:00Z' },
    ]);
    try {
      const { web, handlers } = collect();
      let probes = 0;
      const port: ShellAdminPort = {
        async ensureAgent() { throw new Error('不该拉起壳'); },
        handles() {
          return new Map([['a1', {
            control: async (frame: Record<string, unknown>) => {
              probes += 1;
              await new Promise((r) => setTimeout(r, 30)); // 慢探测——拉开并发窗口
              return { busy: false };
            },
          }]]);
        },
      };
      registerOpsFace(web, ctx, { dataRoot: root, shellPort: () => port });
      await new Promise((r) => setTimeout(r, 80)); // 预热航班落定
      const before = probes;
      const [a, b] = await Promise.all([
        handlers.get('runs/snapshot')!({}),
        handlers.get('runs/snapshot')!({}),
      ]) as Array<Record<string, unknown>>;
      expect(probes - before).toBe(1); // 共享一趟：run-state 只探一次
      expect(a.digest).toBe(b.digest);
      expect(a.conversations).toEqual(b.conversations);
      // 共享航班结果对各自 digest 对账：同 digest → unchanged 轻载荷
      const c = await handlers.get('runs/snapshot')!({ digest: a.digest }) as Record<string, unknown>;
      expect(c).toMatchObject({ unchanged: true, digest: a.digest });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
