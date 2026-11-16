// ============================================================
// usage 自报链 e2e（cr-538）：真子进程壳 mock run 收束 → 事件信经
// 邮局 ipc → 宿主 usage 行聚并入账（byAgent + 审计流水）。
// 数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPathFor, waitForShellReady } from 'ac-envelope-core';
import { PostOffice } from 'ac-post-office';
import { UserStub } from '../user-stub.ts';
import { Context } from '@agentchat/cordis';
import { makeUsageHostRow, HostInbox } from 'ac-host-rows';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-usage-e2e-' + process.pid);
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
  child.stdout.on('data', () => {}); // cr-1129 批4：排水防反压（stdout 信号退役）
  const lock = await waitForShellReady(path.join(ROOT, 'agents', agentId), 25_000);
  return { hint: lock.transportHint };
}

describe('usage 自报链 e2e（壳 run 收束 → 事件信 → 宿主聚合并）', () => {
  it('mock run 收束后宿主 byAgent 入账 + journal 计量在场', async () => {
    // v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    writeAgentConfig(ROOT, { id: 'alpha', model: 'mock' });
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
      expect(fs.readdirSync(path.join(ROOT, 'usage')).filter((f) => f.endsWith('.jsonl')).length).toBe(1);
      // 壳侧计量对拍（cr-974 v2：run-end 行携带 usage/model——R2 计量半边；
      // journal 停写，事件日志即台账）
      const uuids = fs.readdirSync(path.join(ROOT, 'agents', 'alpha', 'sessions'));
      const rows = fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', uuids[0], 'messages.jsonl'), 'utf-8')
        .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      const settled = rows.find((l) => l.type === 'run-end') as { model?: string; usage?: { steps?: number } };
      expect(settled.model).toBe('mock');
      expect(settled.usage!.steps).toBeGreaterThanOrEqual(1);
    } finally {
      await fiber.dispose();
      user.stop();
      await po.close();
    }
  });
});