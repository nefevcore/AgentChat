// ============================================================
// boot 控制帧面单测（M8.3）：mock 壳 control 直调——interrupt（无 run 时
// false）/ bench（scripted 全链真跑 + TSV 信号）；persist 语义归 e2e。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootShell } from '../boot.ts';

const ROOT = path.join('preview', 'sandbox', 'test-ctrl-' + process.pid);
const CATALOG = path.join('preview', 'apps', 'catalog', 'row-catalog.json');
beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents', 'kilo'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', 'kilo', 'config.json'),
    JSON.stringify({ id: 'kilo', model: 'mock', tools: { include: ['bench'] } }), 'utf-8');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('M8.3 boot 控制帧面', () => {
  it('interrupt：无活跃 run 返回 {interrupted:false}', async () => {
    fs.writeFileSync(path.join(ROOT, 'agents', 'kilo', 'config.json'),
      JSON.stringify({ id: 'kilo', model: 'mock', tools: { include: ['conversation'] } }), 'utf-8');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
      { emit: (s) => signals.push(s) },
    );
    try {
      expect(await boot.control({ ctrl: 'interrupt' })).toEqual({ interrupted: false });
    } finally { await boot.close(); }
  });

  it('bench：控制帧全链（scripted mock → loop → 对拍）+ bench.report TSV', async () => {
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
      { emit: (s, ...f) => signals.push([s, ...f].join('\t')) },
    );
    try {
      const report = await boot.control({
        ctrl: 'bench', suite: 'bfcl',
        options: { model: 'bench-mock-model', provider: 'bench-mock', scripted: true, limit: 2 },
      }) as { total: number; passed: number };
      expect(report.total).toBeGreaterThan(0);
      expect(report.passed).toBe(report.total);
      const line = signals.find((s) => s.startsWith('bench.report'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.split('\t').slice(1).join('\t')).passed).toBe(report.passed);
    } finally { await boot.close(); }
  }, 30_000);

  it('preview：system-prompt 干跑（config.system 直过）+ assembly-tools 目录', async () => {
    fs.writeFileSync(path.join(ROOT, 'agents', 'kilo', 'config.json'),
      JSON.stringify({ id: 'kilo', model: 'mock', system: '我是 kilo', tools: { include: ['math'] } }), 'utf-8');
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
      { emit: (s) => signals.push(s) },
    );
    try {
      const sys = await boot.control({ ctrl: 'preview', what: 'system-prompt' }) as { systemPrompt: string };
      expect(sys.systemPrompt).toContain('我是 kilo');
      const asm = await boot.control({ ctrl: 'preview', what: 'assembly-tools' }) as { tools: Array<{ name: string }>; enabled: string[] };
      expect(asm.enabled).toEqual(['math']);
      expect(asm.tools.length).toBeGreaterThan(0);
    } finally { await boot.close(); }
  }, 30_000);

  it('bench 缺行集：fail-loud（bench 服务缺席）', async () => {
    fs.writeFileSync(path.join(ROOT, 'agents', 'kilo', 'config.json'),
      JSON.stringify({ id: 'kilo', model: 'mock', tools: { exclude: ['bench'] } }), 'utf-8');
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'kilo', catalogFile: CATALOG, mockProvider: true },
      { emit: () => {} },
    );
    try {
      await expect(boot.control({ ctrl: 'bench', suite: 'bfcl', options: { model: 'x', provider: 'y', scripted: true, limit: 1 } }))
        .rejects.toThrow(/bench 服务缺席/);
    } finally { await boot.close(); }
  }, 30_000);
});
