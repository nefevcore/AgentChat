// ============================================================
// cr1335-steer-sender-gate.test.ts —— cr-1335 误打标修复：
// loop/inject-consumed 的 steer 注入打标加 sender 门——机制信（restart
// 唤醒 / job 完成回投等）busy 时同样走 steer 通道（message.role 恒
// 'user'），sender 才是唯一可靠判据：仅 sender='user'（或缺席——旧 emit
// 保守放行）打 delivered:true；机制信（sender=对端/系统端点）不打标。
// 现场回放：cr-1334 验证会话里 [系统通知] 后台任务 ×2 以 injectSource:
// steer + delivered:true 落盘、IM 视图混入机制通知。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-cr1335-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff2100';

async function bootLedger(root: string, agentId: string): Promise<{ ctx: import('@agentchat/cordis').Context; stop(): Promise<void> }> {
  const { Context } = await import('@agentchat/cordis');
  const { makeLedgerRow } = await import('../src/service.ts');
  const ctx = new Context();
  const fiber = ctx.plugin(makeLedgerRow({ dataRoot: root, agentId }));
  await fiber;
  return { ctx, async stop() { await fiber.dispose(); } };
}

async function rowsOf(root: string, agent: string, conv: string): Promise<Array<Record<string, unknown>>> {
  const { readLedger } = await import('../src/reader.ts');
  return readLedger(sessionDir(root, agent, conv)).rows as unknown as Array<Record<string, unknown>>;
}

describe('cr-1335：steer 注入打标 sender 门', () => {
  it('机制信走 steer 通道（sender=对端）不打 delivered——restart 通知/job 回投现场形态', async () => {
    const h = await bootLedger(ROOT, 'g1');
    try {
      // 复现 run-restarted 通知经 driveRun steer 分支的 emit 形态：
      // meta.injectSource='steer'（缺省词），条目顶层 sender=对端（非 'user'）
      h.ctx.emit('loop/inject-consumed', 'g1', uuid, 'run-restarted-x1', [{
        message: { role: 'user', content: '[系统通知] 后台任务 pwsh-1 完成' },
        meta: { injectSource: 'steer', requestId: 'local-mech-1' },
        sender: 'g1',
      }] as never);
      await new Promise((r) => setTimeout(r, 30)); // 落账异步面（void 链）
      const rows = await rowsOf(ROOT, 'g1', uuid);
      const inj = rows.find((r) => String(r.content).includes('后台任务'));
      expect(inj).toBeDefined();
      expect(inj!.delivered).toBeUndefined(); // 机制信不打标——IM 白名单不收
    } finally { await h.stop(); }
  });

  it('用户 busy 插话（sender=user）照常打 delivered:true；旧 emit 无 sender 保守放行', async () => {
    const h = await bootLedger(ROOT, 'g2');
    try {
      h.ctx.emit('loop/inject-consumed', 'g2', uuid, 'run-1', [{
        message: { role: 'user', content: '中途插话正文' },
        meta: { injectSource: 'steer', requestId: 'steer-1' },
        sender: 'user',
      }] as never);
      h.ctx.emit('loop/inject-consumed', 'g2', uuid, 'run-1', [{
        message: { role: 'user', content: '旧形态无 sender' },
        meta: { injectSource: 'steer' },
      }] as never);
      await new Promise((r) => setTimeout(r, 30));
      const rows = await rowsOf(ROOT, 'g2', uuid);
      expect(rows.find((r) => r.content === '中途插话正文')!.delivered).toBe(true);
      expect(rows.find((r) => r.content === '旧形态无 sender')!.delivered).toBe(true);
    } finally { await h.stop(); }
  });
});