// ============================================================
// data-root-audit.test.ts —— 数据根分层契约 boot doctor（数据分层 cr）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { auditDataRootLayers } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-data-root-audit-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('auditDataRootLayers（契约面）', () => {
  it('契约内全部顶层项不告警（分类表快照锁）', () => {
    for (const d of ['agents', 'meta', 'credentials', 'viewer', 'usage', 'files', 'file-snapshots',
      'sap-adt', 'outbox', 'profile', '.runtime', 'plugins', 'skills',
      // 兼容窗旧位置（迁 meta/ 前的寄居名）
      'groups', 'timer', 'remote', 'conv-settings']) {
      fs.mkdirSync(path.join(ROOT, d), { recursive: true });
    }
    for (const f of ['config.json', 'workspaces.json', 'host-rows.json']) {
      fs.writeFileSync(path.join(ROOT, f), '{}', 'utf-8');
    }
    const warned: string[] = [];
    expect(auditDataRootLayers(ROOT, (m) => warned.push(m))).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('未知目录/文件 → 逐项 warn 并返回清单', () => {
    fs.mkdirSync(path.join(ROOT, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'mystery-dir'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'stray.txt'), 'x', 'utf-8');
    const warned: string[] = [];
    const unknown = auditDataRootLayers(ROOT, (m) => warned.push(m));
    expect(unknown.sort()).toEqual(['mystery-dir', 'stray.txt']);
    expect(unknown).toContain('mystery-dir');
    expect(unknown).toContain('stray.txt');
    expect(warned.every((m) => m.includes('分层契约'))).toBe(true);
  });

  it('数据根缺席 = 空清单不抛', () => {
    expect(auditDataRootLayers(path.join(ROOT, 'no-such'))).toEqual([]);
  });
});
