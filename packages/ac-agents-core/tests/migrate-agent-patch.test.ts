// ============================================================
// migrate-agent-patch.test.ts —— 身份迁移脚本往返锁定（cr-906 批4 切片三）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentConfig } from '../src/tree.ts';
import { readAgentPatch, PATCH_FILE } from '../src/patch-doc.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = path.join('sandbox', 'test-migrate-script-' + process.pid);
const SCRIPT = path.join(REPO, 'scripts/migrate-agent-patch.mjs');

const alpha = { id: 'alpha', model: 'mock', rows: ['fs'], tags: ['full-access'], system: '旧提示', settings: { memory: { depth: 2 } } };

beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, 'agents/alpha'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/config.json'), JSON.stringify(alpha, null, 2));
  fs.writeFileSync(path.join(ROOT, 'agents/alpha/preset-origin.json'), JSON.stringify({ template: 'standard', hash: 'h1' }));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(...args: string[]): string {
  return execFileSync('node', [SCRIPT, ROOT, ...args], { encoding: 'utf-8' });
}

describe('身份迁移脚本（cr-906 批4 切片三）', () => {
  it('正向：patch + 单元文件 + origin 并入；readAgentConfig 投影等价（system 退役缺席）', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    expect(fs.existsSync(path.join(dir, PATCH_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'memory.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'preset-origin.json.migrated'))).toBe(true);
    const reread = readAgentConfig(ROOT, 'alpha');
    expect(reread?.model).toBe('mock');
    expect(reread?.tags).toEqual(['full-access']);
    expect(reread?.settings).toEqual({ memory: { depth: 2 } });
    expect(reread?.system).toBeUndefined();
    expect(readAgentPatch(ROOT, 'alpha')?.origin).toEqual({ template: 'standard', hash: 'h1' });
  });

  it('幂等重跑零变化；回迁还原旧形态（可逆判据）', () => {
    run();
    const dir = path.join(ROOT, 'agents/alpha');
    const patchSnap = fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8');
    run();
    expect(fs.readFileSync(path.join(dir, PATCH_FILE), 'utf-8')).toBe(patchSnap);
    run('--revert');
    expect(fs.existsSync(path.join(dir, PATCH_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'memory.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'preset-origin.json'), 'utf-8'))).toEqual({ template: 'standard', hash: 'h1' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))).toEqual(alpha);
  });
});
