// ============================================================
// ac-app/src/orphans.ts —— 启动期孤儿进程对账清扫
//
// cr-382（shell-orphan-process-postmortem 建议三）：宿主死亡时 shell
// 子进程没有 OS 级生命周期绑定（无 Job Object），前台命令又零留痕——
// 重启后没有任何一方回收上一世的孤儿 pwsh。本模块在启动早期枚举进程，
// 按命令行指纹命中 + 双护栏（父进程已死 & 启动早于本次 boot）判定为
// 上一世孤儿，taskkill /T /F（fire-and-forget——杀不死的下一世 boot 会
// 再次命中，自愈闭环）。
//
// 护栏必要性（postmortem 建议三原文）：
//   ① 父 pid 已不存在——否则会误杀并行运行的其他实例的活子进程；
//   ② 启动时间早于本次 boot——本实例自己刚 spawn 的子进程可能恰好
//      命中指纹（枚举期间父进程退出存在竞态）。
// 两条全过才动手；AGENTCHAT_ORPHAN_REAP=off 整体关闭。
//
// 归位说明：对账是宿主 boot 职责（boot.ts / bootstrap.ts 两形态共用），
// 住 ac-app；曾试放 ac-supervisor-core（纯决策库、无 spawn）与其包定
// 位冲突。
// ============================================================
import { spawn, spawnSync } from 'node:child_process';

// AgentChat shell 命令指纹：shells.ts 的 spec.args（-NoProfile -Command）+
// preparePwsh 注入的 UTF-8 前缀拼出的命令行前缀形状。pwsh 与 powershell.exe
// 回退共用同一形状；其他 harness 的变体前缀（如 UTF8Encoding::new($false)）
// 不命中——只清自己的。
const SHELL_FINGERPRINT = '-NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';

interface ProcInfo {
  pid: number;
  ppid: number;
  startedAt: number;
  cmdline: string;
}

/** 枚举 pwsh/powershell 进程（pid/ppid/命令行/启动时间）；非 win 返回空 */
function listShellProcesses(): ProcInfo[] {
  const query = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'pwsh.exe\' or Name=\'powershell.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToString(\'o\'))`t$($_.CommandLine)" }',
    ],
    { encoding: 'utf-8', timeout: 15000, windowsHide: true },
  );
  if (query.error || query.status !== 0) return [];
  const out: ProcInfo[] = [];
  for (const line of String(query.stdout).split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    // 命令行本身可含制表符——第 4 列起整体归并
    out.push({ pid, ppid, startedAt: Date.parse(fields[2]) || 0, cmdline: fields.slice(3).join('\t') });
  }
  return out;
}

/** 进程是否存活（kill(pid, 0)：EPERM = 存在但无权限，同 isProcessAlive 语义） */
function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 是否上一世孤儿：指纹命中 + 父已死 + 早于本次 boot（双护栏） */
export function isOrphanCandidate(p: Pick<ProcInfo, 'ppid' | 'startedAt' | 'cmdline'>, bootAt: number): boolean {
  if (!p.cmdline.includes(SHELL_FINGERPRINT)) return false;
  if (isAlive(p.ppid)) return false;
  return p.startedAt > 0 && p.startedAt < bootAt;
}

export interface ReapResult {
  /** true = 开关关闭或平台不符，零动作 */
  skipped: boolean;
  /** 已发出 taskkill 的孤儿（pid + 命令行摘要；调用方负责落日志留痕） */
  reaped: Array<{ pid: number; cmdline: string }>;
}

/**
 * 启动期对账：枚举 → 指纹 + 双护栏 → taskkill /T /F（fire-and-forget）。
 * AGENTCHAT_ORPHAN_REAP=off → skipped: true。
 */
export function reapOrphanProcesses(bootAt: number): ReapResult {
  if (process.env.AGENTCHAT_ORPHAN_REAP === 'off' || process.platform !== 'win32') {
    return { skipped: true, reaped: [] };
  }
  const reaped: ReapResult['reaped'] = [];
  for (const p of listShellProcesses()) {
    if (!isOrphanCandidate(p, bootAt)) continue;
    spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true, stdio: 'ignore' });
    reaped.push({ pid: p.pid, cmdline: p.cmdline });
  }
  return { skipped: false, reaped };
}
