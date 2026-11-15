// cr-1104 回放声明注册表单测（registerToolMode 范式对齐）
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { makeLedgerRow } from '../src/service.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-replay-reg-'));

interface RegFace {
  registerReplayPolicy(d: { source: string; replay: string }): unknown;
  listReplayPolicies(): Array<{ source: string; replay: string }>;
  replayKindOf(w?: string): string;
}

describe('registerReplayPolicy（cr-1104）', () => {
  it('注册/查值/撞名 fail-loud/机制词拒绝/非法档拒绝', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'reg-a' }));
    await fiber;
    try {
      const svc = ctx.ledger as unknown as RegFace;
      const off = svc.registerReplayPolicy({ source: 'ac-demo:notice', replay: 'original' });
      expect(svc.replayKindOf('ac-demo:notice')).toBe('original');
      expect(svc.replayKindOf('unregistered')).toBe('wrapper'); // 缺省
      expect(svc.replayKindOf(undefined)).toBe('wrapper');
      expect(svc.listReplayPolicies()).toEqual([{ source: 'ac-demo:notice', replay: 'original' }]);
      expect(() => svc.registerReplayPolicy({ source: 'ac-demo:notice', replay: 'wrapper' })).toThrow(/已注册/);
      expect(() => svc.registerReplayPolicy({ source: 'event', replay: 'original' })).toThrow(/机制词/);
      expect(() => svc.registerReplayPolicy({ source: '', replay: 'wrapper' })).toThrow();
      expect(() => svc.registerReplayPolicy({ source: 'x', replay: 'bogus' })).toThrow();
      // fiber 回收（行卸载 = 声明退场 → 缺省回落）
      (off as () => void)();
      expect(svc.replayKindOf('ac-demo:notice')).toBe('wrapper');
    } finally {
      await (fiber as Fiber).dispose();
    }
  });
});
