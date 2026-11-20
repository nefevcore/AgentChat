// ============================================================
// ac-source-core 单测（cr-1165）：快照 diff 物化（seq 单调/滚动/
// readRowsSince 跨代）+ fs-source 行（扫描物化 → source/updated 事件、
// config 热重载 roots、无 roots 零定时器）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { TimerService } from '@agentchat/cordis-timer';
import { ConfigService } from 'ac-config';
import { materializeSnapshot, readMeta, readRowsSince, FsSourceService, type SourceUpdatedPayload } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-source-core-' + process.pid);
const WATCH = path.join(ROOT, 'watch');
beforeEach(() => { fs.mkdirSync(WATCH, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('快照物化纯函数', () => {
  const DIR = () => path.join(ROOT, 'exports', 'fs', 'v1');

  it('首扫全量追加；无变化零追加但刷新 generatedAt；变更行按 seq 单调续', () => {
    fs.writeFileSync(path.join(WATCH, 'a.md'), 'hello', 'utf-8');
    const r1 = materializeSnapshot(DIR(), [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
    expect(r1).toEqual({ appended: 1, seq: 1 });
    // 无变化
    const r2 = materializeSnapshot(DIR(), [{ path: 'a.md', mtime: 1, size: 5 }], 60_000);
    expect(r2).toEqual({ appended: 0, seq: 1 });
    // 新文件 + 变更文件
    const r3 = materializeSnapshot(DIR(), [
      { path: 'a.md', mtime: 2, size: 11 },
      { path: 'b/c.txt', mtime: 3, size: 2 },
    ], 60_000);
    expect(r3).toEqual({ appended: 2, seq: 3 });
    const rows = readRowsSince(DIR(), 0);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(readRowsSince(DIR(), 1).map((r) => r.seq)).toEqual([2, 3]);
    const meta = readMeta(DIR())!;
    expect(meta.seq).toBe(3);
    expect(meta.staleAfterMs).toBe(60_000);
    expect(meta.generatedAt).toBeTruthy();
    // 零变化也刷新 generatedAt（活性心跳）
    const before = meta.generatedAt;
    materializeSnapshot(DIR(), [
      { path: 'a.md', mtime: 2, size: 11 },
      { path: 'b/c.txt', mtime: 3, size: 2 },
    ], 60_000);
    expect(readMeta(DIR())!.generatedAt >= before).toBe(true);
  });

  it('meta 缺席/损坏 = null（消费方按源不可用处理）', () => {
    expect(readMeta(path.join(ROOT, 'exports', 'fs', 'none'))).toBeNull();
    fs.mkdirSync(path.join(ROOT, 'exports', 'fs', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'exports', 'fs', 'bad', 'meta.json'), '{oops', 'utf-8');
    expect(readMeta(path.join(ROOT, 'exports', 'fs', 'bad'))).toBeNull();
    expect(readRowsSince(path.join(ROOT, 'exports', 'fs', 'bad'), 0)).toEqual([]);
  });
});

describe('fs-source 行', () => {
  async function boot() {
    const events: SourceUpdatedPayload[] = [];
    const ctx = new Context();
    const f1 = ctx.plugin(TimerService);
    const f2 = ctx.plugin(class extends ConfigService {
      constructor(c: Context) { super(c, { root: ROOT }); }
    });
    const f3 = ctx.plugin(class extends FsSourceService {
      constructor(c: Context) { super(c, { dataRoot: ROOT, cadenceMs: 300 }); }
    });
    ctx.on('source/updated', (p) => events.push(p));
    await Promise.all([f1, f2, f3]);
    return {
      events, ctx,
      async dispose() { for (const f of [f3, f2, f1].reverse()) await f.dispose(); },
    };
  }

  it('扫描 roots → 物化 + source/updated；变化才发事件；glob 过滤', async () => {
    fs.writeFileSync(path.join(WATCH, 'one.md'), 'x', 'utf-8');
    fs.writeFileSync(path.join(WATCH, 'skip.txt'), 'y', 'utf-8');
    const h = await boot();
    try {
      (h.ctx.get('config') as { set(k: string, v: unknown): void }).set('source.fs', {
        roots: [{ id: 'docs', root: WATCH, glob: '*.md' }],
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(h.events.filter((e) => e.source === 'fs' && e.view === 'docs')).toHaveLength(1);
      const rows = readRowsSince(path.join(ROOT, 'exports', 'fs', 'docs'), 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ path: 'one.md' });
      // 无变化轮 = 零事件
      await new Promise((r) => setTimeout(r, 700));
      expect(h.events.filter((e) => e.view === 'docs')).toHaveLength(1);
      // 新文件 → 再发
      fs.writeFileSync(path.join(WATCH, 'two.md'), 'z', 'utf-8');
      await new Promise((r) => setTimeout(r, 900));
      expect(h.events.filter((e) => e.view === 'docs')).toHaveLength(2);
      expect(h.events.at(-1)).toMatchObject({ source: 'fs', view: 'docs' });
    } finally {
      await h.dispose();
    }
  }, 15_000);

  it('无 roots = 空行（零事件零扫描）', async () => {
    const h = await boot();
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(h.events).toEqual([]);
      expect(fs.existsSync(path.join(ROOT, 'exports'))).toBe(false);
    } finally {
      await h.dispose();
    }
  }, 10_000);
});
