// ============================================================
// restart-marker.test.ts —— cr-663 单一仲裁：restart-shell 复活标记
// 扫描（原子领取 / TTL / 活锁跳过 / 失败回滚）+ ensureAgent 在飞去重。
// 数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepRestartShellMarkers } from '../boot.ts';
import { createOrchestrator } from '../orchestrator.ts';
import { ReachabilityTable, PostOffice } from 'ac-post-office';

const ROOT = path.join('preview', 'sandbox', 'test-restart-marker-' + process.pid);
const MARKER_DIR = path.join(ROOT, '.runtime', 'restart-shell');

beforeEach(() => { fs.mkdirSync(MARKER_DIR, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const writeMarker = (agentId: string, at: string): void => {
  fs.writeFileSync(path.join(MARKER_DIR, agentId + '.json'), JSON.stringify({ agentId, at, conversationId: 'c-' + agentId }), 'utf-8');
};
const names = (): string[] => fs.readdirSync(MARKER_DIR).sort();
const T0 = Date.parse('2026-10-24T06:00:00Z');

describe('sweepRestartShellMarkers（cr-663）', () => {
  it('新鲜标记 + 无活锁：原子领取（rename .claimed）+ ensureAgent 恰一次', () => {
    writeMarker('a1', new Date(T0).toISOString());
    const pulled: string[] = [];
    sweepRestartShellMarkers({ dataRoot: ROOT, now: () => T0 + 1000, ensureAgent: (id) => { pulled.push(id); return Promise.resolve(); } });
    expect(pulled).toEqual(['a1']);
    expect(names()).toHaveLength(1);
    expect(names()).toEqual(['a1.claimed']); // 共享领文件名（兑现/自清归新壳）
  });

  it('重复扫描：领取态标记不二次拉起（他宿主已领 / 本宿主在拉）', () => {
    writeMarker('a1', new Date(T0).toISOString());
    let pulls = 0;
    const input = { dataRoot: ROOT, now: () => T0 + 1000, ensureAgent: (): Promise<void> => { pulls += 1; return Promise.resolve(); } };
    sweepRestartShellMarkers(input);
    sweepRestartShellMarkers(input);
    expect(pulls).toBe(1);
  });

  it('过期标记（>10min）丢弃不拉起', () => {
    writeMarker('a1', new Date(T0).toISOString());
    const pulled: string[] = [];
    const errs: string[] = [];
    sweepRestartShellMarkers({ dataRoot: ROOT, now: () => T0 + 11 * 60_000, ensureAgent: (id) => { pulled.push(id); return Promise.resolve(); }, onError: (m) => errs.push(m) });
    expect(pulled).toHaveLength(0);
    expect(names()).toHaveLength(0);
    expect(errs.join()).toContain('超时丢弃');
  });

  it('陈旧 .claimed（领取者死亡 >TTL）清扫；新鲜 .claimed 不动', () => {
    const stale = path.join(MARKER_DIR, 'a1.99999.claimed');
    const fresh = path.join(MARKER_DIR, 'a2.88888.claimed');
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(fresh, '{}');
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(stale, old, old);
    const pulled: string[] = [];
    sweepRestartShellMarkers({ dataRoot: ROOT, ensureAgent: (id) => { pulled.push(id); return Promise.resolve(); } });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(pulled).toHaveLength(0);
  });

  it('活锁在场：跳过（activation.lock = 重拉唯一事实）', () => {
    writeMarker('a1', new Date(T0).toISOString());
    const agentDir = path.join(ROOT, 'agents', 'a1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'activation.lock'), JSON.stringify({ pid: process.pid, bootId: 'b', transportHint: 'h' }), 'utf-8');
    const pulled: string[] = [];
    sweepRestartShellMarkers({ dataRoot: ROOT, now: () => T0 + 1000, ensureAgent: (id) => { pulled.push(id); return Promise.resolve(); } });
    expect(pulled).toHaveLength(0);
    expect(names()).toEqual(['a1.json']); // 标记留给壳 boot 自清
  });

  it('拉起失败：回滚原名（下次触发可重试）', async () => {
    writeMarker('a1', new Date(T0).toISOString());
    const errs: string[] = [];
    sweepRestartShellMarkers({ dataRoot: ROOT, now: () => T0 + 1000, ensureAgent: () => Promise.reject(new Error('boot fail')), onError: (m) => errs.push(m) });
    await new Promise((r) => setTimeout(r, 30));
    expect(names()).toEqual(['a1.json']);
    expect(errs.join()).toContain('重拉失败');
  });
});

describe('orchestrator ensureAgent 在飞去重（cr-663）', () => {
  it('并发两次 ensureAgent 共享同一次拉起（单 adopt）', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-orch-'));
    try {
      let adopts = 0;
      const po = new PostOffice({ dataRoot: tmpRoot });
      await po.listen();
      try {
        const orch = createOrchestrator({
          dataRoot: tmpRoot, catalogFile: 'C', bootFile: 'B', postOffice: po,
          adopt: async (input) => {
            adopts += 1;
            await new Promise((r) => setTimeout(r, 40));
            return {
              bootId: 'b1', transportHint: 'h', pid: 1, events: [],
              shutdown: async () => 0, kill: () => {},
              onLine: () => {}, onExit: () => {}, control: async () => null,
            };
          },
        });
        try {
          const [h1, h2] = await Promise.all([orch.ensureAgent('a1'), orch.ensureAgent('a1')]);
          expect(adopts).toBe(1);
          expect(h1).toBe(h2);
        } finally { orch.close(); }
      } finally { await po.close(); }
    } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }, 20_000);
});
