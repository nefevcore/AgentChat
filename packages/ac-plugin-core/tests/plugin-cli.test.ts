// ============================================================
// plugin-cli.test.ts —— 作者工具链单测（cr-907 批5 切片一：init/publish 门禁/finalize）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledDoc } from '../src/installed.ts';
import { resetQueuesForTest } from '../src/fsx.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(REPO, 'scripts/plugin-cli.mjs');
const ROOT = path.join('sandbox', 'test-plugin-cli-' + process.pid);

beforeEach(() => { resetQueuesForTest(); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); resetQueuesForTest(); });

function cli(...args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });
}

describe('ac plugin 作者工具链（cr-907 批5 切片一）', () => {
  it('init：零 PLACEHOLDER 脚手架（ac 字段 + owner 工具名 + keywords 自标）', () => {
    const out = cli('init', 'my-demo', '--owner', 'helper', '--dir', path.join(ROOT, 'my-demo'));
    expect(out).toContain('helper-my-demo');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'my-demo', 'package.json'), 'utf-8'));
    expect(pkg.keywords).toContain('agentchat-plugin');
    expect(pkg.engines).toEqual({ node: '>=23', agentchat: '^2' });
    expect(pkg.ac.faces.node.entry).toBe('./src/index.ts');
    expect(pkg.ac.provides.tools).toEqual(['helper-my-demo']);
    const src = fs.readFileSync(path.join(ROOT, 'my-demo', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain("'helper'");
    expect(src).toContain('helper-my-demo');
    expect(src).not.toContain('PLACEHOLDER');
  });

  it('finalize：定型物化 = 统一安装器 + installed 行 owner 锚', () => {
    cli('init', 'fin-me', '--owner', 'dev-agent', '--dir', path.join(ROOT, 'fin-me'));
    const out = cli('finalize', path.join(ROOT, 'fin-me'), '--data-root', path.join(ROOT, 'root'), '--owner', 'dev-agent');
    expect(out).toContain('applied');
    const doc = readInstalledDoc(path.join(ROOT, 'root'));
    expect(doc).toHaveLength(1);
    expect(doc[0].owner).toBe('dev-agent');
    expect(doc[0].scope).toBe('shell');
  });

  it('publish 门禁：engines/keywords 违规 → 拒绝且不触 npm', () => {
    cli('init', 'bad', '--dir', path.join(ROOT, 'bad'));
    const pkgPath = path.join(ROOT, 'bad', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.keywords = []; // 摘自标 → 市场发现约定违规
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    let failed = false;
    try { cli('publish', '--dir', path.join(ROOT, 'bad'), '--dry'); } catch (e) { failed = true; }
    expect(failed).toBe(true);
  });
});

describe('ac plugin dev（cr-907 批5 切片二：watch 热试跑）', () => {
  it('装载冒烟通过（门禁 + 模块即插件契约 + apply 形状）；坏形状 fail-loud', async () => {
    const { spawn } = await import('node:child_process');
    cli('init', 'dev-me', '--dir', path.join(ROOT, 'dev-me'));
    const runCli = (args: string[]): Promise<{ out: string; code: number | null }> => new Promise((resolve) => {
      const p = spawn('node', [CLI, ...args]);
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { out += c; });
      p.on('close', (code) => resolve({ out, code }));
      setTimeout(() => p.kill(), 2500); // watch 进程收割（冒烟先于 watch）
    });
    const good = await runCli(['dev', '--dir', path.join(ROOT, 'dev-me')]);
    expect(good.out).toContain('装载冒烟通过');
    // 坏形状：摘 apply 导出 → 冒烟 fail-loud（首检退出非零）
    fs.writeFileSync(path.join(ROOT, 'dev-me', 'src', 'index.ts'), 'export const x = 1;' + String.fromCharCode(10));
    const bad = await runCli(['dev', '--dir', path.join(ROOT, 'dev-me')]);
    expect(bad.out).toContain('缺插件形状');
    expect(bad.code).not.toBe(0);
  }, 20000);
});
