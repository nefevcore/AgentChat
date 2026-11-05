// ============================================================
// npm-form.ts —— npm 形态落位（cr-904 / cr-901 v2.1 批2 余项 §4.2）
//
// npm 形态行条目 name = 裸包名（区别于目录/link 形态的 link:<dir> 词形
// ——installed.patch.yml 的 name 即解析规则单源）：落位 <dataRoot>/profile/
// pnpm 根（package.json + pnpm-lock.yaml 锁定，依赖解析完整）；定格指纹
// = 锁文件树指纹（pnpm-lock.yaml 内容 hash）；升级 = 换版本重装 + lock
// diff 进审批卡。
//
// ignore-scripts 强制（§4.5 供应链对冲）：pnpm add 恒带 --ignore-scripts。
// 装载接线（壳侧行集解析 npm 形态条目）随批 3/4 分层编译——本模块只管
// 落位、定格、登记、回执。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { registerInstalled, admissionOf } from './installer.ts';
import { effectiveStateOf, type LiveProcess } from './receipt.ts';
import type { InstallReceipt } from './installer.ts';

/** pnpm 执行器注入面（测试替身/自定义 pnpm 路径；缺省 spawn pnpm） */
export type PnpmRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** npm 定位串白名单（shell 经由下的注入消毒：包名/版本/tag/file: 路径
 * 词形之外的字符一律拒绝——固定参数 add/remove/--ignore-scripts 为常量） */
const SPEC_RE = /^[A-Za-z0-9@/._:#\\-]+$/;

function assertSafeSpec(spec: string): void {
  if (!SPEC_RE.test(spec)) {
    throw new Error('npm 定位串含非法字符（白名单外）: ' + JSON.stringify(spec));
  }
}

/** 单次 spawn：Windows 下 pnpm = .cmd，Node 安全策略（CVE-2024-27980
 * 缓解）禁止无 shell 直启 .cmd（EINVAL）——恒经 shell，参数消毒先行 */
function spawnPnpm(args: string[], cwd: string, capture: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // stdio 经条件展开避开重载交叉（tuple 字面量与 'ignore' 联合会坍缩 never）
    const child: ChildProcess = spawn('pnpm', args, {
      cwd,
      windowsHide: true,
      shell: true,
      ...(capture
        ? { stdio: ['ignore', 'pipe', 'pipe'] as unknown as ChildProcess['stdio'] }
        : { stdio: 'ignore' as unknown as ChildProcess['stdio'] }),
    });
    let stdout = '';
    let stderr = '';
    if (capture && child.stdout !== null && child.stderr !== null) {
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 缺省 pnpm 执行（pipe 捕获失败〔禁命名管道环境〕降级 ignore 重试，
 * 失败码照常透传，仅失输出文本） */
const defaultRunPnpm: PnpmRunner = async (args, cwd) => {
  for (const a of args) if (!a.startsWith('--') && a !== 'add' && a !== 'remove') assertSafeSpec(a);
  try {
    return await spawnPnpm(args, cwd, true);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EINVAL') throw err;
    return spawnPnpm(args, cwd, false);
  }
};

/** profile/ pnpm 根（npm 形态落位目录——installed.patch.yml 同目录） */
export function npmProfileRoot(dataRoot: string): string {
  return path.join(dataRoot, 'profile');
}

/** 锁文件树指纹（pnpm-lock.yaml 内容 SHA-256；缺席 = null） */
export function lockTreeFingerprint(dataRoot: string): string | null {
  try {
    const lock = fs.readFileSync(path.join(npmProfileRoot(dataRoot), 'pnpm-lock.yaml'), 'utf-8');
    return crypto.createHash('sha256').update(lock).digest('hex');
  } catch {
    return null;
  }
}

/** lock diff 摘要（审批卡依赖树变更面：锁定包集的新增/移除/换版） */
export interface LockDiff {
  added: string[];
  removed: string[];
  /** 锁文件整体变化（specifier 级 diff 归包级——逐行 diff 归 webui 展示） */
  changed: boolean;
}

/** 解析 pnpm-lock.yaml 的锁定包名集（packages 段键） */
function lockedPackages(lockText: string): Set<string> {
  const out = new Set<string>();
  let inPackages = false;
  for (const line of lockText.split(/\r?\n/)) {
    if (/^packages:/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // 下一个顶层段
    const m = /^\s{2}'?([^'\s]+)'?\s*:/.exec(line);
    if (inPackages && m) out.add(m[1]);
  }
  return out;
}

/** 两代锁文件的包级 diff（升级审批卡：依赖树变更清单） */
export function lockDiffOf(before: string | null, after: string | null): LockDiff {
  if (before === null || after === null) {
    return { added: [], removed: [], changed: before !== after };
  }
  if (before === after) return { added: [], removed: [], changed: false };
  const a = lockedPackages(before);
  const b = lockedPackages(after);
  return {
    added: [...b].filter((p) => !a.has(p)).sort(),
    removed: [...a].filter((p) => !b.has(p)).sort(),
    changed: true,
  };
}

/** pnpm add 一步（ignore-scripts 强制；lock 变更由调用方前后取指纹） */
export async function pnpmAdd(input: {
  dataRoot: string;
  spec: string;
  registry?: string;
  runPnpm?: PnpmRunner;
}): Promise<{ stdout: string }> {
  const cwd = npmProfileRoot(input.dataRoot);
  fs.mkdirSync(cwd, { recursive: true });
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'agentchat-profile',
      version: '1.0.0',
      private: true,
    }, null, 2) + String.fromCharCode(10), 'utf-8');
  }
  // workspace 自锚（DSH profile 同款形态）：profile 根自带 pnpm-workspace.yaml
  // ——否则 pnpm 向上寻根，装进仓库根 package.json（实测事故：sandbox 数据
  // 根的 add 把依赖写进了仓库 workspace）。空 packages = 独立根。
  if (!fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    fs.writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'packages: []' + String.fromCharCode(10), 'utf-8');
  }
  const args = ['add', input.spec, '--ignore-scripts'];
  if (input.registry !== undefined) args.push('--registry', input.registry);
  const run = input.runPnpm ?? defaultRunPnpm;
  const result = await run(args, cwd);
  if (result.code !== 0) {
    throw new Error('pnpm add 失败（exit ' + result.code + '）：' + result.stderr.slice(-400));
  }
  return { stdout: result.stdout };
}

