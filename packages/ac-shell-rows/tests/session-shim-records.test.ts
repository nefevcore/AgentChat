// ============================================================
// ac-shell-rows/tests/session-shim-records.test.ts —— cr-1102/1103
//   SessionShim.records：转发 ledger.recordsFor 统一行读面（主线
//   SessionService.records 的壳侧等价——此前缺席致 ac-memory 锚检测
//   TypeError / ac-skill 跨 run 去重恒空 fail-open）；ledger 未装 = 空。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { SessionShim } from '../src/shims.ts';

const fibers: Fiber[] = [];
afterEach(async () => {
  for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
  fibers.length = 0;
});

class StubLedger extends Service {
  constructor(ctx: Context, private rows: Array<Record<string, unknown>>) { super(ctx, 'ledger'); }
  recordsFor(_uuid: string) { return this.rows; }
}

describe('SessionShim.records（ledger 读面转发）', () => {
  it('转发 ledger.recordsFor；ledger 行未装 = 空清单', async () => {
    const ctx = new Context();
    const shim = ctx.plugin(SessionShim);
    fibers.push(shim);
    await shim;
    const session = ctx.get('session') as unknown as { records(id: string): Promise<Array<{ role: string; source?: string; content: string }>> };
    expect(await session.records('alice~alpha')).toEqual([]); // ledger 未装：fail-open
    const row = { role: 'context', source: 'skill', agent_id: 'alpha', content: '<skill_content name="demo">x</skill_content>' };
    const ledger = ctx.plugin(class extends StubLedger { constructor(c: Context) { super(c, [row]); } });
    fibers.push(ledger);
    await ledger;
    expect(await session.records('alice~alpha')).toEqual([row]);
  });
});
