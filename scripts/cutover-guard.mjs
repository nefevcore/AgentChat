// ============================================================
// cutover-guard.mjs —— 切换前置判据：「数据根被谁占着」（cr-557）
//
// cr-556 的失败现场：--stage archive 只有 existsSync + rename，一次 EBUSY 即
// 判死；守候器的复核又只认旧宿主树（src.supervisor.mjs / ac-app/src/boot），
// 用户停旧宿主后顺手 `pnpm dev` 拉起的新宿主（preview/apps/host/boot.ts
// --data-root workspace/home）对它完全隐形 —— 复核「通过」52ms 后就对一个
// 活着的宿主 rename 数据根。
//
// 本模块是这条路线上的唯一判据（三处消费：封存闸、全程停机闸、守候器复核），
// 口径两条：
//   · 进程：任一本仓宿主形态在跑（旧 boot / 旧 supervisor / 新 supervisor /
//     新 boot / bin 入口）。旧宿主的数据根来自 AGENTCHAT_DATA_ROOT 环境变量，
//     命令行里看不到路径——按「宿主形态」全量拦是唯一可靠超集。
//   · 锁：<root>/.data-root.lock 的持锁 pid 仍活（主线独占锁）。新宿主尚不取
//     锁，故进程面判据不可省；陈旧锁（pid 已死）= 无人占用，主线启动时自然
//     回收，不算占用。
// 只判占用、不负责杀：停宿主是用户的动作。
// ============================================================
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 宿主形态标记（命令行片段；小写比较、反斜杠归一） */
const HOST_MARKERS = [
  'preview/apps/host/boot.ts',
  'ac-app/src/boot.ts',
  'supervisor.mjs',
  'bin/agentchat.js',
  'dev:supervised',
];

/** 进程存活探测（EPERM = 存在但无权限 → 仍视为活） */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 扫描本仓宿主形态的 node 进程。
 * 判据是命令行形态而非数据根路径（见文件头）；cutover 自身/守候器排除。
 */
export function scanHostProcesses() {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf-8' });
  if (ps.status !== 0) return [];
  const raw = (ps.stdout || '').trim();
  if (raw === '') return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const row of rows) {
    if (typeof row.CommandLine !== 'string') continue;
    const norm = row.CommandLine.replace(/\\/g, '/').toLowerCase();
    if (norm.includes('cutover')) continue;
    if (!HOST_MARKERS.some((m) => norm.includes(m))) continue;
    out.push({ pid: row.ProcessId, cmd: row.CommandLine });
  }
  return out;
}

/** 数据根锁的活持有者 pid（陈旧锁/无锁 → null） */
export function dataRootLockHolder(rootDir) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(rootDir, '.data-root.lock'), 'utf-8'));
  } catch {
    return null;
  }
  const pid = info === null || typeof info !== 'object' ? null : info.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  return isAlive(pid) ? pid : null;
}

/**
 * 数据根占用清单：零占用 → null；否则返回人类可读的多行明细（直接进失败报告）。
 */
export function describeBlockers(rootDir) {
  const hosts = scanHostProcesses();
  const lockPid = dataRootLockHolder(rootDir);
  if (hosts.length === 0 && lockPid === null) return null;
  const lines = hosts.map((h) => `宿主进程 ${h.pid}：${h.cmd}`);
  if (lockPid !== null) lines.push(`数据根锁持有者 pid ${lockPid}：${path.join(rootDir, '.data-root.lock')}`);
  return lines.join('\n');
}
