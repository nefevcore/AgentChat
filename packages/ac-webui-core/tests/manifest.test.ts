// ============================================================
// M7.4 插件 client 通道单测：schema 校验 / graph 组装 / 静态路由
// ============================================================
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkUiManifest, assembleBootGraph, resolveUiAsset } from '../src/manifest.ts';

const ROOT = path.join('sandbox', 'test-manifest-' + process.pid);
function cleanup(): void { fs.rmSync(ROOT, { recursive: true, force: true }); }

describe('M7.4 checkUiManifest', () => {
  it('合法 manifest 过验', () => {
    expect(checkUiManifest({ name: 'todo', version: '1.0.0', entry: 'ui/dist/index.js', platform: 'web' }).ok).toBe(true);
  });
  it('非法形态全拦：缺 name / 坏词形 / 路径逃逸 / 坏 platform', () => {
    expect(checkUiManifest(null).ok).toBe(false);
    expect(checkUiManifest({ version: '1' }).ok).toBe(false);
    expect(checkUiManifest({ name: 'Todo_大写', version: '1' }).ok).toBe(false);
    expect(checkUiManifest({ name: 'a', version: '1', entry: '../escape.js' }).ok).toBe(false);
    expect(checkUiManifest({ name: 'a', version: '1', styles: ['C:/x.css'] }).ok).toBe(false);
    expect(checkUiManifest({ name: 'a', version: '1', platform: 'desktop' }).ok).toBe(false);
    expect(checkUiManifest({ name: 'a', version: '1', seats: [{}] }).ok).toBe(false);
  });

  it('seats 三词形（cr-690 B1）：view/kind/scope 形状校验 + kind/scope 仅随 new:', () => {
    const base = { name: 'acme', version: '1.0.0' };
    // ① 既有词形不变过验
    expect(checkUiManifest({ ...base, seats: [{ seat: 'tool-card' }] }).ok).toBe(true);
    // ② new: 词形 + kind/scope 随行
    expect(checkUiManifest({ ...base, seats: [{ seat: 'new:acme:panel-body', kind: 'list', scope: 'session' }] }).ok).toBe(true);
    // ③ 视角挂载（view 声明）
    expect(checkUiManifest({ ...base, seats: [{ seat: 'acme:panel-body', view: { region: 'aux', id: 'acme' } }] }).ok).toBe(true);
    // 坏 view：region 越界 / id 词形非法 / label 非串
    expect(checkUiManifest({ ...base, seats: [{ seat: 's', view: { region: 'sidebar', id: 'a' } }] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, seats: [{ seat: 's', view: { region: 'aux', id: 'Bad_Id' } }] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, seats: [{ seat: 's', view: { region: 'aux', id: 'a', label: 3 } }] }).ok).toBe(false);
    // 坏 kind/scope 词表 + 非 new: 前缀携带 kind/scope
    expect(checkUiManifest({ ...base, seats: [{ seat: 's', kind: 'grid' }] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, seats: [{ seat: 's', scope: 'page' }] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, seats: [{ seat: 'tool-card', kind: 'list' }] }).ok).toBe(false);
  });

  it('theme 形状 + 纯数据约束（B2：tokensOnly 主题包不得混模块面字段）', () => {
    const base = { name: 'acme-theme', version: '1.0.0' };
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true }, styles: ['tokens.css'] }).ok).toBe(true);
    expect(checkUiManifest({ ...base, theme: {} }).ok).toBe(false);
    expect(checkUiManifest({ ...base, theme: { tokensOnly: false } }).ok).toBe(false);
    // 缺 styles / 混 entry / 混 seats / 混 channelImports / isolated:false 全拒
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true } }).ok).toBe(false);
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true }, styles: ['tokens.css'], entry: 'ui/index.js' }).ok).toBe(false);
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true }, styles: ['tokens.css'], seats: [{ seat: 'dock' }] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true }, styles: ['tokens.css'], channelImports: ['vue'] }).ok).toBe(false);
    expect(checkUiManifest({ ...base, theme: { tokensOnly: true }, styles: ['tokens.css'], isolated: false }).ok).toBe(false);
  });
});

