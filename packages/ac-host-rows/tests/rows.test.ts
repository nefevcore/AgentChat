// ============================================================
// ac-host-rows 装配测试（8.8 第一批，cr-537）
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { IMPORTED_ROWS, rowOptionsFor } from '../src/index.ts';
import { readCatalog, deriveHostRowset } from 'ac-rowset-core';

const CATALOG = path.resolve(__dirname, '../../../apps/catalog/row-catalog.json');

describe('ac-host-rows 第一批导入面', () => {
  it('IMPORTED_ROWS 含九行（首批七 + cr-543 plugin-market + cr-565 conv-settings）', () => {
    expect(Object.keys(IMPORTED_ROWS).sort()).toEqual([
      'backup', 'config', 'conv-settings', 'event-policy', 'logger-console', 'plugin-market', 'remote-link', 'timer',
      'ws-bridge',
    ]);
  });

  it('目录内第一批行全有 path（指纹单源）', () => {
    const cat = readCatalog(CATALOG);
    const firstBatch = ['logger-console', 'timer', 'config', 'event-policy', 'remote-link', 'backup', 'ws-bridge', 'post-office', 'guardian'];
    for (const id of firstBatch) {
      const row = cat.rows.find((r) => r.id === id);
      expect(row, id + ' 应在目录').toBeDefined();
      expect(row?.path, id + ' 应有 path').toBeDefined();
    }
  });

  it('rowOptionsFor 数据根锚定（config/backup/conv-settings）', () => {
    const opts = rowOptionsFor({ dataRoot: 'X:\\root' });
    expect((opts.config as { root: string }).root).toBe('X:\\root');
    expect((opts.backup as { root: string }).root).toBe('X:\\root');
    expect((opts['conv-settings'] as { root: string }).root).toBe('X:\\root');
  });
});
