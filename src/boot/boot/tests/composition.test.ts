// ============================================================
// boot 测试：composition.ts —— 空根+分层补丁组合 / 热重组合
// 迷你真树：临时 profile + fixture .mjs 插件经 Loader+include 装载。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_PATCH_FILE,
  PATCH_FILENAME,
  ROOT_FILENAME,
  agentchatHome,
  bootComposed,
  composeLayers,
  dumpComposedYaml,
  loadPatchLayer,
  prepareProfileRoot,
} from '../src/composition';

let tmp: string;
let profileDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-compose-'));
  profileDir = path.join(tmp, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFixturePlugin(name = 'smoke.mjs'): string {
  const file = path.join(profileDir, name);
  // 计数放 apply（每次激活必跑）：模块体受 ESM 缓存，disable→enable 的
  // 重激活不会重新执行模块体，但一定重新执行 apply。
  fs.writeFileSync(file, `
export const name = 'smoke-fixture';
export function apply() {
  globalThis.__smokeCount = (globalThis.__smokeCount ?? 0) + 1;
}
`);
  return file;
}

/** 迷你 bundle：一条 insert 行挂 fixture 插件 */
function writeMiniBundle(extra = ''): string {
  const file = path.join(tmp, 'bundle.yml');
  fs.writeFileSync(file, `- insert:
    - id: smoke
      name: './smoke.mjs'
${extra}`);
  return file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('loadPatchLayer', () => {
  it('空/纯注释文件返回 undefined（不是空数组）', () => {
    const file = path.join(tmp, 'empty.yml');
    fs.writeFileSync(file, '# 只有注释\n');
    expect(loadPatchLayer(file, 'test')).toBeUndefined();
    expect(loadPatchLayer(path.join(tmp, 'absent.yml'), 'test')).toBeUndefined();
  });

  it('非数组结构抛错（fail loud）', () => {
    const file = path.join(tmp, 'bad.yml');
    fs.writeFileSync(file, 'id: x\n');
    expect(() => loadPatchLayer(file, 'test')).toThrow(/必须是补丁数组/);
  });
});

describe('composeLayers', () => {
  it('顺序：bundle → 用户层 → 机器层 → 覆盖；缺层跳过', async () => {
    const bundle = path.join(tmp, 'b.yml');
    fs.writeFileSync(bundle, '- insert:\n    - id: b1\n      name: x');
    fs.writeFileSync(path.join(profileDir, PATCH_FILENAME), '- id: u1\n  disabled: true');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, PATCH_FILENAME), '- id: h1\n  disabled: true');
    const overlay = path.join(tmp, 'o.yml');
    fs.writeFileSync(overlay, '- id: o1\n  disabled: true');

    const { patches, files } = await composeLayers({
      profileDir, bundleFile: bundle, homeDir: home, overlays: [overlay], marketDir: null,
    });
    // 顺序 = bundle insert 的行 + u1 + h1 + o1
    expect(patches).toHaveLength(4);
    expect((patches[0] as { insert: unknown[] }).insert).toHaveLength(1);
    expect(patches.slice(1).map((p) => p.id)).toEqual(['u1', 'h1', 'o1']);
    expect(files).toHaveLength(4);
  });

  it('空用户层/无市场：缺层跳过', async () => {
    const bundle = path.join(tmp, 'b.yml');
    fs.writeFileSync(bundle, '- insert: []');
    const { patches } = await composeLayers({ profileDir, bundleFile: bundle, homeDir: null, marketDir: null });
    expect(patches).toHaveLength(1);
  });

  it('market 动态层：registry 已安装 → market/<name> 桥行', async () => {
    const bundle = path.join(tmp, 'b.yml');
    fs.writeFileSync(bundle, '- insert: []');
    const ws = path.join(tmp, 'ws');
    const { stagePlugin, approveStaging } = await import('@agentchat/plugins');
    const devDir = path.join(tmp, 'p1');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'manifest.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', entry: 'index.mjs' }));
    fs.writeFileSync(path.join(devDir, 'index.mjs'), 'export function apply() {}');
    const record = stagePlugin(ws, devDir, 'tester');
    approveStaging(ws, record.id);

    const { patches } = await composeLayers({ profileDir, bundleFile: bundle, homeDir: null, marketDir: ws });
    const marketPatch = patches.find((p) => (p as { insert?: Array<{ id?: string }> }).insert?.[0]?.id?.startsWith('market/'));
    expect(marketPatch).toBeDefined();
    const row = (marketPatch as unknown as { insert: Array<{ id: string; name: string; config: { name: string } }> }).insert[0];
    expect(row.id).toBe('market/demo-plugin');
    expect(row.config.name).toBe('demo-plugin');
    expect(row.name).toMatch(/bridge\.[jt]s$/);
  });
});

describe('prepareProfileRoot', () => {
  it('重写为空根（防 Loader 写回烤入组合行）', () => {
    // 模拟写回污染：root 里被塞了行
    fs.writeFileSync(path.join(profileDir, ROOT_FILENAME), '- name: baked\n');
    const root = prepareProfileRoot(profileDir);
    const content = fs.readFileSync(root, 'utf8');
    expect(content.trim().endsWith('[]')).toBe(true);
    expect(content).not.toContain('baked');
  });
});

