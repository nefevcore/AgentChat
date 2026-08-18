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
  it('顺序：bundle → 用户层 → 机器层 → 覆盖；缺层跳过', () => {
    const bundle = path.join(tmp, 'b.yml');
    fs.writeFileSync(bundle, '- insert:\n    - id: b1\n      name: x');
    fs.writeFileSync(path.join(profileDir, PATCH_FILENAME), '- id: u1\n  disabled: true');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, PATCH_FILENAME), '- id: h1\n  disabled: true');
    const overlay = path.join(tmp, 'o.yml');
    fs.writeFileSync(overlay, '- id: o1\n  disabled: true');

    const { patches, files } = composeLayers({
      profileDir, bundleFile: bundle, homeDir: home, overlays: [overlay],
    });
    // 顺序 = bundle insert 的行 + u1 + h1 + o1
    expect(patches).toHaveLength(4);
    expect((patches[0] as { insert: unknown[] }).insert).toHaveLength(1);
    expect(patches.slice(1).map((p) => p.id)).toEqual(['u1', 'h1', 'o1']);
    expect(files).toHaveLength(4);
  });

  it('空用户层文件也被列入 watch 路径语义正确（内容为 undefined 但固定路径 watch 在 loader-boot 层）', () => {
    const bundle = path.join(tmp, 'b.yml');
    fs.writeFileSync(bundle, '- insert: []');
    const { patches } = composeLayers({ profileDir, bundleFile: bundle, homeDir: null });
    expect(patches).toHaveLength(1);
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
    const booted = await bootComposed({ profileDir, bundleFile: bundle, homeDir: null });
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
