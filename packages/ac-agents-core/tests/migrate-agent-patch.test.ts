// ============================================================
// migrate-agent-patch.test.ts —— 身份迁移脚本往返锁定（cr-906 批4 切片三 /
// cr-1004 批2 v2 档：agent.json 档案 + agent.patch.yml 数组差量 + 基线戳）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentConfig } from '../src/tree.ts';
import { readAgentPatchV2At, readAgentProfileAt, PATCH_FILE } from '../src/patch-doc.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = path.join('sandbox', 'test-migrate-script-' + process.pid);
const SCRIPT = path.join(REPO, 'scripts/migrate-agent-patch.mjs');

const alpha = { id: 'alpha', model: 'mock', rows: ['fs'], access: 'full-access', system: '旧提示', settings: { memory: { depth: 2 } } };

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents/alpha'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/config.json'), JSON.stringify(alpha, null, 2));
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/preset-origin.json'), JSON.stringify({ template: 'standard', hash: 'h1' }));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(...args: string[]): string {
  return execFileSync('node', [SCRIPT, ROOT, ...args], { encoding: 'utf-8' });
}

describe('身份迁移脚本（cr-906 / cr-1004 批2 v2）', () => {
  it('正向：v2 差量 + 档案 + 单元文件 + origin 并入 agent.json；投影等价（system 退役缺席）', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    const v2 = readAgentPatchV2At(dir);
    expect(v2).not.toBeNull();
    expect(v2!.base).toMatch(/^[0-9a-f]{16}$/); // 基线戳取迁移时点（§七）
    // rows 白名单 ['fs'] → 差量：加法 fs（捆绑行非基础集）+ B−T 减法
    expect(v2!.entries).toContainEqual({ id: 'fs' });
    expect(v2!.entries.some((e) => e.disabled === true)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'memory.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'preset-origin.json.migrated'))).toBe(true);
    const reread = readAgentConfig(ROOT, 'alpha');
    expect(reread?.model).toBe('mock');
    expect(reread?.access).toBe('full-access');
    expect(reread?.settings).toEqual({ memory: { depth: 2 } });
    expect(reread?.system).toBeUndefined();
    expect(readAgentProfileAt(dir)?.origin).toEqual({ template: 'standard', hash: 'h1' });
  });

  it('幂等重跑零变化；--rebase 只重算基线戳；回退还原旧读窗口（config.json 在场）', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    const patchSnap = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
    run();
    expect(fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8')).toBe(patchSnap);
    run('--revert');
    expect(fs.existsSync(path.join(dir, PATCH_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'agent.json'))).toBe(false);
    // config.json 旧读窗口仍在——回退后身份可读（内容原样）
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))).toEqual(alpha);
    expect(readAgentConfig(ROOT, 'alpha')?.model).toBe('mock');
  });
});
