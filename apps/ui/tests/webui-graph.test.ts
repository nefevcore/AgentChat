// ============================================================
// webui-graph.test.ts —— 打脏/flush 穿透测试（cr-926 切片①；webui-v3 §5 切片①「最先写」）
//
// 全方案地基：fiber 事件时序（internal/plugin 构造/销毁）与 loader
// 内部表可读性（entries 活态）。三动作穿透：
//   装载（loader.create）   → wire +1 行
//   卸载（loader.remove）   → wire −1 行
//   停用（tree.update disabled）→ wire −1 行（fiber 销毁同事件流）
// 激活趟 = 构造时 seed 全部行名同步 flush（与稳态同一实现）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@agentchat/cordis';
import { Loader } from '@agentchat/cordis-loader';
import { WebuiWireGraph } from '../src/webui-graph.ts';

const roots: string[] = [];
const ctxs: Context[] = [];

async function makeRoot(): Promise<{ root: string; ctx: Context }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-webui-graph-'));
  roots.push(root);
  const ctx = new Context();
  ctxs.push(ctx);
  ctx.plugin(Loader, { baseUrl: pathToFileURL(root).href + '/' });
  // 服务面就位是异步的（fiber LOADING → ACTIVE）——等一拍再取 ctx.loader
  await new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  if (ctx.loader === undefined) throw new Error('loader 服务未就位');
  return { root, ctx };
}

interface FixturePkg {
  name: string;
  version?: string;
  web?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
}

/** 夹具包：package.json(ac.faces.web) + node 半 .mjs + client/dist 产物 */
async function writePkg(root: string, spec: FixturePkg): Promise<void> {
  const dir = join(root, spec.name, 'src');
  await mkdir(dir, { recursive: true });
  const distDir = join(root, spec.name, 'client', 'dist');
  await mkdir(distDir, { recursive: true });
  const pkg: Record<string, unknown> = {
    name: spec.name,
    version: spec.version ?? '1.0.0',
    main: './src/index.mjs',
    ...(spec.web !== null ? { ac: { faces: { web: spec.web ?? {} } } } : {}),
  };
  await writeFile(join(root, spec.name, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'index.mjs'), `export default { name: '${spec.name}', apply() {} };\n`);
  await writeFile(join(distDir, 'index.js'), `window.__ModuleLoader__ && window.__ModuleLoader__.load({ id: '${spec.name}', factory() { return {}; } });\n`);
  if (spec.manifest !== null) {
    await writeFile(join(distDir, 'manifest.json'), JSON.stringify(spec.manifest ?? { rev: 'r1', builtAt: 1, files: { 'index.js': { hash: 'x', size: 1 } } }));
  }
}

/** 等脏集 flush 落地：fiber 排空 + microtask 泵两拍 */
async function settle(ctx: Context): Promise<void> {
  await (ctx.loader as any).await();
  await new Promise<void>((resolve) => { queueMicrotask(() => resolve()); });
  await new Promise<void>((resolve) => { setTimeout(() => resolve(), 0); });
}

function rowIds(graph: WebuiWireGraph): string[] {
  return graph.wire().rows.map((r) => r.id);
}

