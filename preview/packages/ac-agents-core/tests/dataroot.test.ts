// ============================================================
// 数据根骨架布局单测（M2.5 验收）：fixture 工厂建全形态 →
// 四纯库（agents/auth/rowset/credentials）各自直读互证——布局即契约。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDataRoot } from '../src/fixture.ts';
import { readAgentConfig, listAgentIds } from '../src/tree.ts';
import { readGlobalAuth, readAgentAuth } from 'ac-auth-core';
import { readCatalog, readHostPreferences, deriveShellRowset, deriveHostRowset } from 'ac-rowset-core';
import { listCredentialNames, readCredential } from 'ac-credentials-core';

const ROOT = path.join('preview', 'sandbox', 'test-dataroot-' + process.pid);
beforeEach(() => fs.mkdirSync(path.dirname(ROOT), { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const catalog = {
  rows: [
    { id: 'ac-post-office', tree: 'host' },
    { id: 'ac-guardian', tree: 'host' },
    { id: 'ac-conversation', tree: 'shell' },
    { id: 'ac-ledger', tree: 'shell' },
    { id: 'ac-fs-tools', tree: 'shell', tools: ['fs_read', 'fs_write'], bundle: 'fs' },
    { id: 'ac-fs-search', tree: 'shell', tools: ['fs_glob'], bundle: 'fs' },
  ],
};

it('骨架全形态 → 四纯库直读互证', () => {
  buildDataRoot(ROOT, {
    agents: [
      { id: 'alpha', model: 'gpt-x', rows: ['fs_read'] },
      { id: 'beta', model: 'gpt-y' },
    ],
    globalAuth: {
      version: 1,
      entries: [{
        id: 'e1',
        asset: { kind: 'row-load', rowId: 'ac-fs-tools' },
        grantedAt: 'T', grantSource: 'user-webui',
      }],
    },
    agentAuths: {
      alpha: { version: 1, agentId: 'alpha', grants: [{ mcp: 'adt' }], denials: [] },
    },
    rowCatalog: catalog,
    hostPreferences: [{ id: 'ac-guardian', disabled: true }],
    mcp: { servers: { adt: { command: 'node' } } },
    credentials: { 'github-token': 'ghp_plain' },
  });

  // agents 树
  expect(listAgentIds(ROOT)).toEqual(['alpha', 'beta']);
  expect(readAgentConfig(ROOT, 'alpha')).toMatchObject({ id: 'alpha', model: 'gpt-x' });
  // auth 两层
  expect(readGlobalAuth(ROOT).entries).toHaveLength(1);
  expect(readAgentAuth(ROOT, 'alpha')?.grants).toEqual([{ mcp: 'adt' }]);
  expect(readAgentAuth(ROOT, 'beta')).toBeNull();
  // rowset
  const cat = readCatalog(path.join(ROOT, 'row-catalog.json'));
  expect(cat.rows).toHaveLength(6);
  expect(deriveHostRowset(readHostPreferences(ROOT), cat).rowIds).toEqual(['ac-post-office']);
  const shell = deriveShellRowset({ rows: ['fs_read'] }, cat);
  expect(shell.rowIds).toEqual(['ac-fs-tools']);
  // credentials
  expect(listCredentialNames(ROOT)).toEqual(['github-token']);
  expect(readCredential(ROOT, Buffer.alloc(32), 'github-token')).toBe('ghp_plain'); // 明文兼容形态
});

it('空骨架 = 最小数据根（agents/ 与 credentials/ 缺席合法）', () => {
  buildDataRoot(ROOT, {});
  expect(listAgentIds(ROOT)).toEqual([]);
  expect(readGlobalAuth(ROOT).entries).toEqual([]);
  expect(listCredentialNames(ROOT)).toEqual([]);
});
