// ============================================================
// ac-web-api/src/version.ts —— 版本面纯助手（更新功能修复批）
//
// 零 cordis 依赖的可独立单测纯库：项目根定位/版本读取 +
// GitHub Releases 最新版检查（TTL 缓存 + 5s 超时，失败 null 不缓存）
// + changelog 读取 + git 检出自更新执行器（stash→pull→pop→
// install→build；npm/桌面安装显式 unavailable）。RPC 编排住 index.ts。
// ============================================================
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 发布通道（GitHub Releases；与 desktop 自动更新链同源） */
export const GITHUB_REPO = 'nefevcore/AgentChat';

export interface ProjectVersion {
  /** 项目根目录（package.json 所在；git 自更新/changelog 都以它为锚） */
  dir: string;
  name: string;
  version: string;
}

/** 桌面壳检出（desktop/main.mjs 以 AGENTCHAT_DESKTOP=1 拉起后端） */
export function isDesktopInstall(): boolean {
  return process.env.AGENTCHAT_DESKTOP === '1';
}

/** bundle 自描述版本源：构建期 build-bundle 落 dist/version.json——
 *  桌面装配（resources/agentchat/）附近没有 package.json 可走查，
 *  版本以 bundle 随身携带的清单为准 */
export function resolveBundleVersion(dir: string): ProjectVersion | undefined {
  try {
    const v = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf-8')) as { name?: unknown; version?: unknown };
    if (typeof v.version === 'string' && v.version !== '') {
      return { dir, name: typeof v.name === 'string' && v.name !== '' ? v.name : 'agentchat', version: v.version };
    }
  } catch {
    /* 无 version.json（源码形态）→ 走 package.json 走查 */
  }
  return undefined;
}

/** 根目录候选：import.meta.url 包根 + cwd 向上走查（与旧 readRootPackage 同源语义） */
function rootDirCandidates(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  } catch {
    /* import.meta.url 不可用（打包态）→ 走 cwd 兜底 */
  }
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    dirs.push(dir);
    dir = join(dir, '..');
  }
  return dirs;
}

/** 定位带 version 的根包（package.json 走查；git 自更新的根锚——
 *  不吃 version.json 短路：本地构建过 dist 的源码检出仍指回仓库根） */
export function findProjectVersion(): ProjectVersion | undefined {
  for (const dir of rootDirCandidates()) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.version === 'string') {
        return { dir, name: typeof pkg.name === 'string' ? pkg.name : 'agentchat', version: pkg.version };
      }
    } catch {
      /* 该候选不存在/不可读 → 下一个 */
    }
  }
  return undefined;
}

/** 当前版本读口（展示面用）：bundle version.json 优先（桌面/npm 装配
 *  的可靠锚），缺则回落 package.json 走查（源码检出） */
export function readCurrentVersion(): ProjectVersion | undefined {
  try {
    const bundled = resolveBundleVersion(dirname(fileURLToPath(import.meta.url)));
    if (bundled) return bundled;
  } catch {
    /* 打包态异常 → 走查兜底 */
  }
  return findProjectVersion();
}

/** 读 CHANGELOG.md（bundle 随带/项目根优先；缺失 → 空文案，不垫假数据） */
export function readChangelog(): string {
  const candidates: string[] = [];
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url))); // dist 随带的 CHANGELOG
  } catch {
    /* 打包态异常 → 走查 */
  }
  candidates.push(...rootDirCandidates());
  for (const dir of candidates) {
    try {
      return readFileSync(join(dir, 'CHANGELOG.md'), 'utf-8');
    } catch {
      /* 该候选无 CHANGELOG.md → 下一个 */
    }
  }
  return '';
}

// ---- GitHub Releases 检查（TTL 缓存；并发/重复检查不打接口） ----

export interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt: string;
}

let releaseCache: { info: ReleaseInfo; at: number } | null = null;
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
const RELEASE_FETCH_TIMEOUT_MS = 5000;

/** 测试钩子：清 Release 缓存（跨用例隔离） */
export function resetReleaseCache(): void {
  releaseCache = null;
}

/**
 * 最新 release 检查：成功入缓存（TTL 5min）；任何失败（网络/超时/非 2xx/
 * 形状不符）→ null 且不缓存——调用方以 checkFailed 显式呈现，不垫假数据。
 */
