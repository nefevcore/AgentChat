// ============================================================
// catalog-manifest.test.ts —— 内置目录清单（生产 bundle 生产源）
// 解析 fail-soft / 环境变量指路 / 清单→目录条目纯映射
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCatalogManifest,
  readCatalogManifest,
  manifestBuiltinCatalog,
} from '../src/catalog-manifest.ts';

const savedEnv = process.env.AGENTCHAT_PLUGIN_MANIFEST;
const tmpDirs: string[] = [];

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENTCHAT_PLUGIN_MANIFEST;
  else process.env.AGENTCHAT_PLUGIN_MANIFEST = savedEnv;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-catalog-manifest-'));
  tmpDirs.push(dir);
  return dir;
}

describe('parseCatalogManifest（fail-soft：形态非法 → null）', () => {
  it('合法清单：builtin/rows 收编 + 双 Map（同名首条胜）', () => {
    const m = parseCatalogManifest(
      JSON.stringify({
        builtin: [
          { name: 'ac-foo', version: '0.1.0', description: 'foo 行' },
          { name: 'ac-bar' },
          { name: 'ac-foo', version: '9.9.9' }, // 同名 → 首条胜
          { name: '' }, // 空 name 丢弃
          'not-an-object', // 非对象丢弃
        ],
        rows: [
          { id: 'foo', name: 'ac-foo' },
          { id: 'hmr', name: '@agentchat/cordis-hmr' },
          { id: 'dup', name: 'ac-foo' }, // 同包 → 整条去重（首条胜，数组与 Map 同源）
          { id: '', name: 'ac-x' }, // 空 id 丢弃
        ],
      }),
    );
    expect(m).not.toBeNull();
    expect(m!.builtin.map((b) => b.name)).toEqual(['ac-foo', 'ac-bar']);
    expect(m!.builtinByName.get('ac-foo')!.version).toBe('0.1.0');
    expect(m!.rows).toHaveLength(2);
    expect(m!.entryIdByPkg.get('ac-foo')).toBe('foo');
    expect(m!.entryIdByPkg.get('@agentchat/cordis-hmr')).toBe('hmr');
  });

  it('非法形态 → null（非 JSON / 非对象 / 缺数组）', () => {
    expect(parseCatalogManifest('not json')).toBeNull();
    expect(parseCatalogManifest('[]')).toBeNull();
    expect(parseCatalogManifest('null')).toBeNull();
    expect(parseCatalogManifest('{}')).toBeNull(); // 缺 builtin/rows
    expect(parseCatalogManifest('{"builtin":[],"rows":{}}')).toBeNull();
  });
});

describe('readCatalogManifest（缺省 = 模块同目录；env 显式指路）', () => {
  it('dev 源码形态：同目录无清单 → null（走 src 扫描）', () => {
    delete process.env.AGENTCHAT_PLUGIN_MANIFEST;
    expect(readCatalogManifest(new URL('file:///nonexistent-dir/module.ts'))).toBeNull();
    // 本模块同目录（src/ac-plugin-core/src/）无 plugin-catalog.json → null
    expect(readCatalogManifest(import.meta.url)).toBeNull();
  });

  it('AGENTCHAT_PLUGIN_MANIFEST 指路 fixture → 读到并解析', () => {
    const dir = fixtureDir();
    const file = join(dir, 'plugin-catalog.json');
    writeFileSync(file, JSON.stringify({ builtin: [{ name: 'ac-z', version: '1.0.0' }], rows: [{ id: 'z', name: 'ac-z' }] }));
    process.env.AGENTCHAT_PLUGIN_MANIFEST = file;
    const m = readCatalogManifest(import.meta.url);
    expect(m?.builtinByName.get('ac-z')?.version).toBe('1.0.0');
    expect(m?.entryIdByPkg.get('ac-z')).toBe('z');
  });

  it('env 指向不存在/损坏文件 → null（fail-soft）', () => {
    process.env.AGENTCHAT_PLUGIN_MANIFEST = join(fixtureDir(), 'nope.json');
    expect(readCatalogManifest(import.meta.url)).toBeNull();
    const dir = fixtureDir();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{oops');
    process.env.AGENTCHAT_PLUGIN_MANIFEST = bad;
    expect(readCatalogManifest(import.meta.url)).toBeNull();
  });
});

describe('manifestBuiltinCatalog（清单内置组 → 目录条目；装配交叉是运行时事实）', () => {
  const manifest = parseCatalogManifest(
    JSON.stringify({
      builtin: [
        { name: 'ac-b', version: '0.2.0', description: 'b 行' },
        { name: 'ac-a' },
      ],
      rows: [
        { id: 'a', name: 'ac-a' },
        { id: 'b', name: 'ac-b' },
      ],
    }),
  )!;

  it('lookup 交叉：已装配行 active=true + fibers；entryId 透出；按名排序', () => {
    const items = manifestBuiltinCatalog(manifest, {
      rowState: (name) => (name === 'ac-a' ? { active: true, fibers: 2 } : { active: false, fibers: 0 }),
      entryId: (name) => (name === 'ac-a' ? 'a' : undefined),
    });
    expect(items).toEqual([
      { name: 'ac-a', assembled: true, fibers: 2, entryId: 'a' },
      { name: 'ac-b', version: '0.2.0', description: 'b 行', assembled: false, fibers: 0 },
    ]);
  });

  it('registry 无该行 → assembled=false / fibers=0（未装配或已停用）', () => {
    const items = manifestBuiltinCatalog(manifest, {
      rowState: () => ({ active: false, fibers: 0 }),
      entryId: () => undefined,
    });
    expect(items.every((i) => i.assembled === false && i.fibers === 0)).toBe(true);
    expect(items.every((i) => !('entryId' in i))).toBe(true);
  });
});
