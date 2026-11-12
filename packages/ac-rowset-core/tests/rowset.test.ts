// ============================================================
// ac-rowset-core 单测（M2.3 验收 / cr-1022 批3 收口）：宿主偏好派生 +
// 盘直读往返。菜单合成三护栏在 menu.test.ts 锁定；存量差量换算面已
// 迁 scripts/migrate-agent-patch.mjs（批3 读侧桥删除），由
// ac-agents-core/tests/migrate-agent-patch.test 样本回归承担。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveHostRowset, type RowsetCatalog, type RowDescriptor } from '../src/rowset.ts';
import { readCatalog, readHostPreferences, defaultCatalogFile, hostPreferenceFile } from '../src/disk.ts';

const row = (id: string, tree: 'host' | 'shell', extra: Partial<RowDescriptor> = {}): RowDescriptor => ({
  id, tree, ...extra,
});

const catalog: RowsetCatalog = {
  rows: [
    row('ac-post-office', 'host', { description: '邮局' }),
    row('ac-guardian', 'host'),
    row('ledger', 'shell'),
    row('tools', 'shell'),
    row('fs-base', 'shell'),
    row('fs-tools', 'shell', { requires: ['fs-base'] }),
    row('math', 'shell'),
    row('run-code', 'shell'),
    row('persona', 'shell'),
    row('auto-title', 'shell'),
  ],
};

describe('宿主行集派生 + 盘直读', () => {
  const ROOT = path.join('sandbox', 'test-rowset-' + process.pid);
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('偏好只记差异：未提及行默认装载，disabled 出局', () => {
    const r = deriveHostRowset([{ id: 'ac-guardian', disabled: true }], catalog);
    expect(r.rowIds).toEqual(['ac-post-office']);
    expect(r.warnings).toEqual([]);
  });

  it('偏好引用非宿主行 → 警告', () => {
    const r = deriveHostRowset([{ id: 'ac-math', disabled: true }], catalog);
    expect(r.warnings).toEqual(['偏好条目非宿主行：ac-math']);
  });

  it('目录/偏好盘往返', () => {
    expect(readCatalog(defaultCatalogFile(ROOT))).toEqual({ rows: [] });
    fs.writeFileSync(defaultCatalogFile(ROOT), JSON.stringify(catalog), 'utf-8');
    expect(readCatalog(defaultCatalogFile(ROOT)).rows).toHaveLength(10);
    fs.writeFileSync(hostPreferenceFile(ROOT), JSON.stringify([{ id: 'ac-post-office', disabled: true }]), 'utf-8');
    expect(readHostPreferences(ROOT)).toEqual([{ id: 'ac-post-office', disabled: true }]);
  });
});
