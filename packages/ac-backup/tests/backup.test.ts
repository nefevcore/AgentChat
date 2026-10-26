// ============================================================
// ac-backup：run（force/间隔）+ list + owning 落盘布局
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as backupRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-backup-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string, options: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fiber = ctx.plugin(backupRow as any, { root, intervalMs: 60_000_000, ...options });
  await fiber;
  const fibers: Fiber[] = [fiber];
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).backup) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-backup', () => {
  it('run：打包数据根到 <root>/backups；list 可查', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'sessions', 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', 'a', 'messages.jsonl'), '数据\n', 'utf-8');
    const { ctx } = await boot(root);
    const result = await ctx.backup.run();
    expect(result.skipped).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'backups', result.file))).toBe(true);
    expect(ctx.backup.list()).toHaveLength(1);
  });

  it('间隔检查：到期才执行（定时直调语义），force 跳过', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'x.txt'), 'x', 'utf-8');
    const { ctx } = await boot(root);
    await ctx.backup.run({ force: true });
    // 改名模拟更早的备份（时间戳秒级会同名碰撞）
    const first = ctx.backup.list()[0];
    fs.renameSync(
      path.join(root, 'backups', first.file),
      path.join(root, 'backups', 'backup-2020-01-01T00-00-00.zip'),
    );
    const second = await ctx.backup.run(); // 距上次不足间隔
    expect(second.skipped).toBe(true);
    const third = await ctx.backup.run({ force: true });
    expect(third.skipped).toBeUndefined();
    expect(ctx.backup.list()).toHaveLength(2);
  });

  it('卸载回收：dispose 后 ctx.backup 回滚', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    const fiber = fibers[0];
    await fiber.dispose();
    expect((ctx as any).backup).toBeUndefined();
  });
});