describe('bootComposed（迷你真树）', () => {
  it('空根+bundle 补丁装载插件；reapply 热启停行', async () => {
    writeFixturePlugin();
    const bundle = writeMiniBundle();
    const booted = await bootComposed({ profileDir, bundleFile: bundle, homeDir: null, marketDir: null });
    try {
      await booted.include.await();
      expect((globalThis as { __smokeCount?: number }).__smokeCount).toBeGreaterThanOrEqual(1);

      // 热停用：行 disabled，插件不重复激活
      const before = (globalThis as { __smokeCount?: number }).__smokeCount ?? 0;
      await booted.reapply([
        { insert: [{ id: 'smoke', name: './smoke.mjs', disabled: true }] },
      ]);
      await booted.include.await();
      expect((globalThis as { __smokeCount?: number }).__smokeCount ?? 0).toBe(before);

      // 热恢复：重新激活（计数+1）
      await booted.reapply([
        { insert: [{ id: 'smoke', name: './smoke.mjs' }] },
      ]);
      await booted.include.await();
      expect((globalThis as { __smokeCount?: number }).__smokeCount).toBeGreaterThan(before);
    } finally {
      await booted.ctx.fiber.dispose();
    }
  }, 20000);
});

describe('dumpComposedYaml（离线打印有效组合）', () => {
  it('default 模式 = bundle + market，不含用户层/机器层/覆盖', async () => {
    fs.writeFileSync(path.join(profileDir, PATCH_FILENAME), '- id: x-user' + String.fromCharCode(10) + '  disabled: true');
    const text = await dumpComposedYaml({ profileDir, homeDir: null, mode: 'default' });
    expect(text).not.toContain('id: x-user');
  });

  it('full 模式应用用户层补丁；default 跳过（dump-default 语义）', async () => {
    // 补丁目标 = bundle 真实行 id（hello）；对不存在 id 的补丁告警跳过
    fs.writeFileSync(path.join(profileDir, PATCH_FILENAME), '- id: hello' + String.fromCharCode(10) + '  disabled: true');
    const full = await dumpComposedYaml({ profileDir, homeDir: null, mode: 'full' });
    const def = await dumpComposedYaml({ profileDir, homeDir: null, mode: 'default' });
    // full：hello 行被用户补丁停用；default：hello 行原样（dump 键序不保证，
    // 断言按行片段切片而非整文本——hmr 行的 disabled 与此无关）
    const seg = (text: string) => text.slice(text.indexOf('id: hello'), text.indexOf('id: hello') + 250);
    expect(seg(full)).toContain('disabled: true');
    expect(seg(def)).not.toContain('disabled');
  });

  it('default 含 market 动态层行', async () => {
    const ws = path.join(tmp, 'ws');
    const { stagePlugin, approveStaging } = await import('@agentchat/plugins');
    const devDir = path.join(tmp, 'p2');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'manifest.json'), JSON.stringify({ name: 'dump-plugin', version: '1.0.0', entry: 'index.mjs' }));
    fs.writeFileSync(path.join(devDir, 'index.mjs'), 'export function apply() {}');
    approveStaging(ws, stagePlugin(ws, devDir, 't').id);
    const text = await dumpComposedYaml({ profileDir, homeDir: null, marketDir: ws, mode: 'default' });
    expect(text).toContain('id: market/dump-plugin');
  });
});

describe('bundle-rows.gen（生成物同步）', () => {
  it('generate() 输出与入库生成物一致（漂移即失败：重跑 pnpm gen:bundle-rows）', async () => {
    // @ts-expect-error 动态加载仓库脚本（vitest 可解析，tsc 无 .mjs 上下文）
    const { generate } = await import('../../../../../scripts/gen-bundle-rows.mjs');
    const committed = fs.readFileSync(
      path.resolve(__dirname, '../src/bundle-rows.gen.ts'), 'utf8',
    );
    expect(generate()).toBe(committed);
  });

  it('BUNDLE_ROWS id 唯一且覆盖关键行', async () => {
    const { BUNDLE_ROWS } = await import('../src/bundle-rows.gen');
    const ids = BUNDLE_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['logger', 'tools', 'plugin-host', 'market', 'boot-finalize', 'webui', 'hello']) {
      expect(ids).toContain(id);
    }
    // disabled 行（hmr）不进生成物（loader 专属）
    expect(ids).not.toContain('hmr');
  });
});

describe('常量', () => {
  it('基座 bundle 随包存在；home 可被 env 覆盖', () => {
    expect(fs.existsSync(BUNDLE_PATCH_FILE)).toBe(true);
    expect(fs.readFileSync(BUNDLE_PATCH_FILE, 'utf8')).toContain('id: logger');
    process.env.AGENTCHAT_HOME = path.join(tmp, 'h');
    try {
      expect(agentchatHome()).toBe(path.join(tmp, 'h'));
    } finally {
      delete process.env.AGENTCHAT_HOME;
    }
  });
});

