// ============================================================
// shell-bundle.test.ts —— dev 壳 bundle 偏好链（cr-961 冷启 IO 治本）
// anchors 仓库形态 shellBoot：dist/shell.mjs 指纹新鲜 → bundle；漂移/
// 缺席 → 源码直载。devShellBundle 纯域注入（here + enabled）直测。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { devShellBundle, resolveAnchors } from '../anchors.ts';

const ROOT = path.join('sandbox', 'test-shellbundle-' + process.pid);
const HOST_DIR = path.join(ROOT, 'apps', 'host');
const DIST = path.join(ROOT, 'dist');
const INPUT = path.join(ROOT, 'apps', 'shell', 'boot.ts');

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 造最小「仓库」：dist/shell.mjs + 指纹旁车 + 一个输入源文件 */
function buildFakeRepo(): void {
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(path.dirname(INPUT), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'shell.mjs'), '// bundle');
  fs.writeFileSync(INPUT, 'export {};');
  const st = fs.statSync(INPUT);
  const rel = path.relative(ROOT, INPUT).replaceAll('\\', '/');
  fs.writeFileSync(path.join(DIST, 'shell.bundle.json'), JSON.stringify({
    version: 1,
    entries: [[rel, st.mtimeMs, st.size]],
  }));
}

describe('devShellBundle（cr-961 偏好链）', () => {
  it('指纹新鲜 → bundle 路径', () => {
    buildFakeRepo();
    fs.mkdirSync(HOST_DIR, { recursive: true });
    expect(devShellBundle(HOST_DIR, true)).toBe(path.resolve(DIST, 'shell.mjs'));
  });

  it('输入源码漂移（size 变）→ null（回落源码直载——改码自动回源）', () => {
    buildFakeRepo();
    fs.writeFileSync(INPUT, 'export {}; // edited');
    expect(devShellBundle(HOST_DIR, true)).toBeNull();
  });

  it('旁车缺席 / bundle 缺席 → null', () => {
    buildFakeRepo();
    fs.rmSync(path.join(DIST, 'shell.bundle.json'));
    expect(devShellBundle(HOST_DIR, true)).toBeNull();
    buildFakeRepo();
    fs.rmSync(path.join(DIST, 'shell.mjs'));
    expect(devShellBundle(HOST_DIR, true)).toBeNull();
  });

  it('enabled=false（测试环境缺省档）→ 恒 null', () => {
    buildFakeRepo();
    expect(devShellBundle(HOST_DIR, false)).toBeNull();
  });

  it('resolveAnchors 仓库形态：vitest 环境恒源码缺省（确定性——AGENTCHAT_EXE 同惯例）', () => {
    buildFakeRepo();
    fs.mkdirSync(HOST_DIR, { recursive: true });
    const anchors = resolveAnchors(HOST_DIR);
    expect(anchors.shellBoot).toBe(path.resolve(HOST_DIR, '../shell/boot.ts'));
  });

  it('resolveAnchors：AGENTCHAT_SHELL_BOOT env 覆盖一切缺省', () => {
    fs.mkdirSync(HOST_DIR, { recursive: true });
    const prev = process.env.AGENTCHAT_SHELL_BOOT;
    process.env.AGENTCHAT_SHELL_BOOT = 'X:\\custom\\shell.mjs';
    try {
      expect(resolveAnchors(HOST_DIR).shellBoot).toBe('X:\\custom\\shell.mjs');
    } finally {
      if (prev === undefined) delete process.env.AGENTCHAT_SHELL_BOOT;
      else process.env.AGENTCHAT_SHELL_BOOT = prev;
    }
  });
});
