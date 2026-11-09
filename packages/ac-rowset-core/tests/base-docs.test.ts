// ============================================================
// base-docs.test.ts —— 基座源文档对账单测（cr-902 / cr-901 v2.1 批1）
//
// 锁定三面：
//   1. 投影等价：基座文档投影 == row-catalog.json 生成物（基座是单一
//      事实源，JSON 漂移即红——gen-row-catalog.mjs 忘跑）；
//   2. 双读：readCatalog 基座赢 / 基座缺席回退 JSON；
//   3. 部署链：物化幂等 + 版本戳对账 fail-loud（旧压新 / 同版本漂移）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readBaseDoc, readBaseCatalog, baseDocFile, profileDirOf,
  materializeBaseDocs, projectBaseEntry,
} from '../src/base-docs.ts';
import { readCatalog } from '../src/disk.ts';
import { deriveShellRowset, deriveHostRowset, type RowsetCatalog } from '../src/rowset.ts';

const PROFILE_DIR = fileURLToPath(new URL('../../../apps/catalog/profile/', import.meta.url));
const REPO_CATALOG = fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url));
const GENERATED = JSON.parse(fs.readFileSync(REPO_CATALOG, 'utf-8')) as RowsetCatalog;

describe('投影等价（基座 = 单一事实源）', () => {
  it('基座投影 == row-catalog.json 生成物（逐行 deep equal）', () => {
    const base = readBaseCatalog(PROFILE_DIR)!;
    expect(base.rows).toHaveLength(GENERATED.rows.length);
    expect(base.rows).toEqual(GENERATED.rows);
  });

  it('派生等价：壳/宿主行集派生与生成物侧一致', () => {
    const base = readBaseCatalog(PROFILE_DIR)!;
    expect(deriveShellRowset({}, base)).toEqual(deriveShellRowset({}, GENERATED));
    expect(deriveHostRowset([], base)).toEqual(deriveHostRowset([], GENERATED));
  });

  it('两份基座各带版本戳且条目 id 基座内唯一', () => {
    for (const proc of ['host', 'shell'] as const) {
      const doc = readBaseDoc(baseDocFile(PROFILE_DIR, proc), proc);
      expect(doc.version).toBeGreaterThanOrEqual(1);
      const ids = doc.entries.map((e) => e.id);
      expect(new Set(ids).size, proc + ' 基座内 id 重复').toBe(ids.length);
    }
  });

  it('缺版本戳 → throw；顶层非数组 → throw', () => {
    const ROOT = path.join('sandbox', 'test-base-docs-' + process.pid);
    fs.mkdirSync(ROOT, { recursive: true });
    try {
      fs.writeFileSync(path.join(ROOT, 'bad1.patch.yml'), '- id: x\n  name: link:p\n');
      expect(() => readBaseDoc(path.join(ROOT, 'bad1.patch.yml'), 'host'))
        .toThrow('缺版本戳');
      fs.writeFileSync(path.join(ROOT, 'bad2.patch.yml'), '# ac-base-version: 1\nversion: 2\n');
      expect(() => readBaseDoc(path.join(ROOT, 'bad2.patch.yml'), 'host'))
        .toThrow('顶层必须是条目数组');
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });

  it('projectBaseEntry：packs 单包折标量 / name 去 link: / 无包行无 path', () => {
    expect(projectBaseEntry({ id: 'a', name: 'link:packages/x' }, 'shell'))
      .toEqual({ id: 'a', tree: 'shell', path: 'packages/x' });
    expect(projectBaseEntry({ id: 'b', name: 'link:packages/x', packs: ['packages/x', 'packages/y'] }, 'host'))
      .toEqual({ id: 'b', tree: 'host', path: ['packages/x', 'packages/y'] });
    expect(projectBaseEntry({ id: 'c' }, 'shell')).toEqual({ id: 'c', tree: 'shell' });
  });
});

describe('readCatalog 双读（基座赢）', () => {
  it('仓库目录：基座在场 → 基座投影', () => {
    expect(readCatalog(REPO_CATALOG)).toEqual({ rows: GENERATED.rows });
  });

  it('基座缺席 → 回退 JSON；目录缺席 → 空目录（fixture 容错原样）', () => {
    const ROOT = path.join('sandbox', 'test-base-docs-json-' + process.pid);
    fs.mkdirSync(ROOT, { recursive: true });
    try {
      fs.writeFileSync(path.join(ROOT, 'row-catalog.json'), JSON.stringify(GENERATED));
      expect(readCatalog(path.join(ROOT, 'row-catalog.json')).rows).toHaveLength(GENERATED.rows.length);
      expect(readCatalog(path.join(ROOT, 'absent.json'))).toEqual({ rows: [] });
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });

  it('基座残缺（只此一份）→ throw', () => {
    const ROOT = path.join('sandbox', 'test-base-docs-half-' + process.pid);
    fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
    try {
      fs.copyFileSync(baseDocFile(PROFILE_DIR, 'host'), baseDocFile(path.join(ROOT, 'profile'), 'host'));
      expect(() => readCatalog(path.join(ROOT, 'row-catalog.json'))).toThrow('残缺');
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

describe('版本戳部署链', () => {
  const ROOT = path.join('sandbox', 'test-base-docs-deploy-' + process.pid);
  const DATA = path.join(ROOT, 'home');
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('首次部署 + 幂等 + 逐字节副本', () => {
    const first = materializeBaseDocs(PROFILE_DIR, DATA);
    expect(first.map((r) => r.proc)).toEqual(['host', 'shell', 'webui']); // cr-905 批3：webui 基座随行部署
    expect(first.every((r) => r.updated)).toBe(true);
    for (const proc of ['host', 'shell', 'webui'] as const) {
      expect(fs.readFileSync(baseDocFile(path.join(DATA, 'profile'), proc), 'utf-8'))
        .toBe(fs.readFileSync(baseDocFile(PROFILE_DIR, proc), 'utf-8'));
    }
    const again = materializeBaseDocs(PROFILE_DIR, DATA);
    expect(again.every((r) => !r.updated)).toBe(true);
  });

  it('源目录缺席（JSON-only 旧式数据根）→ 空报告', () => {
    expect(materializeBaseDocs(path.join(ROOT, 'no-such-profile'), DATA)).toEqual([]);
  });

  it('副本版本 > 源（旧应用压新数据根）→ throw', () => {
    materializeBaseDocs(PROFILE_DIR, DATA);
    const dst = baseDocFile(path.join(DATA, 'profile'), 'host');
    fs.writeFileSync(dst, fs.readFileSync(dst, 'utf-8').replace(/# ac-base-version: \d+/, '# ac-base-version: 99'));
    expect(() => materializeBaseDocs(PROFILE_DIR, DATA)).toThrow('旧应用压新数据根');
  });

  it('同版本内容漂移（编辑未升戳）→ throw；升戳后重物化', () => {
    materializeBaseDocs(PROFILE_DIR, DATA);
    const dst = baseDocFile(path.join(DATA, 'profile'), 'shell');
    fs.writeFileSync(dst, fs.readFileSync(dst, 'utf-8').replace('- id: math', '- id: math2'));
    expect(() => materializeBaseDocs(PROFILE_DIR, DATA)).toThrow('未升版本戳');
  });

  it('profileDirOf：catalogFile 同目录 profile/', () => {
    expect(profileDirOf(path.join('a', 'b', 'row-catalog.json'))).toBe(path.join('a', 'b', 'profile'));
  });
});