export async function fetchLatestRelease(fetcher: typeof fetch = globalThis.fetch): Promise<ReleaseInfo | null> {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_TTL_MS) return releaseCache.info;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetcher(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'AgentChat' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json() as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
      const version = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : '';
      if (!version) return null;
      const info: ReleaseInfo = {
        version,
        url: typeof data.html_url === 'string' && data.html_url !== '' ? data.html_url : `https://github.com/${GITHUB_REPO}/releases/latest`,
        publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
      };
      releaseCache = { info, at: Date.now() };
      return info;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 三段语义化版本比较（a>b → 1；相等 → 0；a<b → -1） */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// ---- git 检出自更新执行器 ----

export interface SelfUpdateOutcome {
  status: 'success' | 'unavailable' | 'error';
  steps: string[];
  message: string;
}

/** 非 git 安装的手动更新指引（npm 全局安装轨道） */
const NPM_UPDATE_HINT = 'npm install -g @nefevcore/agentchat@latest';

/** 跑一条 shell 命令（cwd=root；超时抛错；返回 stdout 末行语义由调用方整形） */
async function sh(root: string, cmd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execAsync(cmd, { cwd: root, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() || 'done';
}

function errDetail(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const raw = e.stderr || e.stdout || e.message || String(err);
  return String(raw).trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}

/**
 * git 检出自更新：stash 本地改动 → git pull → stash pop → 包管理器
 * install（pnpm 优先，缺则 npm）→ build（非致命）。
 * 非 git 检出（npm 全局/桌面安装）→ unavailable + 手动更新指引；
 * 不偷偷执行任何命令。重启归调用方（supervisor 模式走 requestSystemRestart）。
 */
export async function runSelfUpdate(root: string): Promise<SelfUpdateOutcome> {
  const steps: string[] = [];
  if (!existsSync(join(root, '.git'))) {
    return {
      status: 'unavailable',
      steps,
      message: `当前安装不是 git 检出（${root}），无法在线更新。npm 安装请执行：${NPM_UPDATE_HINT}；桌面版走应用内更新。完成后重启生效。`,
    };
  }
  try {
    // 1. git pull（本地改动先 stash，pull 后 pop；-u 连未跟踪文件一并
    //    入栈，保证 stash/pop 配对平衡——纯未跟踪改动下无 -u 会存空栈）
    const branch = await sh(root, 'git rev-parse --abbrev-ref HEAD', 10_000);
    const dirty = (await sh(root, 'git status --porcelain', 10_000)) !== '';
    let stashed = false;
    if (dirty) {
      await sh(root, 'git stash push -u -m agentchat-auto-update', 30_000);
      stashed = true;
      steps.push('git stash: 已暂存本地改动');
    }
    steps.push(`git pull: ${lastLine(await sh(root, `git pull origin ${branch}`, 120_000))}`);
    if (stashed) {
      try {
        await sh(root, 'git stash pop', 30_000);
        steps.push('git stash pop: 已恢复本地改动');
      } catch {
        steps.push('git stash pop: 有冲突，请手动处理 git stash');
      }
    }

    // 2. 依赖安装（pnpm 优先；本仓库 packageManager=pnpm，npm 装会拆出锁文件）
    let hasPnpm = false;
    try {
      await execAsync('pnpm --version', { encoding: 'utf-8', timeout: 15_000 });
      hasPnpm = true;
    } catch {
      hasPnpm = false;
    }
    const pm = hasPnpm ? 'pnpm' : 'npm';
    const installCmd = hasPnpm ? 'pnpm install' : 'npm install --no-audit --no-fund';
    steps.push(`${pm} install: ${lastLine(await sh(root, installCmd, 300_000))}`);

    // 3. 构建（非致命——运行轨道可能直接跑源码）
    try {
      steps.push(`${pm} run build: ${lastLine(await sh(root, `${pm} run build`, 300_000))}`);
    } catch (buildErr) {
      steps.push(`${pm} run build: 跳过（${errDetail(buildErr)}）`);
    }

    return { status: 'success', steps, message: '更新完成。' };
  } catch (err) {
    const detail = errDetail(err);
    steps.push(`失败: ${detail}`);
    return { status: 'error', steps, message: `更新失败: ${detail}` };
  }
}
