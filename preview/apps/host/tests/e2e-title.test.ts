// ============================================================
// e2e-title.test.ts —— 会话标题生成端到端（cr-672）：真宿主 boot（singles 行
// + HostInbox 收信面）+ 真子进程壳（mock provider 当 LLM）——user 发一句 →
// 壳内 auto-title 首步后生成 → 标题请求信 → 邮局 → 宿主 singles 行落盘。
// 断言只取盘上事实（viewer/sessions/<uuid>/session.json）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPathFor } from 'ac-envelope-core';
import { bootHost } from '../boot.ts';

const ROOT = path.join('preview', 'sandbox', 'test-title-e2e-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
const spawned: ChildProcess[] = [];

beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function seedConfig(agentId: string): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock' }), 'utf-8');
}

async function spawnShell(agentId: string): Promise<string> {
  const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
    '--data-root', path.resolve(ROOT), '--agent-id', agentId, '--catalog', CATALOG,
    '--mock-provider', '1', '--post-office', socketPathFor(path.resolve(ROOT), 'post-office')],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  spawned.push(child);
  const lines: string[] = [];
  child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
  const deadline = Date.now() + 20_000;
  while (!lines.some((l) => l.startsWith('boot.ready'))) {
    if (Date.now() > deadline) throw new Error('boot.ready 超时：' + lines.join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
  return lines.find((l) => l.startsWith('boot.ready'))!.split('\t')[2];
}

describe('会话标题生成端到端（cr-672）', () => {
  it('user 发一句 → 壳首步后生成标题 → 宿主 singles 行落盘', async () => {
    seedConfig('alpha');
    const host = await bootHost({ dataRoot: ROOT, catalogFile: CATALOG, orchestrate: false, port: 0 });
    try {
      const hint = await spawnShell('alpha');
      host.po.reach.markReachable('alpha', hint);
      const sent = await host.web.user.send('alpha', '第一问');
      const metaFile = path.join(ROOT, 'viewer', 'sessions', sent.uuid, 'session.json');
      const deadline = Date.now() + 20_000;
      let meta: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        try {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as Record<string, unknown>;
          if (typeof meta.title === 'string' && meta.title !== '') break;
        } catch { /* 尚未落盘 */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(meta).not.toBeNull();
      expect(meta!.id).toBe(sent.uuid);
      expect(meta!.agentId).toBe('alpha');
      // mock provider 回声的是提示词本身——标题含标题提示词片段即证明
      // LLM 生成面真跑过（派生面只会给出用户首句「第一问」），且已按上限截断
      expect(meta!.title).toContain('根据下面的对话材料');
      expect(meta!.title).not.toBe('第一问');
      expect((meta!.title as string).length).toBeLessThanOrEqual(24);
    } finally {
      await host.close();
    }
  }, 60_000);
});
