// ============================================================
// cutover-watch.mjs —— 切换守候器（8.9 cr-556）
//
// 老宿主的会话 Agent 不能杀自己宿主——本脚本 detached 独立运行：
//   armed（写 preview/sandbox/cutover-armed.json）→ 循环探测数据根零占用
//   （判据单一来源 = cutover-guard：旧宿主树 + 新宿主 + 主线数据根锁）
//   → 30s 复核（防临时重启误切）→ node scripts/cutover.mjs --stage archive
//   → node scripts/cutover.mjs（全程）。
//
// cr-557：旧版只认旧宿主树（src.supervisor.mjs / ac-app boot），用户停宿主后
// 顺手 `pnpm dev` 拉起的新宿主（preview/apps/host/boot.ts）对它完全隐形——
// 复核「通过」52ms 后就对着活宿主 rename（EBUSY）。
// 取消 = 删 preview/sandbox/cutover-armed.json（守候器每 5s 检查，armed 消失即静默退出）。
// 日志：preview/sandbox/cutover-watch.log（循环追加）。
// ============================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBlockers } from './cutover-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARMED = path.join(ROOT, 'preview', 'sandbox', 'cutover-armed.json');
const LOG = path.join(ROOT, 'preview', 'sandbox', 'cutover-watch.log');
const CUTOVER = path.join(ROOT, 'scripts', 'cutover.mjs');

const log = (m) => appendFileSync(LOG, `[watch ${new Date().toISOString()}] ${m}\n`);

mkdirSync(path.dirname(LOG), { recursive: true }); // 日志/armed 目录按需建（沙盒/干净检出也能起）
writeFileSync(ARMED, JSON.stringify({ at: new Date().toISOString(), note: '老宿主退出后自动切换；取消 = 删本文件' }, null, 2));
log('armed：等待老宿主树退出（取消 = 删 ' + ARMED + '）');

// 数据根占用判据（单一来源 = cutover-guard；ROOT 下正式数据根）
const DATA_ROOT = path.join(ROOT, 'workspace', 'home');
const busy = () => describeBlockers(DATA_ROOT);

// 主循环：每 5s 查 armed 与占用，零占用后 30s 复核
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  if (!existsSync(ARMED)) { log('armed 文件已删——取消守候，退出'); process.exit(0); }
  if (busy() !== null) continue;
  // 零占用：可能 armed 前就已停，也可能是宿主树刚退出——一律 30s 复核
  log('数据根已零占用——30s 复核（若重新拉起将自动取消）');
  await new Promise((r) => setTimeout(r, 30000));
  if (!existsSync(ARMED)) { log('armed 已删——取消'); process.exit(0); }
  const b1 = busy();
  if (b1 !== null) {
    log('复核发现数据根重新被占用——视为非切换意图，取消守候：\n' + b1);
    rmSync(ARMED, { force: true });
    process.exit(0);
  }
  break;
}

// 执行切换（两段：archive + 全程）——日志续写 watch.log
log('复核通过——执行 cutover（--stage archive）');
{ const r = spawnSync(process.execPath, [CUTOVER, '--stage', 'archive'], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  log(r.stdout || ''); if (r.stderr) log('[stderr] ' + r.stderr);
  if (r.status !== 0) { log('archive 段失败（exit ' + r.status + '）——中止'); process.exit(1); } }
log('archive 段完成——续跑全程');
{ const r = spawnSync(process.execPath, [CUTOVER], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  log(r.stdout || ''); if (r.stderr) log('[stderr] ' + r.stderr);
  log('cutover 全程 exit=' + r.status); }