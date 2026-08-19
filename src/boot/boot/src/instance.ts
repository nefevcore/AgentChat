// ============================================================
// @agentchat/boot/src/instance.ts —— 实例注册表（P2 多入口共享后端）
//
// docker daemon/cli 模式：`agentchat web`（owner）boot 组合树并写注册表；
// `agentchat headless`（client）读注册表、连 WS、不 boot 组合树。
//
//   workspace/instance.json
//     { pid, port, profile, workspaceDir, startedAt, nodeVersion }
//
// 生命周期：
//   · 写：boot-finalize 收尾（owner 装配完成后）
//   · 删：gracefulShutdown（优雅退出）；崩溃残留由 pid 活性检查兜底
//   · 门禁：owner boot 前发现活实例 → 拒绝启动（不做隐式 boot/双 owner）
//
// 与 timer-instance.lock 的关系：锁保护"定时调度单执行"（测试进程 vs
// 常驻实例的实测场景仍在保护），注册表保护"组合树唯一 owner + 客户端发现"。
// 两者职责不同，迁移窗口内并存（旧实例不写注册表）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { workspaceRoot } from './loader';

/** 注册表文件名（workspace 目录内） */
export const INSTANCE_FILENAME = 'instance.json';

// ---- boot profile 模块级 holder ----
// cordis Context 代理对未注入属性的读取直接抛错（"cannot get property without
// inject"），不能在 finalize 里 (ctx as any).cmdlineArgs?.profile 可选链读取。
// loader-boot（有 --profile）在 boot 前写入；直调 bootstrap 路径缺省 web-app。
let currentBootProfile = 'web-app';

/** 记录本次 boot 的组合 profile（loader-boot --profile / 缺省 web-app） */
export function setBootProfile(profile: string): void {
  currentBootProfile = profile;
}

/** 读取本次 boot 的组合 profile */
export function bootProfile(): string {
  return currentBootProfile;
}

/** 实例注册表记录 */
export interface InstanceRecord {
  /** owner 进程 pid */
  pid: number;
  /** WebUI WS/HTTP 端口（client 连 ws://127.0.0.1:<port>/ws） */
  port: number;
  /** 组合 profile（'web-app' / 'base' / …） */
  profile: string;
  /** workspace 绝对路径（注册表按 workspace 区分，多 workspace 各一实例） */
  workspaceDir: string;
  /** 启动时间（ISO；PID 复用排查用） */
  startedAt: string;
  /** Node 版本（排查用） */
  nodeVersion: string;
}

/** findInstance 结果：record 恒带（含死实例，供诊断输出），alive 表 pid 活性 */
export interface InstanceLookup {
  alive: boolean;
  record: InstanceRecord;
}

/** 注册表文件路径 */
export function instanceFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, INSTANCE_FILENAME);
}

/** 缺省 workspace（AGENTCHAT_WORKSPACE / cwd 下 workspace/default；同 loader.workspaceRoot） */
export function defaultWorkspaceDir(): string {
  return workspaceRoot();
}

/**
 * 判断进程是否存活（与 timer-instance.lock 同语义：
 * process.kill(pid, 0) 探测；Windows 上 EPERM = 进程存在但无权限，
 * ESRCH/ENOENT = 不存在。PID 复用为已知残余风险，记录带 startedAt 供排查）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** 读注册表（原始解析；文件缺失/损坏/结构非法 → null） */
export function readInstance(workspaceDir: string): InstanceRecord | null {
  const file = instanceFilePath(workspaceDir);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 不存在或损坏（残留/半写）——活性检查兜底
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Partial<InstanceRecord>;
  if (!Number.isInteger(rec.pid) || !Number.isInteger(rec.port)) return null;
  return {
    pid: rec.pid!,
    port: rec.port!,
    profile: typeof rec.profile === 'string' ? rec.profile : 'unknown',
    workspaceDir: typeof rec.workspaceDir === 'string' ? rec.workspaceDir : workspaceDir,
    startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : '',
    nodeVersion: typeof rec.nodeVersion === 'string' ? rec.nodeVersion : '',
  };
}

/**
 * 发现实例：无注册表 → null；有 → { alive, record }。
 * alive=false 表示残留（崩溃未清理），调用方可覆盖重写。
 */
export function findInstance(workspaceDir: string): InstanceLookup | null {
  const record = readInstance(workspaceDir);
  if (!record) return null;
  return { alive: isProcessAlive(record.pid), record };
}

/** 原子写注册表（tmp + rename） */
export function writeInstance(workspaceDir: string, record: InstanceRecord): void {
  const file = instanceFilePath(workspaceDir);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 清理注册表（仅当记录属于本进程；他人/残留不动——由活性检查兜底） */
export function clearOwnInstance(workspaceDir: string): void {
  const file = instanceFilePath(workspaceDir);
  try {
    const rec = readInstance(workspaceDir);
    if (rec && rec.pid === process.pid) fs.unlinkSync(file);
  } catch { /* 文件已不存在 */
  }
}

/** 人类可读实例描述（错误提示/日志用） */
export function describeInstance(rec: InstanceRecord): string {
  return `pid=${rec.pid} port=${rec.port} profile=${rec.profile}` +
    (rec.startedAt ? ` started=${rec.startedAt}` : '');
}