describe('M7.4 assembleBootGraph', () => {
  it('扫插件目录 → graph 条目；坏 manifest 跳过记 warning', () => {
    cleanup();
    const dir = path.join(ROOT, 'plugins');
    // 好插件
    fs.mkdirSync(path.join(dir, 'todo', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'todo', 'manifest.json'), JSON.stringify({
      name: 'todo', version: '1.0.0', entry: 'ui/index.js', platform: 'web',
      seats: [{ seat: 'dock' }], isolated: false,
    }));
    fs.writeFileSync(path.join(dir, 'todo', 'ui', 'index.js'), 'export default 1');
    // 坏 manifest（缺 version）
    fs.mkdirSync(path.join(dir, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad', 'manifest.json'), JSON.stringify({ name: 'bad' }));
    const { graph, warnings } = assembleBootGraph(dir);
    expect(graph).toHaveLength(1);
    expect(graph[0].name).toBe('todo');
    expect(graph[0].base).toBe('/ui-plugin/todo/');
    expect(graph[0].seats).toEqual([{ seat: 'dock' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad');
    // 空目录 → 空图无 warning
    const empty = assembleBootGraph(path.join(ROOT, 'nothing'));
    expect(empty.graph).toEqual([]);
    expect(empty.warnings).toEqual([]);
  });

  it('隐藏目录不入 graph（插件库 .staging/.backup 是宿主内部状态——cr-543）', () => {
    cleanup();
    const dir = path.join(ROOT, 'plugins');
    // 未审暂存副本（人审前绝不下发）+ 旧版本备份
    for (const name of ['.staging', '.backup', 'approved']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({
        name: name.replace('.', 'x'), version: '1.0.0', entry: 'index.js', platform: 'web',
      }));
    }
    const { graph, warnings } = assembleBootGraph(dir);
    // 只有非隐藏的 approved 入图（.staging 未审暂存 / .backup 旧版本均不下发）
    expect(graph.map((entry) => entry.name)).toEqual(['approved']);
    expect(warnings).toEqual([]);
  });
});

describe('M7.4 resolveUiAsset', () => {
  it('合法路径解析 + 逃逸拦截 + 未知名 404', () => {
    cleanup();
    const dir = path.join(ROOT, 'plugins');
    fs.mkdirSync(path.join(dir, 'todo', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'todo', 'ui', 'index.js'), 'x');
    const hit = resolveUiAsset(dir, 'todo', 'ui/index.js');
    expect(hit?.contentType).toBe('text/javascript; charset=utf-8');
    expect(resolveUiAsset(dir, 'todo', '../bad/escape.js')).toBeNull();
    expect(resolveUiAsset(dir, 'unknown', 'ui/index.js')).toBeNull();
    expect(resolveUiAsset(dir, '../agents', 'x')).toBeNull(); // 名本身非法
  });
});

afterAll(cleanup);

describe('checkUiManifest 词法放宽（cr-905 批3）', () => {
  it('@scope/name npm 词形合法；param-case 原样合法；大写/下划线仍非法', () => {
    const ok = (name: string) => checkUiManifest({ name, version: '1.0.0', entry: 'ui/index.js' }).ok;
    expect(ok('@scope/name')).toBe(true);
    expect(ok('plain-name')).toBe(true);
    expect(ok('Bad_Name')).toBe(false);
    expect(ok('@Scope/name2')).toBe(false);
  });
});

describe('包形态装载（cr-905 批3 切片四）', () => {
  const ROOT = path.join('sandbox', 'test-pkg-web-' + process.pid);
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('package.json ac.faces.web → boot graph（seats 字符串投影 + isolated 缺省 true）', () => {
    const dir = path.join(ROOT, 'ac-plugin-webdemo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'ac-plugin-webdemo', version: '2.0.0',
      ac: { faces: { web: { entry: 'ui/index.js', seats: ['tool-card'] } } },
    }));
    const { graph, warnings } = assembleBootGraph(ROOT);
    expect(warnings).toEqual([]);
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ name: 'ac-plugin-webdemo', version: '2.0.0', isolated: true });
    expect(graph[0].seats).toEqual([{ seat: 'tool-card' }]);
  });

  it('node-only 包（无 web 面）不进 graph 且零警告；manifest.json 优先于 package 投影', () => {
    const nodeOnly = path.join(ROOT, 'node-only-pkg');
    fs.mkdirSync(nodeOnly, { recursive: true });
    fs.writeFileSync(path.join(nodeOnly, 'package.json'), JSON.stringify({
      name: 'node-only-pkg', version: '1.0.0', ac: { faces: { node: { entry: './src/index.ts' } } },
    }));
    const both = path.join(ROOT, 'both-forms');
    fs.mkdirSync(both, { recursive: true });
    fs.writeFileSync(path.join(both, 'package.json'), JSON.stringify({
      name: 'both-forms', version: '9.9.9',
      ac: { faces: { web: { entry: 'pkg.js' } } },
    }));
    fs.writeFileSync(path.join(both, 'manifest.json'), JSON.stringify({
      name: 'both-forms', version: '1.0.0', entry: 'ui/index.js', platform: 'web', isolated: false,
    }));
    const { graph, warnings } = assembleBootGraph(ROOT);
    expect(warnings).toEqual([]);
    const both2 = graph.find((e) => e.name === 'both-forms');
    expect(both2?.version).toBe('1.0.0'); // manifest 赢（迁移期投影优先既有声明）
    expect(both2?.isolated).toBe(false);
    expect(graph.find((e) => e.name === 'node-only-pkg')).toBeUndefined();
  });
});
