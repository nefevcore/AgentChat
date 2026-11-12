// ============================================================
// config-migration.test.ts —— 行内 config 惰性迁移（cr-1037 批2）
//
// 两路径验收：无损边逐边升级落盘 / 缺边 legacy 明示；notice 单通道。
// 数据根纪律：恒 sandbox/ 独立目录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseShellArgs, deriveAndAssertRowset,
} from '../boot.ts';
import { readAgentConfig, writeAgentConfig, writeAgentPatchV3At, readAgentPatchV3At, rowsToMenuDefs, CONFIG_VERSION_KEY, LEGACY_KEY, type ConfigMigrationEdge } from 'ac-agents-core';
import { readCatalog } from 'ac-rowset-core';

const ROOT = path.join('sandbox', 'test-config-mig-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 播种带行 config 的 v3 身份（rows 点名 browser 行 + 手写 config） */
function seedWithConfig(agentId: string, config: Record<string, unknown>): void {
  writeAgentConfig(ROOT, { id: agentId, model: 'test-model' });
  // 改写 browser 行定义为带 config 形态（模拟用户设置过档位）
  const v3 = readAgentPatchV3At(path.join(ROOT, 'agents', agentId));
  const defs = v3?.defs.map((d) => d.id === 'browser' ? { ...d, config } : d) ?? [];
  const fingerprints = v3?.fingerprints ?? {};
  writeAgentPatchV3At(path.join(ROOT, 'agents', agentId), defs, fingerprints);
}

describe('cr-1037 批2：boot config 惰性迁移', () => {
  it('无损路径：v0 存量经链逐边升级 + configVersion 戳 + notice', () => {
    seedWithConfig('a1', { oldLevel: 'full' });
    const chain: ConfigMigrationEdge[] = [
      { from: 0, to: 1, migrate: (c) => ({ browserLevel: c.oldLevel }) },
    ];
    const out = deriveAndAssertRowset(ROOT, 'a1', path.join(ROOT, 'row-catalog.json'), undefined, { browser: chain });
    expect(out.notices.some((n) => n.includes('config 迁移') && n.includes('browser') && n.includes('v0→v1'))).toBe(true);
    // 落盘核验：迁移后 config 已写回 agent.patch.yml
    const v3 = readAgentPatchV3At(path.join(ROOT, 'agents', 'a1'));
    const browser = v3?.defs.find((d) => d.id === 'browser');
    expect(browser?.config).toEqual({ browserLevel: 'full', [CONFIG_VERSION_KEY]: 1 });
  });

  it('缺边路径：链不完备 → config.legacy + 手动重设 notice', () => {
    seedWithConfig('a2', { oldLevel: 'full' });
    const broken: ConfigMigrationEdge[] = [
      { from: 1, to: 2, migrate: (c) => c }, // 缺 v0→v1
    ];
    const out = deriveAndAssertRowset(ROOT, 'a2', path.join(ROOT, 'row-catalog.json'), undefined, { browser: broken });
    expect(out.notices.some((n) => n.includes('config.legacy') && n.includes('browser'))).toBe(true);
    const v3 = readAgentPatchV3At(path.join(ROOT, 'agents', 'a2'));
    const browser = v3?.defs.find((d) => d.id === 'browser');
    expect(browser?.config).toEqual({ [LEGACY_KEY]: { oldLevel: 'full' }, [CONFIG_VERSION_KEY]: 2 });
  });

  it('无链注入 = 零迁移（缺省参数向后兼容）', () => {
    seedWithConfig('a3', { level: 'full' });
    const out = deriveAndAssertRowset(ROOT, 'a3', path.join(ROOT, 'row-catalog.json'));
    expect(out.notices.some((n) => n.includes('config 迁移'))).toBe(false);
    const v3 = readAgentPatchV3At(path.join(ROOT, 'agents', 'a3'));
    expect(v3?.defs.find((d) => d.id === 'browser')?.config).toEqual({ level: 'full' });
  });

  it('已最新 = 幂等不重复迁移', () => {
    seedWithConfig('a4', { browserLevel: 'full', [CONFIG_VERSION_KEY]: 1 });
    const chain: ConfigMigrationEdge[] = [
      { from: 0, to: 1, migrate: (c) => ({ browserLevel: c.oldLevel }) },
    ];
    const out = deriveAndAssertRowset(ROOT, 'a4', path.join(ROOT, 'row-catalog.json'), undefined, { browser: chain });
    expect(out.notices.some((n) => n.includes('config 迁移'))).toBe(false);
  });

  it('端到端：用户层 config 未知键 warn + 链迁移同 boot 共存（批3c）', () => {
    seedWithConfig('a5', { oldLevel: 'full' });
    // 用户全局差量层（catalogFile 用仓库静态资产——profile/ 基座新名在场，
    // 不触发基座旧名回退撞差量层的潜伏坑；数据根侧基座缺席 + 差量层在场
    // 的撞名面另案裁决，不在本 CR）
    fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'profile', 'shell.patch.yml'),
      "- id: browser\n  config:\n    extra: true\n");
    const chain: ConfigMigrationEdge[] = [
      { from: 0, to: 1, migrate: (c) => ({ browserLevel: c.oldLevel }) },
    ];
    const out = deriveAndAssertRowset(ROOT, 'a5', CATALOG, undefined, { browser: chain });
    // 迁移 notice 在场（链迁移走通）
    expect(out.notices.some((n) => n.includes('config 迁移') && n.includes('v0→v1'))).toBe(true);
    // 用户层合入成功：无「未命中菜单」降级（extra 合入的是内存菜单——layer 应用不回写盘）
    expect(out.notices.some((n) => n.includes('未命中菜单'))).toBe(false);
    expect(out.rowIds).toContain('browser');
  });
});