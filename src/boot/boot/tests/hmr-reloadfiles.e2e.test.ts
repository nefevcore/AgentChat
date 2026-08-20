// ============================================================
// @agentchat/boot e2e：L1.5 ctx.hmr.reloadFiles（vendored 主动重载机器）
//
// vendored hmr 需要 --expose-internals（Node 内部 ESM loadCache），vitest
// worker 自身不暴露 → spawn 子进程跑 fixtures/hmr-reload-child.ts。
// 校验点（docs/restart-design.md §2.5/§2.6）：
//   · root: [] 时 hmr 服务保活（无被动 watch）
//   · reloadFiles：插件 fiber 重注册（新模块 apply 生效）+ 水位线推进
//   · externals 命中 → 拒绝并导向 system_restart（不再 loader.exit）
// ============================================================
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-hmr-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** bin/agentchat.js 同款 tsx 拉起（TSX_TSCONFIG_PATH 锚定仓库 tsconfig） */
function tsxImportUrl(): string {
  return pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('tsx')).href;
}

/** 子进程 env：剥离 vitest worker 注入的旗标（NODE_OPTIONS/VITEST_*），锚定仓库 tsconfig */
function cleanEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k.startsWith('VITEST_')) continue;
    if (v !== undefined) out[k] = v;
  }
  out.TSX_TSCONFIG_PATH = path.join(ROOT, 'tsconfig.json');
  return out;
}

interface ChildResult {
  count1: number;
  count2: number;
  reloadedOk: boolean;
  reloaded: string[];
  error: string | null;
  watermarkAdvanced: boolean;
  isLoadedFixture: boolean;
  externalsRejected: boolean;
}

function runChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childScript = path.join(ROOT, 'src', 'boot', 'boot', 'tests', 'fixtures', 'hmr-reload-child.ts');
  const mod = (name: string) => pathToFileURL(path.join(ROOT, 'node_modules', '@agentchat', name, 'lib', 'index.js')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-internals', '--import', tsxImportUrl(), childScript, tmp,
      mod('cordis-hmr'), mod('cordis-timer'),
    ], {
      cwd: ROOT,
      // 剥离 vitest worker 注入的运行时旗标（NODE_OPTIONS 等），子进程按纯 node 启动
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('L1.5 ctx.hmr.reloadFiles e2e（子进程 --expose-internals）', () => {
  it('宣告 → 插件重载生效（新模块代码运行）+ 水位线推进 + externals 拒绝', async () => {
    const { code, stdout, stderr } = await runChild();
    // 失败详情写盘（子进程输出含 GBK 控制台字节，直接进 expect 消息会破坏
    // vitest 的 sourcemap 解析——用文件 + 摘要代替内嵌）
    const dump = path.join(os.tmpdir(), 'agentchat-hmr-e2e-child.log');
    fs.writeFileSync(dump, `code=${code}\n--stdout--\n${stdout}\n--stderr--\n${stderr}`, 'utf8');
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `child did not print RESULT (code=${code}, details: ${dump})`).toBeDefined();
    const r = JSON.parse(line!.slice('RESULT '.length)) as ChildResult;

    // 首次装载：v1 apply 已跑（+1）
    expect(r.count1).toBe(1);
    // 宣告后重载：新模块 v2 生效（apply +10）
    expect(r.reloadedOk).toBe(true);
    expect(r.count2).toBe(11);
    expect(r.reloaded.length).toBe(1);
    expect(r.reloaded[0]).toContain('fixture.mjs');
    // 成功后水位线推进（下次扫描以此为界）
    expect(r.watermarkAdvanced).toBe(true);
    // 重载后 fixture 仍在 loadCache（新 job）
    expect(r.isLoadedFixture).toBe(true);
    // externals（worker 入口依赖树）命中 → 拒绝并导向 system_restart
    expect(r.externalsRejected).toBe(true);
  }, 90_000);
});