/** profile/package.json dependencies 键集（add 前快照——新增键探测） */
function profileDependencies(dataRoot: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(npmProfileRoot(dataRoot), 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> };
    return new Set(Object.keys(pkg.dependencies ?? {}));
  } catch {
    return new Set();
  }
}

/** add 后新增依赖键（唯一新增 = 安装目标；多新增 = 异常，fail-loud） */
function newlyAddedDependency(dataRoot: string, before: Set<string>): string | null {
  const added = [...profileDependencies(dataRoot)].filter((k) => !before.has(k));
  return added.length === 1 ? added[0]! : null;
}
/**
 * npm 形态安装（落位 + 门禁 + 登记 + 回执）。
 * spec = npm 定位串（pkg / pkg@version / pkg@tag / file:<本地目录>）。
 * 门禁失败 → failed 回执且**不留落位**（pnpm 已写入时回滚 pnpm remove）。
 */
export async function installNpmPackage(input: {
  dataRoot: string;
  spec: string;
  owner: string;
  grants?: unknown;
  liveProcesses?: LiveProcess[];
  registry?: string;
  runPnpm?: PnpmRunner;
}): Promise<InstallReceipt & { lockDiff?: LockDiff; fingerprint?: { kind: 'lock-tree'; hash: string } }> {
  const live = input.liveProcesses ?? [];
  const before = lockTreeFingerprint(input.dataRoot);
  const beforeDeps = profileDependencies(input.dataRoot);
  // 实际包名 = profile/package.json 新增依赖键（file:/scoped/tag 形态由
  // pnpm 归一——不自行解析 spec）；add 前不可知，catch 面以 spec 占位
  let pkgName = input.spec;
  try {
    await pnpmAdd(input);
    const resolved = newlyAddedDependency(input.dataRoot, beforeDeps);
    if (resolved === null) {
      throw new Error('pnpm add 后 profile/package.json 无新增依赖键（spec=' + input.spec + '）');
    }
    pkgName = resolved;
    const materialized = path.join(npmProfileRoot(input.dataRoot), 'node_modules', pkgName);
    const admission = admissionOf(materialized, input.grants);
    if (!admission.ok || admission.pkg === null) {
      // 门禁失败回滚（不留落位半态）
      const run = input.runPnpm ?? defaultRunPnpm;
      await run(['remove', pkgName, '--ignore-scripts'], npmProfileRoot(input.dataRoot)).catch(() => undefined);
      return {
        name: pkgName,
        version: admission.pkg?.version ?? '0.0.0',
        result: 'failed',
        scope: 'shell',
        effective: 'live',
        reasons: admission.reasons,
        ...(admission.pkg?.form !== undefined ? { form: admission.pkg.form } : {}),
      };
    }
    const after = lockTreeFingerprint(input.dataRoot);
    // 登记：npm 词形 = 裸包名（installed.patch.yml name 即解析规则）
    registerInstalled(input.dataRoot, { id: pkgName, name: pkgName, owner: input.owner, scope: 'shell' });
    return {
      name: pkgName,
      version: admission.pkg.version,
      result: 'applied',
      scope: 'shell',
      effective: effectiveStateOf({ scope: 'shell', liveProcesses: live }),
      installedDir: materialized,
      fingerprint: { kind: 'lock-tree', hash: after ?? '' },
      lockDiff: lockDiffOf(before, after),
      form: admission.pkg.form,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: pkgName,
      version: '0.0.0',
      result: 'failed',
      scope: 'shell',
      effective: /EPERM|EBUSY|EACCES/.test(message) ? 'blocked-by-live-process' : 'live',
      reasons: [message],
    };
  }
}
