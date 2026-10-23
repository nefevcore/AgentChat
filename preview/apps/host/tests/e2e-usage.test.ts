// ============================================================
// usage 自报链 e2e（cr-538）：真子进程壳 mock run 收束 → 事件信经
// 邮局 ipc → 宿主 usage 行聚并入账（byAgent + 审计流水）。
// 数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPathFor } from 'ac-envelope-core';
import { PostOffice } from 'ac-post-office';
import { UserStub } from '../user-stub.ts';
import { Context } from '@agentchat/cordis';
import { makeUsageHostRow, HostInbox } from 'ac-host-rows';

const ROOT = path.join('preview', 'sandbox', 'test-usage-e2e-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function spawnShell(agentId: string): Promise<{ hint: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
    '--data-root', path.resolve(ROOT), '--agent-id', agentId, '--catalog', CATALOG,
    '--mock-provider', '1', '--post-office', socketPathFor(path.resolve(ROOT), 'post-office')],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  spawned.push(child);
  const lines: string[] = [];
  child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
  const deadline = Date.now() + 15_000;
  while (!lines.some((l) => l.startsWith('boot.ready'))) {
    if (Date.now() > deadline) throw new Error('boot.ready 超时：' + lines.join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
  return { hint: lines.find((l) => l.startsWith('boot.ready'))!.split('\t')[2] };
}

describe('usage 自报链 e2e（壳 run 收束 → 事件信 → 宿主聚合并）', () => {
  it('mock run 收束后宿主 byAgent 入账 + journal 计量在场', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'),
      JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    const po = new PostOffice({ dataRoot: ROOT });
    await po.listen();
    const ctx = new Context();
    const inbox = new HostInbox(po);
    inbox.start();
    const fiber = ctx.plugin(makeUsageHostRow({ root: ROOT, inbox }));
    await fiber;
    const user = new UserStub(po, ROOT);
    user.start();
    const { hint } = await spawnShell('alpha');
    po.reach.markReachable('alpha', hint);
    try {
      await user.send('alpha', '计一下');
      // 等事件信到达 + 入账（at-least-once 异步）
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (Object.keys(ctx.usage.byAgent()).includes('alpha')) break;
        if (Date.now() > deadline) throw new Error('usage 未入账：' + JSON.stringify(ctx.usage.byAgent()));
        await new Promise((r) => setTimeout(r, 100));
      }
      const agg = ctx.usage.byAgent();
      expect(agg.alpha.runs).toBe(1);
      // 审计流水（主线聚合并单源——webui 查询面恒等）
      expect(ctx.usage.auditFiles().length).toBe(1);
      // 壳侧 journal 计量对拍（journal-settled 携带 usage/model——R2 journal 计量半边）
      const uuids = fs.readdirSync(path.join(ROOT, 'agents', 'alpha', 'sessions'));
      const jfile = path.join(ROOT, 'agents', 'alpha', 'sessions', uuids[0], 'journal', 'partials.jsonl');
      const jraw = fs.readFileSync(jfile, 'utf-8');
      const settled = jraw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)).find((l) => l.type === 'journal-settled');
      expect(settled.model).toBe('mock');
      expect(settled.usage.steps).toBeGreaterThanOrEqual(1);
    } finally {
      await fiber.dispose();
      user.stop();
      await po.close();
    }
  });
});