// ============================================================
// face-roster.test.ts —— session/roster RPC（cr-1185）
//
// 桩 web 面捕获 RPC 处理器 + 真 SessionIndex 服务（ctx.get 注入）+
// 真数据根文件：warm:true 填缺口 → 全量行（发言口径身份/时标 + 正文
// 截断 + 群成员流折叠）；索引行缺席 fail-loud。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeWebApiRow } from '../src/web-api.ts';
import { SessionIndex } from 'ac-session-index/src/core.ts';
import type { Context } from '@agentchat/cordis';

const tmpRoot = (tag: string): string => {
  const root = path.join('sandbox', 'test-roster-rpc-' + tag + '-' + process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  return root;
};

function writeSession(root: string, agent: string, cid: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(root, 'agents', agent, 'sessions', cid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

/** 捕获 RPC 处理器（makeWebApiRow.apply——webServer 桩只接 registerRpc） */
function captureRpcs(root: string, real: SessionIndex): Map<string, (p: unknown) => unknown> {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const plugin = makeWebApiRow({
    user: { send: async () => { throw new Error('不该触达'); } },
    dataRoot: root,
  });
  (plugin as { apply(ctx: Context): void }).apply({
    get: (key: string) => (key === 'sessionIndex' ? {
      refresh: (cid: string) => real.refreshConversation(root, cid),
      rosterGaps: () => real.rosterGaps(root),
      rosterSnapshot: () => real.rosterSnapshot(),
    } : undefined),
    webServer: { registerRpc: (m: string, h: (p: unknown) => unknown) => { handlers.set(m, h); }, route: () => {} },
  } as unknown as Context);
  return handlers;
}

describe('session/roster RPC（cr-1185）', () => {
  it('warm:true 填缺口 → warm 热度 + 全量行（身份/时标/正文 + 群折叠）；无 warm 拉子集', async () => {
    const root = tmpRoot('warm');
    writeSession(root, 'alpha', 'alpha~user', [
      { role: 'agent', agent_id: 'user', content: '在吗', message_id: 'm1', timestamp: '2026-11-10T01:00:00Z' },
      { role: 'agent', agent_id: 'alpha', content: '在的', message_id: 'm2', timestamp: '2026-11-10T01:00:05Z' },
    ]);
    // 群成员流（两个成员域各一流）
    writeSession(root, 'beta', 'g-g1x~beta', [
      { role: 'agent', agent_id: 'beta', content: 'B 说', message_id: 'b1', timestamp: '2026-11-10T02:00:00Z' },
    ]);
    writeSession(root, 'gamma', 'g-g1x~gamma', [
      { role: 'agent', agent_id: 'gamma', content: 'G 说', message_id: 'g1', timestamp: '2026-11-10T03:00:00Z' },
    ]);
    const real = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    try {
      const handlers = captureRpcs(root, real);
      // 预置一半索引（模拟既有惰性入账面）：只 alpha~user 被显式读面路过
      real.refreshConversation(root, 'alpha~user');
      const cold = await handlers.get('session/roster')!({}) as { rows: Array<Record<string, unknown>>; warm: string };
      expect(cold.warm).toBe('cold');
      expect(cold.rows).toHaveLength(1); // 已索引子集
      // warm:true 填缺口 → 全量 + 群折叠
      const out = await handlers.get('session/roster')!({ warm: true }) as { rows: Array<Record<string, unknown>>; warm: string };
      expect(out.warm).toBe('warm');
      expect(out.rows).toHaveLength(2); // alpha~user + g-g1x（成员流折叠）
      const pair = out.rows.find((r) => r.key === 'alpha~user')!;
      expect(pair.kind).toBe('pair');
      expect(pair.lastAgent).toBe('alpha');
      expect(pair.lastText).toBe('在的');
      expect(pair.lastSpeechAt).toBe('2026-11-10T01:00:05.000Z');
      const group = out.rows.find((r) => r.key === 'g-g1x')!;
      expect(group.kind).toBe('group');
      expect(group.lastAgent).toBe('gamma'); // 时标最大成员的末发言
      expect(group.lastText).toBe('G 说');
      expect(group.speech).toBe(2);
    } finally {
      real.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('索引行缺席 fail-loud（sessionIndex 服务不在 ctx）', async () => {
    const root = tmpRoot('absent');
    try {
      const handlers = new Map<string, (p: unknown) => unknown>();
      const plugin = makeWebApiRow({ user: { send: async () => { throw new Error('不该触达'); } }, dataRoot: root });
      (plugin as { apply(ctx: Context): void }).apply({
        get: () => undefined,
        webServer: { registerRpc: (m: string, h: (p: unknown) => unknown) => { handlers.set(m, h); }, route: () => {} },
      } as unknown as Context);
      expect(() => handlers.get('session/roster')!({})).toThrow(/sessionIndex/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
