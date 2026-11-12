// ============================================================
// migrate-agent-patch.test.ts —— 身份迁移脚本往返锁定（cr-906 批4 切片三 /
// cr-1004 批2 v2 档 / cr-1022 批2 v3 档：agent.json 档案 + agent.patch.yml
// v3 菜单片段〔行定义 + src-fingerprint + 基线戳〕；v2 输入经
// legacyToMenuDefs 桥换算，旧形态经 rowsToMenuDefs 正清单定义拷贝）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentConfig } from '../src/tree.ts';
import { readAgentPatchV3At, readAgentProfileAt, PATCH_FILE } from '../src/patch-doc.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = path.join('sandbox', 'test-migrate-script-' + process.pid);
const SCRIPT = path.join(REPO, 'scripts/migrate-agent-patch.mjs');

// 行 id 词形（cr-1022 批2：捆绑词 fs 退役——正清单点名行本身）
const alpha = { id: 'alpha', model: 'mock', rows: ['fs-tools', 'math'], access: 'full-access', system: '旧提示', settings: { memory: { depth: 2 } } };

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents/alpha'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/config.json'), JSON.stringify(alpha, null, 2));
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/preset-origin.json'), JSON.stringify({ template: 'standard', hash: 'h1' }));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(...args: string[]): string {
  return execFileSync('node', [SCRIPT, ROOT, ...args], { encoding: 'utf-8' });
}

describe('身份迁移脚本（cr-1022 批2 v3 目标态）', () => {
  it('正向：v3 菜单片段 + 档案 + 单元文件 + origin 并入 agent.json；config.json 原样保留', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    const v3 = readAgentPatchV3At(dir);
    expect(v3).not.toBeNull();
    expect(v3!.base).toMatch(/^[0-9a-f]{16}$/); // 基线戳取迁移时点
    // 定义拷贝：rows 正清单 → 出厂能力区定义 + src-fingerprint（词形 = 行 id）
    expect(v3!.defs.map((d) => d.id)).toEqual(['auto-title', 'fs-tools', 'math']); // auto-title = 旧席位词现为能力行——旧基础集恒并，逐位等价随迁
    expect(v3!.defs[0]!.name).toMatch(/^link:/); // 定义自带装载路径
    for (const def of v3!.defs) expect(v3!.fingerprints[def.id]).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8')).toContain('# ac-menu: 1');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true); // 旧读者窗口保留
    expect(fs.existsSync(path.join(dir, 'memory.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'preset-origin.json.migrated'))).toBe(true);
    const reread = readAgentConfig(ROOT, 'alpha');
    expect(reread?.model).toBe('mock');
    expect(reread?.access).toBe('full-access');
    expect(reread?.settings).toEqual({ memory: { depth: 2 } });
    expect(reread?.system).toBeUndefined();
    expect(readAgentProfileAt(dir)?.origin).toEqual({ template: 'standard', hash: 'h1' });
  });

  it('幂等重跑零变化；--rebase 重算基线戳并留一代备份；回退还原旧读窗口', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    const patchSnap = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
    run();
    expect(fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8')).toBe(patchSnap);
    // cr-1025 重写原子纪律：--rebase 重写前留一代备份
    expect(fs.existsSync(path.join(dir, PATCH_FILE + '.bak'))).toBe(false); // 幂等跳过无重写
    run('--rebase');
    expect(fs.existsSync(path.join(dir, PATCH_FILE + '.bak'))).toBe(true);
    expect(readAgentPatchV3At(dir)?.defs.map((d) => d.id)).toEqual(['auto-title', 'fs-tools', 'math']); // defs 不变
    run('--revert');
    expect(fs.existsSync(path.join(dir, PATCH_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'agent.json'))).toBe(false);
    // config.json 旧读窗口仍在——回退后身份可读（内容原样）
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))).toEqual(alpha);
    expect(readAgentConfig(ROOT, 'alpha')?.model).toBe('mock');
  });

  it('v2 输入经桥换算：基础集 ∩ 能力 ∪ 加法 − 停用（B−T 逐位等价）', () => {
    const dir = path.join(ROOT, 'agents/alpha');
    fs.rmSync(path.join(dir, 'config.json'));
    fs.rmSync(path.join(dir, 'preset-origin.json'));
    // v2 差量（无 ac-menu 头）：加法 fs-tools + 停用 math
    fs.writeFileSync(path.join(dir, PATCH_FILE),
      '# agent.patch —— 装配差量（cr-1004 批2）' + String.fromCharCode(10)
      + '# ac-base: abc123def4567890' + String.fromCharCode(10)
      + '- id: fs-tools' + String.fromCharCode(10)
      + '- id: math' + String.fromCharCode(10)
      + '  disabled: true' + String.fromCharCode(10), 'utf-8');
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'mock' }), 'utf-8');
    run();
    const v3 = readAgentPatchV3At(dir)!;
    expect(v3.defs.map((d) => d.id)).toContain('fs-tools'); // 加法 = 显式点名
    expect(v3.defs.map((d) => d.id)).not.toContain('math'); // 停用出局
    expect(v3.defs.map((d) => d.id)).not.toContain('sap-adt'); // 捆绑行不在旧基础集（缺省面排除）
    expect(v3.defs.map((d) => d.id)).toContain('browser'); // 非捆绑能力行 = 旧基础集恒并
    expect(v3.fingerprints['fs-tools']).toMatch(/^[0-9a-f]{16}$/);
  });
});
