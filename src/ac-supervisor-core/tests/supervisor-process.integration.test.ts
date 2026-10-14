// ============================================================
// 驱动真实 src/supervisor.mjs 的进程级集成测试（cr-428）
//
// 起因：supervisor.mjs startChild 曾每次 spawn 全量重置 policyState，
// 指数退避恒 1.5s、熔断永不可达——纯库（本包）测试全绿但从未覆盖进程
// 层接线，bug 因此长期存活。本测试补上这一层：运行时读取当前
// supervisor.mjs 源码，仅替换 WORKER_ENTRY 一行后写临时副本并 spawn
// （副本每轮从真身刷新，无漂移；不改生产脚本加测试旋钮）。worker 桩
// 即刻 exit 1（启动期崩溃），断言退避数列 1.5→3→6→12s 递增且第 5 次
// 崩溃熔断退出 code=1。jitter ±20% 下相邻档不重叠（max(1.5)=1.8 <
// min(3)=2.4），d2 > 2.0 即可无 flake 区分新旧行为。
// 隔离：副本与其 .runtime 锁、数据根全部落在测试进程 cwd 下的临时目录
//（workspace/test 分桶内——'ac-supervisor-core' 裸导入经仓库根
// node_modules 仍可解析）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SUPERVISOR_SRC = join(REPO_ROOT, 'src', 'supervisor.mjs');

function parseDelays(out: string): number[] {
  const delays: number[] = [];
  for (const m of out.matchAll(/第 \d+ 次监护决策 → ([\d.]+)s 后重拉/g)) {
    delays.push(Number(m[1]));
  }
  return delays;
}

describe('supervisor.mjs 进程层监护接线', () => {
  it('崩溃退避跨代递增（1.5→3→6→12s），第 5 次崩溃熔断退出 code=1', async () => {
    const dir = await mkdtemp(join(process.cwd(), 'sup-probe-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      // 真身源码 → 临时副本：仅替换 worker 入口（替换命中数=1，上游改行即 fail-loud）
      const original = await readFile(SUPERVISOR_SRC, 'utf-8');
      const probeEntry = "const WORKER_ENTRY = path.join(TRACK_DIR, 'worker.mjs');";
      const from = "const WORKER_ENTRY = path.join(TRACK_DIR, 'ac-app', 'src', 'boot.ts');";
      if (original.split(from).length !== 2) {
        throw new Error('supervisor.mjs 的 WORKER_ENTRY 行已变动——请同步本测试的替换锚点');
      }
      const probeScript = original.replace(from, probeEntry);
      const scriptPath = join(dir, 'supervisor-probe.mjs');
      await writeFile(scriptPath, probeScript);
      await writeFile(join(dir, 'worker.mjs'), "console.log('[probe-worker] 启动期崩溃'); process.exit(1);\n");

      const exitCode = await new Promise<number>((resolve, reject) => {
        child = spawn(process.execPath, [scriptPath], {
          cwd: dir,
          env: { ...process.env, AGENTCHAT_DATA_ROOT: join(dir, 'data') },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout!.on('data', (c) => { out += c; });
        child.stderr!.on('data', (c) => { out += c; });
        child.on('error', reject);
        child.on('close', (code) => {
          try {
            const delays = parseDelays(out);
            // 退避数列：4 次重拉决策（jitter ±20% → ±25% 容差窗），档间严格递增
            expect(delays).toHaveLength(4);
            const expected = [1.5, 3, 6, 12];
            for (let i = 0; i < expected.length; i++) {
              expect(delays[i]).toBeGreaterThanOrEqual(expected[i] * 0.75);
              expect(delays[i]).toBeLessThanOrEqual(expected[i] * 1.25);
            }
            // 回归判别式：旧 bug（状态重置）下 d2 ≤ 1.8；修复后 d2 ≥ 2.4
            expect(delays[1]).toBeGreaterThan(2);
            // 熔断：窗口内第 5 次崩溃 → supervisor 以 code=1 退出（而非无限重拉）
            expect(out).toContain('熔断');
            resolve(code ?? -1);
          } catch (err) {
            reject(new Error(`断言失败，supervisor 输出:\n${out}\n${(err as Error).message}`));
          }
        });
      });
      expect(exitCode).toBe(1);
    } finally {
      child?.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
