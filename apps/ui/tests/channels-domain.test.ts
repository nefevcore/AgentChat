// @vitest-environment jsdom
// ============================================================
// channels-domain.test.ts —— 域行通道包对账（8.5c；cr-920 通道壳退役：
// 对账对象 = packages/ac-client-ui-* 真身包的 ac.faces.web 声明）
//
// ① 26 域行 + 骨架 4 件 = 30 包词表稳定；
// ② 每包 ac.faces.web 经 readChannelManifest（package 形态真路径）投影
//    过 checkUiManifest；
// ③ 说明符对账：client 源裸说明符 ⊆ 宿主模块表 ∪ 包依赖声明——宿主表
//    面 = 外部化（importmap 解析宿主实例），依赖声明面 = 可打包进产物
//    （非共享单例；R1 未声明依赖另有 check-deps 门）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUiManifest, readChannelManifest } from 'ac-webui-core';
import { HOST_MODULE_SPECS } from '../scripts/host-module-table.ts';
import { sharedModules } from '../client/shared-modules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, '..');
const pkgRoot = join(uiRoot, '..', '..', 'packages');
const PKG_PREFIX = 'ac-client-ui-';

const webPackages = readdirSync(pkgRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith(PKG_PREFIX))
  .filter((e) => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, e.name, 'package.json'), 'utf-8'));
    return pkg.ac?.faces?.web !== undefined;
  })
  .map((e) => e.name.slice(PKG_PREFIX.length)).sort();

const SKELETON4 = ['conversation', 'tool', 'settings', 'markdown-render'];
const domainDirs = webPackages.filter((n) => !SKELETON4.includes(n));

describe('8.5c / cr-920 · 30 通道包（真身包直构）', () => {
  it('数量对账：域包 26 个（+ 骨架 4）', () => {
    expect(domainDirs.length).toBe(26);
    expect(webPackages.length).toBe(30);
  });

  it('包词表稳定（cr-701 撤 catalog ui 声明行——对账面收敛为包自身）', () => {
    // 26 域词表快照（cr-765 #4 新增 ask；防通道包增删漂移；装载面恒在 webui 行 boot graph）
    expect(domainDirs.join(',')).toBe([
      'agents', 'ask', 'browser', 'desktop-storage', 'fs', 'goal', 'group', 'jobs', 'llm-pool',
      'onboarding', 'plugin-registry', 'remote', 'run-code', 'run-nodes', 'runview',
      'search-pool', 'shell', 'singles', 'skill', 'subagent', 'system',
      'timer', 'todo', 'usage', 'web', 'workspace',
    ].join(','));
  });

  it('每包 ac.faces.web 经 readChannelManifest（package 形态真路径）过校验', () => {
    for (const name of webPackages) {
      const read = readChannelManifest(join(pkgRoot, PKG_PREFIX + name));
      expect(read, name + ': 应有 web 面').not.toBeNull();
      expect(read?.form, name).toBe('package');
      const check = checkUiManifest(read!.manifest);
      expect(check.warnings, name + ': ' + check.warnings.join('；')).toEqual([]);
      expect(read!.manifest.name, name + ': 投影 name = 包名').toBe(PKG_PREFIX + name);
    }
  });

  it('client 源跨包说明符：宿主表覆盖（外部化）或包依赖已声明（可打包）', () => {
    const covered = new Set([...Object.keys(sharedModules()), 'vue', 'pinia', '@agentchat/cordis', 'ac-client-runtime', 'ac-client-slots', '@agentchat/webui-kit']);
    const hostKeys = new Set([...covered, ...HOST_MODULE_SPECS]);
    const drift: string[] = [];
    for (const name of webPackages) {
      const deps = new Set(Object.keys(JSON.parse(readFileSync(join(pkgRoot, PKG_PREFIX + name, 'package.json'), 'utf-8')).dependencies ?? {}));
      const selfName = PKG_PREFIX + name;
      const depCovered = (spec: string) => {
        if (spec === selfName || spec.startsWith(selfName + '/')) return true; // 包自引（exports 自引用合法）
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        return deps.has(pkgName);
      };
      const root = join(pkgRoot, PKG_PREFIX + name, 'client');
      const walk = (p: string) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const full = join(p, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(ts|vue)$/.test(e.name)) {
            const text = readFileSync(full, 'utf-8');
            // 行首 import/export...from + 动态 import（.vue 模板属性 from=/class= 不算）
            const specs = new Set<string>();
            for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
            for (const m of text.matchAll(/(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
            for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
            for (const spec of specs) {
              if (spec.startsWith('.') || spec.startsWith('#')) continue;
              if (!hostKeys.has(spec) && !depCovered(spec)) drift.push(name + ' → ' + spec);
            }
          }
        }
      };
      walk(root);
    }
    expect(drift, drift.slice(0, 20).join('\n')).toEqual([]);
  });
});
