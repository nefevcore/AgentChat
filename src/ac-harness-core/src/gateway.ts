// ============================================================
// ac-harness-core/src/gateway.ts —— 网关接口与 exec 编排（纯库）
//
// 网关 = 一个本地 harness CLI 的程序化委托面。适配器只依赖文档化的
// 一次性 exec JSONL 面（claude -p --output-format stream-json /
// codex exec --json——Agent SDK / App Server / MCP 等交互式协议零依赖，
// 版本漂移面最小化 D7）。
//
// 本模块住跨家共用编排：spawn、stdin 写入、行流解析、看门狗、中止
// （kill 子树——Windows taskkill /T 递斩孙进程，posix 进程组）、finish
// 四态收敛（stop/error/timeout/aborted 如实回——模型可读可重试决策）。
// 家族差异（命令行拼装 + 每行事件归一）由各 adapter 提供。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { parseJsonlLine } from './events.ts';
import type { HarnessEvent, LineOutcome, TerminalFacts } from './events.ts';

export interface HarnessRunRequest {
  /** 完整委托任务书（stdin 传入——防 Windows 32k 命令行长度限制） */
  prompt: string;
  /** 工作目录（绝对路径；行侧解析） */
  cwd: string;
  /** 沙箱两档（无 full 档——§5.5 护栏） */
  sandbox?: 'plan' | 'workspace-write';
  /** harness 侧模型（可选） */
  model?: string;
  /**
   * 会话续接凭据（P2/cr-279）：claude session_id / codex thread_id。
   * 适配器拼进命令行（claude --resume <id>；codex exec resume <id>）——
   * 过期/不存在由 harness 侧报错，走 error 终态如实收敛（模型可读改 new 重试）。
   */
  resumeKey?: string;
  /** 看门狗超时毫秒 */
  maxMs?: number;
  /** 中止信号（steer 停止/会话中止传播） */
  signal?: AbortSignal;
}

export interface HarnessRunResult {
  ok: boolean;
  /** 终稿全文（失败形态 = 错误说明——始终非空） */
  text: string;
  finish: 'stop' | 'error' | 'timeout' | 'aborted';
  /** 续接凭据（claude session_id / codex thread_id；行侧持久化到 Agent 专属空间映射表） */
  runKey?: string;
  usage?: TerminalFacts['usage'];
  stats?: TerminalFacts['stats'];
}

/** 家族差异面：命令行拼装 + 每行 JSONL → 事件/终态归一 */
export interface HarnessAdapter {
  readonly name: 'claude-code' | 'codex';
  /** run 的命令行（prompt 走 stdin 不进 argv） */
  buildArgs(req: HarnessRunRequest): string[];
  /** 归一一行 JSONL（未知/损坏 → { ok:false }） */
  lineOutcome(obj: Record<string, unknown>): LineOutcome;
  /** 进程自然退出后的终稿组装（exitCode + 归一到的终态事实） */
  finalize(facts: TerminalFacts | undefined, exitCode: number | null, stderrTail: string): HarnessRunResult;
}

export interface HarnessRunHooks {
  /** 过程事件直播（onProgress 源） */
  onEvent?(e: HarnessEvent): void;
}

/** 杀整个进程树（Windows taskkill /T；Unix 进程组——spawn detached） */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* taskkill 失败忽略（进程可能已退） */ }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
}

/** exec 编排（跨家共用）：spawn → stdin 写 prompt → JSONL 行流归一 → 终态 */
export function runGateway(
  adapter: HarnessAdapter,
  command: string,
  req: HarnessRunRequest,
  hooks: HarnessRunHooks = {},
): Promise<HarnessRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unknownEvents = 0;
    let terminal: TerminalFacts | undefined;
    let stderrTail = '';
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      req.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (result: HarnessRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    function onAbort() {
      killTree(child);
      settle({ ok: false, text: 'harness run 已中止（调用方 signal）', finish: 'aborted' });
    }

    const child = spawn(command, adapter.buildArgs(req), {
      cwd: req.cwd,
      shell: false,
      windowsHide: true,
      // posix 进程组长（killTree 负 PID 递斩组）；Windows 下无此语义
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.maxMs !== undefined) {
      watchdog = setTimeout(() => {
        killTree(child);
        settle({ ok: false, text: `harness run 超时（${req.maxMs}ms 看门狗到点，已终止子进程树）`, finish: 'timeout' });
      }, req.maxMs);
    }

    // prompt 经 stdin（UTF-8 无 BOM）；写入即关——CLI 读 EOF 开始处理
    child.stdin!.on('error', () => { /* EPIPE：进程早退，退出码路径接管 */ });
    child.stdin!.end(req.prompt, 'utf-8');

    let stdoutBuf = '';
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });

    let stderrBuf = '';
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-2000);
    });

    function handleLine(line: string) {
      const obj = parseJsonlLine(line);
      if (obj === undefined) {
        if (line.trim() !== '') unknownEvents++;
        return;
      }
      const outcome = adapter.lineOutcome(obj);
      if (!outcome.ok) {
        unknownEvents++;
        return;
      }
      if ('terminal' in outcome) {
        terminal = outcome.terminal;
        return;
      }
      hooks.onEvent?.(outcome.event);
    }

    child.on('error', (err) => {
      // spawn 失败（未装/不在 PATH）——fail-loud 带安装提示
      settle({ ok: false, text: `无法启动 "${command}"（${adapter.name}）：${err.message}——请确认本机已安装并在 PATH，或在 settings[harness].gateways 配置全路径`, finish: 'error' });
    });
    child.on('close', (code) => {
      const stats = { unknownEvents, ...(stderrTail ? { stderrTail } : {}) };
      const merged: TerminalFacts = terminal
        ? { ...terminal, stats: { ...stats, ...terminal.stats } }
        : { finish: code === 0 ? 'stop' : 'error', text: '', stats };
      settle(adapter.finalize(merged, code, stderrBuf));
    });
  });
}

/** probe 轻探测：`<command> --version`（0.5s 超时；未装如实报错） */
export function probeGateway(command: string, label: string): Promise<{ ok: boolean; version?: string; hint?: string }> {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    const finish = (r: { ok: boolean; version?: string; hint?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, hint: `${label} --version 探测超时（0.5s）` }), 500);
    try {
      const child = spawn(command, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (c: string) => { out += c; });
      child.on('error', (err) => finish({ ok: false, hint: `无法启动 "${command}"：${err.message}（未安装或不在 PATH？）` }));
      child.on('close', () => finish({ ok: true, version: out.trim().split(/\r?\n/)[0] || undefined }));
    } catch (err) {
      finish({ ok: false, hint: String(err) });
    }
  });
}