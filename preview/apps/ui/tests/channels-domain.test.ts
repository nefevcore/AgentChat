// @vitest-environment jsdom
// ============================================================
// channels-domain.test.ts —— 25 域行通道包对账（8.5c）
//
// ① catalog ui 域 25 行 ↔ channel/ 25 通道包一一对应；
// ② 每包 manifest 过 checkUiManifest + 深路径 channelImports 键在
//    sharedModules() 有对应宿主实例（importmap 可解析）；
// ③ 生成器快照 vs 仓库现状（gen --check 同逻辑的测试面）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUiManifest } from 'ac-webui-core';
import { sharedModules } from '../client/shared-modules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, '..');
const channelRoot = join(uiRoot, 'channel');

const SKELETON4 = ['conversation', 'tool', 'settings', 'markdown-render'];
const domainDirs = readdirSync(channelRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !SKELETON4.includes(e.name))
  .map((e) => e.name).sort();

describe('8.5c · 25 域行通道包', () => {
  it('数量对账：channel/ 域包 25 个（+ 骨架 4）', () => {
    expect(domainDirs.length).toBe(25);
    expect(readdirSync(channelRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).length).toBe(29);
  });

  it('通道包自洽：目录名词表稳定（cr-701 撤 catalog ui 声明行——对账面收敛为通道包自身）', () => {
    // 25 域词表快照（防通道包增删漂移；装载面恒在 webui 行 boot graph）
    expect(domainDirs.join(',')).toBe([
      'agents', 'browser', 'desktop-storage', 'fs', 'goal', 'group', 'jobs', 'llm-pool',
      'onboarding', 'plugin-registry', 'remote', 'run-code', 'run-nodes', 'runview',
      'search-pool', 'shell', 'singles', 'skill', 'subagent', 'system',
      'timer', 'todo', 'usage', 'web', 'workspace',
    ].join(','));
  });

  it('每包 manifest 过校验 + index.ts re-export 主线 clientPlugin', () => {
    for (const name of domainDirs) {
      const m = JSON.parse(readFileSync(join(channelRoot, name, 'manifest.json'), 'utf-8'));
      const check = checkUiManifest(m);
      expect(check.warnings, name + ': ' + check.warnings.join('；')).toEqual([]);
      expect(m.isolated).toBe(false);
      const idx = readFileSync(join(channelRoot, name, 'src', 'index.ts'), 'utf-8');
      expect(idx).toContain("from 'ac-client-ui-" + name + "/client'");
      expect(idx).toMatch(/export default \w+[Pp]lugin/);
    }
  });

  it('深路径 channelImports 键在 sharedModules 有宿主实例（importmap 可解析）', () => {
    const host = sharedModules();
    const hostKeys = new Set([
      ...Object.keys(host),
      'vue', 'pinia', '@agentchat/cordis', 'ac-client-runtime', 'ac-client-slots',
      '@agentchat/webui-kit',
      'ac-client-ui-theme/client', 'ac-client-ui-renderer/client', 'ac-client-ui-layout/client',
    ]);
    for (const name of domainDirs) {
      const m = JSON.parse(readFileSync(join(channelRoot, name, 'manifest.json'), 'utf-8'));
      for (const ci of m.channelImports as string[]) {
        expect(hostKeys.has(ci), name + ' 的外部化键缺宿主实例：' + ci).toBe(true);
      }
    }
  });

  it('package.json 依赖只引 ac-client-runtime 与主线包（workspace 链接面最小）', () => {
    for (const name of domainDirs) {
      const pj = JSON.parse(readFileSync(join(channelRoot, name, 'package.json'), 'utf-8'));
      expect(Object.keys(pj.dependencies).sort()).toEqual(['ac-client-runtime', 'ac-client-ui-' + name].sort());
    }
  });
});
