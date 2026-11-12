// ============================================================
// 数据根骨架布局单测（M2.5 验收 / cr-1022 批2：writeAgentConfig 写
// agent.patch.yml v3 菜单片段）：fixture 工厂建全形态 → 四纯库
//（agents/auth/rowset/credentials）各自直读互证——布局即契约。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { buildDataRoot } from '../src/fixture.ts';
import { readAgentConfig, writeAgentConfig, listAgentIds } from '../src/tree.ts';
import { readGlobalAuth, readAgentAuth } from 'ac-auth-core';
import { readCatalog, readHostPreferences, deriveHostRowset } from 'ac-rowset-core';
import { rowsToMenuDefs } from '../src/patch-doc.ts';
import { listCredentialNames, readCredential } from 'ac-credentials-core';

const ROOT = path.join('sandbox', 'test-dataroot-' + process.pid);
beforeEach(() => fs.mkdirSync(path.dirname(ROOT), { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const catalog = {
  rows: [
    { id: 'ac-post-office', tree: 'host' },
    { id: 'ac-guardian', tree: 'host' },
    { id: 'ac-conversation', tree: 'shell', zone: 'skeleton' },
    { id: 'ac-ledger', tree: 'shell', zone: 'skeleton' },
    { id: 'ac-fs-tools', tree: 'shell' },
    { id: 'ac-fs-search', tree: 'shell' },
  ],
};

it('骨架全形态 → 四纯库直读互证', () => {
  buildDataRoot(ROOT, {
    agents: [
      { id: 'alpha', model: 'gpt-x', rows: ['ac-fs-tools'] },
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
  expect(readAgentConfig(ROOT, 'alpha')).toMatchObject({
    id: 'alpha', model: 'gpt-x',
    rows: { include: ['ac-conversation', 'ac-ledger', 'ac-fs-tools'] }, // v3：骨架 ∪ 定义清单
  });
  // auth 两层
  expect(readGlobalAuth(ROOT).entries).toHaveLength(1);
  expect(readAgentAuth(ROOT, 'alpha')?.grants).toEqual([{ mcp: 'adt' }]);
  expect(readAgentAuth(ROOT, 'beta')).toBeNull();
  // rowset
  const cat = readCatalog(path.join(ROOT, 'row-catalog.json'));
  expect(cat.rows).toHaveLength(6);
  expect(deriveHostRowset(readHostPreferences(ROOT), cat).rowIds).toEqual(['ac-post-office']);
  const shellRows = cat.rows.filter((r) => r.tree === 'shell');
  const capability = shellRows
    .filter((r) => r.zone !== 'skeleton')
    .map((r) => ({ id: r.id, ...(r.path !== undefined ? { name: 'link:' + r.path } : {}) }));
  const { defs } = rowsToMenuDefs(['ac-fs-tools'], capability);
  expect(defs.map((d) => d.id)).toEqual(['ac-fs-tools']); // 行 id 单一词形
  // credentials
  expect(listCredentialNames(ROOT)).toEqual(['github-token']);
  expect(readCredential(ROOT, Buffer.alloc(32), 'github-token')).toBe('ghp_plain'); // 明文兼容形态
});

it('agent.patch.yml v3 菜单片段（cr-1022 批2）：顶层数组 + ac-menu 头 + src-fingerprint + 留一代备份', () => {
  buildDataRoot(ROOT, { agents: [{ id: 'alpha', model: 'gpt-x', rows: ['ac-fs-tools'] }], rowCatalog: catalog });
  const patchFile = path.join(ROOT, 'agents', 'alpha', 'agent.patch.yml');
  const text = fs.readFileSync(patchFile, 'utf-8');
  expect(text).toContain('# ac-menu: 1');
  const data = yaml.load(text) as unknown;
  expect(Array.isArray(data)).toBe(true); // 顶层数组 = 行定义
  const defs = data as Array<Record<string, unknown>>;
  expect(defs.map((e) => e.id)).toEqual(['ac-fs-tools']);
  expect(Object.keys(defs[0]!).sort()).toEqual(['id', 'src-fingerprint']); // 定义拷贝（fixture 行无 name/requires）
  expect(typeof defs[0]!['src-fingerprint']).toBe('string');
  // cr-1025 重写原子纪律：重写前留一代备份
  expect(fs.existsSync(patchFile + '.bak')).toBe(false); // 首写无备份源
  writeAgentConfig(ROOT, { id: 'alpha', model: 'gpt-x', rows: ['ac-fs-tools'] });
  expect(fs.existsSync(patchFile + '.bak')).toBe(true);
  // 读侧剥离 src-fingerprint：v3 组合读不含溯源元数据
  expect(readAgentConfig(ROOT, 'alpha')).toMatchObject({ rows: { include: ['ac-conversation', 'ac-ledger', 'ac-fs-tools'] } });
});

it('空骨架 = 最小数据根（agents/ 与 credentials/ 缺席合法）', () => {
  buildDataRoot(ROOT, {});
  expect(listAgentIds(ROOT)).toEqual([]);
  expect(readGlobalAuth(ROOT).entries).toEqual([]);
  expect(listCredentialNames(ROOT)).toEqual([]);
});
