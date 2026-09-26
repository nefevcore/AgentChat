// ============================================================
// ac-cdp-core/src/launch.ts —— 浏览器发现与拉起
//
// · 探测链 Chrome → Edge（标准安装路径直测 + PATH 兜底）——
//   Windows 宿主必装 Edge（Chromium，CDP 兼容），桌面分发零额外依赖
// · --remote-debugging-port=0 由 OS 分配（自选随机端口有竞态：
//   Windows 残留进程占端口是高频事故），真实端口轮询读
//   user-data-dir 下 DevToolsActivePort 文件（puppeteer 手法）
// · user-data-dir 必为自定义目录——Chrome 136+ 在默认目录上
//   静默忽略调试端口开关（反 infostealer；无任何报错），
//   自定义目录不是可选项而是端口能开启的前提
// · 树杀（taskkill /T /F 语义）——Node kill 不杀树，Chrome 子
//   进程会残留并锁住 profile
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/** /json/version 应答（截取用到的字段） */
export interface CdpVersionInfo {
  Browser: string;
  webSocketDebuggerUrl: string;
}

export interface LaunchOptions {
  /** 覆盖探测链（测试注入） */
  executablePath?: string;
  /** 启动参数追加（headful 调试等） */
  extraArgs?: string[];
  /** headless（缺省 true；--headless=new） */
  headless?: boolean;
  /** user-data-dir（必填——Chrome 136+ 自定义目录是调试端口开关生效的前提） */
  userDataDir: string;
  /** ready 握手超时毫秒（缺省 30000） */
  bootTimeoutMs?: number;
  /** HTTP 探活 fetch（测试注入；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  /** OS 分配的调试端口 */
  port: number;
  version: CdpVersionInfo;
  /** 浏览器级 webSocketDebuggerUrl（连 CdpClient 用） */
  webSocketDebuggerUrl: string;
}

/** Windows 标准安装路径（直测——不经环境变量间接；PROGRAMFILES(X86) 的括号形态在 env 里易错） */
function winCandidates(): string[] {
  const out: string[] = [];
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const la = process.env['LOCALAPPDATA'] ?? '';
  for (const base of [pf, pfx86]) {
    out.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (la) out.push(path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return out;
}

function unixCandidates(): string[] {
  return process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/chromium',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];
}

/** 探测浏览器可执行文件（显式覆盖 → 平台标准路径 → PATH 名） */
export function detectBrowser(executablePath?: string): string | undefined {
  if (executablePath) return executablePath;
  const cands = process.platform === 'win32' ? winCandidates() : unixCandidates();
  for (const p of cands) if (existsSync(p)) return p;
  // PATH 兜底：交给 spawn 报 ENOENT（有 error 监听 → fail-fast 可读错误）
  return process.platform === 'win32' ? 'chrome' : 'chromium';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询读 DevToolsActivePort 文件（两行：端口 + 浏览器 ws 路径） */
async function waitDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
): Promise<{ port: number; browserPath: string }> {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(file, 'utf-8').trim();
      const [portLine, ...rest] = raw.split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { port, browserPath: rest[0] ?? '' };
      }
      lastErr = new Error(`DevToolsActivePort 内容非法: "${raw.slice(0, 50)}"`);
    } catch {
      lastErr = undefined; // 文件未就绪——继续轮询
    }
    await sleep(150);
  }
  throw new Error(
    `Chrome 启动超时：${timeoutMs}ms 内未见 DevToolsActivePort${lastErr ? `（${lastErr.message}）` : ''}` +
      '——排查方向：自定义 user-data-dir 是调试端口开关生效的前提（Chrome 136+ 默认目录静默忽略）',
  );
}

/** /json/version 探活（附带回送浏览器级 ws endpoint） */
async function fetchVersion(port: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<CdpVersionInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()) as CdpVersionInfo;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      lastErr = err; // 未监听——继续轮询
    }
    await sleep(150);
  }
  throw new Error(`/json/version 探活超时（${timeoutMs}ms）${lastErr ? `: ${String(lastErr)}` : ''}`);
}

/**
 * 拉起浏览器并完成探活握手（fail-loud：spawn 失败/即退/超时都抛错并清理）。
 * spawn 的 error 事件（ENOENT 等）在 Windows 上不伴随 exit——单独监听，
 * 否则等待窗口空转到超时（2026-09-26 真机首测事故）。
 */
export async function launchBrowser(options: LaunchOptions): Promise<LaunchedBrowser> {
  const exe = detectBrowser(options.executablePath);
  if (!exe) throw new Error('未找到可用的 Chromium 系浏览器（Chrome/Edge/chromium）');
  const bootTimeout = options.bootTimeoutMs ?? 30_000;
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-sync',
    '--no-sandbox',
    ...(options.headless === false ? [] : ['--headless=new']),
    ...(options.extraArgs ?? []),
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  // spawn 失败（ENOENT，Windows 上不伴随 exit）与异常即退才 fail；
  // code=0 即退是 Edge/Chrome 启动器进程的常态（fork 真浏览器后自退，
  // DevToolsActivePort 由子进程写出）——不判失败，继续等文件（真机首测事故）
  const earlyExit = new Promise<string>((resolve) => {
    child.once('error', (err) => resolve(`spawn 失败: ${err.message}`));
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) resolve(`启动后即退出（code=${code}）——${exe}`);
    });
  });
  const raced = await Promise.race([earlyExit, sleep(800).then(() => null as string | null)]);
  const probe = async (): Promise<{ port: number; browserPath: string }> => {
    if (raced !== null) throw new Error(raced);
    return waitDevToolsActivePort(options.userDataDir, bootTimeout);
  };
  const { port } = await probe().catch((err: unknown) => {
    killTree(child);
    throw err;
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  let version: CdpVersionInfo;
  try {
    version = await fetchVersion(port, fetchImpl, Math.max(3_000, bootTimeout));
  } catch (err) {
    killTree(child);
    throw err;
  }
  return { child, port, version, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
}

/** profile 目录清理（Windows 上浏览器进程句柄延迟释放是常态——重试 + 失败容忍） */
export function removeProfile(dir: string, logger?: { warn: (msg: string) => void }): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    logger?.warn(`[browser] profile 目录清理失败（进程句柄延迟）：${dir}`);
  }
}

/** 树杀（Windows taskkill /T /F；POSIX 进程组负 pid）。启动器进程已自退时
 * 优先 Browser.close 优雅关（ws 连接在时），killTree 仅兜底。 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        process.kill(child.pid, 'SIGKILL');
      }
    }
  } catch {
    /* 已死亡 */
  }
}
