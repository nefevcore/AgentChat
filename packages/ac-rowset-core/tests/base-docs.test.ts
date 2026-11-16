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
import { deriveHostRowset, type RowsetCatalog } from '../src/rowset.ts';

const PROFILE_DIR = fileURLToPath(new URL('../../../apps/catalog/profile/', import.meta.url));
const REPO_CATALOG = fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url));
const GENERATED = JSON.parse(fs.readFileSync(REPO_CATALOG, 'utf-8')) as RowsetCatalog;

describe('投影等价（cr-1033 B2 合并语义：骨架归基座 / 能力归包聚合）', () => {
  it('readCatalog 合并 == row-catalog.json 生成物（逐行 deep equal——gen 再现锁）', () => {
    expect(readCatalog(REPO_CATALOG)).toEqual({ rows: GENERATED.rows });
  });

  it('能力行新鲜度锁：JSON 能力区 == 包 ac.rows 聚合投影（gen 忘跑即红）', async () => {
    const { aggregatePackageRows } = await import('../src/package-rows.ts');
    const { projectBaseEntry } = await import('../src/base-docs.ts');
    const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
    const aggregated = aggregatePackageRows(REPO_ROOT)
      .map((e) => projectBaseEntry({ ...e, zone: 'capability' }, 'shell'));
    expect(GENERATED.rows.filter((r) => r.zone === 'capability')).toEqual(aggregated);
  });

  it('派生等价：壳骨架面/宿主行集派生与生成物侧一致', () => {
    const base = readBaseCatalog(PROFILE_DIR)!;
    const skeletonIds = (c: RowsetCatalog) =>
      c.rows.filter((r) => r.tree === 'shell' && r.zone === 'skeleton').map((r) => r.id);
    expect(skeletonIds(base)).toEqual(skeletonIds(GENERATED));
    expect(deriveHostRowset([], base)).toEqual(deriveHostRowset([], GENERATED));
  });

  it('两份基座各带版本戳且条目 id 基座内唯一（cr-1033 B3 起均单区数组）', () => {
    const host = readBaseDoc(baseDocFile(PROFILE_DIR, 'host'), 'host');
    expect(host.version).toBeGreaterThanOrEqual(1);
    expect(new Set(host.entries.map((e) => e.id)).size).toBe(host.entries.length);
    const shell = readBaseDoc(baseDocFile(PROFILE_DIR, 'shell'), 'shell');
    expect(shell.version).toBeGreaterThanOrEqual(6);
    expect(shell.entries.map((e) => e.id)).toHaveLength(15); // 骨架单区（menu-assembly §三；cr-1118 archive 回归骨架）
    expect(new Set(shell.entries.map((e) => e.id)).size).toBe(shell.entries.length);
  });

  it('缺版本戳 → throw；顶层非数组 → throw（host 单区约束——shell 已双区化）', () => {
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

  it('shell v7 单区骨架 15 行 + 投影派生 zone（能力行归包——cr-1033 B3；cr-1066 permission-gate；cr-1118 archive 回归）', () => {
    const doc = readBaseDoc(baseDocFile(PROFILE_DIR, 'shell'), 'shell');
    expect(doc.entries.map((e) => e.id)).toEqual([
      'logger-console', 'config', 'ledger', 'archive', 'conversation', 'tools', 'permission-gate', 'llm', 'llm-pool',
      'agent-loop', 'persona', 'conduct', 'host-face-client', 'durable-interaction', 'jobs',
    ]);
    const projected = doc.entries.map((e) => projectBaseEntry(e, 'shell'));
    expect(projected.every((r) => r.zone === 'skeleton')).toBe(true);
  });

  it('projectBaseEntry：name 去 link: 单 path / zone 注入 / 无包行无 path', () => {
    expect(projectBaseEntry({ id: 'a', name: 'link:packages/x' }, 'shell'))
      .toEqual({ id: 'a', tree: 'shell', zone: 'skeleton', path: 'packages/x' }); // 壳基座行派生 skeleton（cr-1033 B3）
    expect(projectBaseEntry({ id: 'b', name: 'link:packages/x', zone: 'capability' }, 'shell'))
      .toEqual({ id: 'b', tree: 'shell', zone: 'capability', path: 'packages/x' }); // 显式 zone 透传（包聚合能力行）
    expect(projectBaseEntry({ id: 'c' }, 'host')).toEqual({ id: 'c', tree: 'host' });
  });
});

describe('readCatalog 双读 → 合并（cr-1033 B2）', () => {
  it('仓库目录：基座在场 → 宿主/骨架取基座 + 能力取 JSON 投影', () => {
    expect(readCatalog(REPO_CATALOG)).toEqual({ rows: GENERATED.rows });
  });

  it('合并语义：基座骨架赢 + JSON 能力区并入', () => {
    const ROOT = path.join('sandbox', 'test-base-docs-merge-' + process.pid);
    fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
    try {
      fs.writeFileSync(path.join(ROOT, 'profile', 'host.yml'), '# ac-base-version: 1\n- id: h1\n  name: link:packages/x\n');
      fs.writeFileSync(path.join(ROOT, 'profile', 'shell.yml'), '# ac-base-version: 1\n- id: s1\n  name: link:packages/x\n');
      fs.writeFileSync(path.join(ROOT, 'row-catalog.json'), JSON.stringify({
        rows: [
          { id: 'h1', tree: 'host' },
          { id: 's1', tree: 'shell', zone: 'skeleton' },
          { id: 'json-cap', tree: 'shell', zone: 'capability' },
        ],
      }));
      const rows = readCatalog(path.join(ROOT, 'row-catalog.json')).rows;
      expect(rows.map((r) => r.id)).toEqual(['h1', 's1', 'json-cap']); // yml 能力区被 JSON 赢（归包换轨）
      expect(readCatalog(path.join(ROOT, 'row-catalog.json')).rows).toHaveLength(3);
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
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
    // cr-1033 B2：行集目录投影随行物化（数据根默认读面合并语义的携带面）
    expect(fs.readFileSync(path.join(DATA, 'row-catalog.json'), 'utf-8'))
      .toBe(fs.readFileSync(REPO_CATALOG, 'utf-8'));
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
    fs.writeFileSync(dst, fs.readFileSync(dst, 'utf-8').replace('- id: ledger', '- id: ledger2'));
    expect(() => materializeBaseDocs(PROFILE_DIR, DATA)).toThrow('未升版本戳');
  });

  it('profileDirOf：catalogFile 同目录 profile/', () => {
    expect(profileDirOf(path.join('a', 'b', 'row-catalog.json'))).toBe(path.join('a', 'b', 'profile'));
  });

  it('cr-1056 同名双义收口：旧名 <proc>.patch.yml 不再被基座读面消费——数据根基座新名缺席时差量层同名文件不误吞（缺戳 fail-loud）', () => {
    materializeBaseDocs(PROFILE_DIR, DATA);
    fs.rmSync(baseDocFile(path.join(DATA, 'profile'), 'host'), { force: true });
    // 用户差量层同名文件在场：基座读面不再回退旧名——不会把它当基座吞掉
    fs.writeFileSync(path.join(DATA, 'profile', 'host.patch.yml'), "- id: x\n  disabled: true\n");
    expect(() => readCatalog(path.join(DATA, 'row-catalog.json'))).toThrow('残缺');
    // 独立 profile 目录只有旧名文件（cr-1004 前源形态）→ 基座缺席 = null
    const OLD = path.join(ROOT, 'old-profile');
    fs.mkdirSync(OLD, { recursive: true });
    fs.writeFileSync(path.join(OLD, 'host.patch.yml'), "# ac-base-version: 1\n- id: a\n");
    expect(readBaseCatalog(OLD)).toBeNull();
  });
});