afterEach(async () => {
  ctxs.splice(0); // root ctx 无 dispose 面——进程内 fiber 树随测试文件收尾
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('WebuiWireGraph 打脏/flush 穿透', () => {
  it('装载 → wire +1 行（声明 → 装载 → wire 全链）', async () => {
    const { root, ctx } = await makeRoot();
    await writePkg(root, {
      name: 'plug-a',
      web: { entry: './client/dist/index.js', seats: ['conversation:dock-widget'], inject: [], isolated: false, seeds: { vue: '^3' } },
    });
    const graph = new WebuiWireGraph(ctx, ctx.loader as any, { shellSeeds: { vue: '^3.4' } });
    expect(rowIds(graph)).toEqual([]); // 激活趟在装载前构造 = 空图

    await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    await settle(ctx);
    expect(rowIds(graph)).toEqual(['plug-a']);
    const row = graph.wire().rows[0]!;
    expect(row.entry).toBe('/ui-asset/plug-a/r1/index.js');
    expect(row.seats).toEqual(['conversation:dock-widget']);
    expect(row.isolated).toBe(false);
    expect(graph.wire().seeds).toEqual({ vue: '^3.4' });
    expect(graph.wire().warnings).toEqual([]);
  });

  it('激活趟与稳态同一实现：构造时已装载的行直接进 wire', async () => {
    const { root, ctx } = await makeRoot();
    await writePkg(root, { name: 'plug-a', web: { entry: './client/dist/index.js', seats: [] } });
    await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    await settle(ctx);
    const graph = new WebuiWireGraph(ctx, ctx.loader as any);
    expect(rowIds(graph)).toEqual(['plug-a']);
  });

  it('卸载 → wire −1 行；rev 变化才通知', async () => {
    const { root, ctx } = await makeRoot();
    await writePkg(root, { name: 'plug-a', web: { entry: './client/dist/index.js', seats: [] } });
    const id = await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    const graph = new WebuiWireGraph(ctx, ctx.loader as any);
    await settle(ctx);
    expect(rowIds(graph)).toEqual(['plug-a']);

    let notified = 0;
    graph.onGraphChanged(() => notified++);
    graph.flush();
    expect(notified).toBe(0); // 无变化不通知

    await (ctx.loader as any).remove(id);
    await settle(ctx);
    expect(rowIds(graph)).toEqual([]);
    expect(notified).toBe(1);
  });

  it('停用（disabled）→ wire −1 行——与卸载同事件流', async () => {
    const { root, ctx } = await makeRoot();
    await writePkg(root, { name: 'plug-a', web: { entry: './client/dist/index.js', seats: [] } });
    const id = await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    const graph = new WebuiWireGraph(ctx, ctx.loader as any);
    await settle(ctx);
    expect(rowIds(graph)).toEqual(['plug-a']);

    await (ctx.loader as any).update(id, { disabled: true });
    await settle(ctx);
    expect(rowIds(graph)).toEqual([]);
  });

  it('非 web 面行不进 wire；声明违例 = 警告 + 跳过', async () => {
    const { root, ctx } = await makeRoot();
    // 非 web 面行（无 ac.faces.web）
    await writePkg(root, { name: 'plain-row', web: null });
    // 声明违例（entry 词形非法）
    await writePkg(root, { name: 'bad-row', web: { entry: './src/index.ts', seats: [] } });
    // 产物清单缺失
    await writePkg(root, { name: 'nobuild-row', web: { entry: './client/dist/index.js', seats: [] }, manifest: null });
    const graph = new WebuiWireGraph(ctx, ctx.loader as any);
    await (ctx.loader as any).create({ name: './plain-row/src/index.mjs' });
    await (ctx.loader as any).create({ name: './bad-row/src/index.mjs' });
    await (ctx.loader as any).create({ name: './nobuild-row/src/index.mjs' });
    await settle(ctx);
    expect(rowIds(graph)).toEqual([]);
    const warnings = graph.wire().warnings.join('\n');
    expect(warnings).toContain('bad-row');
    expect(warnings).toContain('nobuild-row');
    expect(warnings).not.toContain('plain-row');
  });

  it('同名包重建（卸载→装载）行回归位；产物 rev 变化 → entry URL 随之', async () => {
    const { root, ctx } = await makeRoot();
    await writePkg(root, { name: 'plug-a', web: { entry: './client/dist/index.js', seats: [] }, manifest: { rev: 'r1', builtAt: 1, files: {} } });
    const id = await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    const graph = new WebuiWireGraph(ctx, ctx.loader as any);
    await settle(ctx);
    expect(graph.wire().rows[0]!.entry).toBe('/ui-asset/plug-a/r1/index.js');

    await (ctx.loader as any).remove(id);
    await writePkg(root, { name: 'plug-a', web: { entry: './client/dist/index.js', seats: [] }, manifest: { rev: 'r2', builtAt: 2, files: {} } });
    await (ctx.loader as any).create({ name: './plug-a/src/index.mjs' });
    await settle(ctx);
    expect(rowIds(graph)).toEqual(['plug-a']);
    expect(graph.wire().rows[0]!.entry).toBe('/ui-asset/plug-a/r2/index.js');
  });
});
