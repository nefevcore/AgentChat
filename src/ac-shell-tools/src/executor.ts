// ============================================================
// ac-shell-tools/src/executor.ts —— 平台无关命令执行体
//
// 从旧 bash 工具体抽出（2026-09-16 工具拆分）：沙箱解析 / 防自杀 /
// 命令级扫描 / 前台流式超时 / 后台 job 登记对 shell 家族无感知，
// 仅依赖 ShellSpec（可执行体 + 参数前缀）与 PreparedCommand
// （预处理产物）。pwsh / bash 工具行共用同一执行体。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { bashCommandViolation, hostKillViolation, type SandboxResolver } from 'ac-sandbox-core';
import { effectiveTierOf } from 'ac-agents';
import type { AgentConfig } from 'ac-agents';
import { buildErrorMessage, isProcessAlive, killProcessTree, looksLikeInvocationError, stripAnsi, tailLogFile, truncateMiddle } from './process.ts';
import type { ShellSpec } from './shells.ts';

/** 后台任务临时日志前缀（>1 小时清理） */
const BASH_TEMP_PREFIX = 'ac-bash-';

function bashTempLogPath(): string {
  return path.join(os.tmpdir(), `${BASH_TEMP_PREFIX}${randomBytes(8).toString('hex')}.log`);
}

/** 清理超过 1 小时的旧临时日志（非阻塞） */
function cleanupOldLogs(): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!f.startsWith(BASH_TEMP_PREFIX)) continue;
      try {
        const s = fs.statSync(path.join(os.tmpdir(), f));
        if (now - s.birthtimeMs > 3_600_000) fs.unlinkSync(path.join(os.tmpdir(), f));
      } catch {
        /* 跳过无法 stat 的文件 */
      }
    }
  } catch {
    /* 非关键路径 */
  }
}

/**
 * 树杀后 close 兜底宽限 ms（2026-09-12 卡死修复）：close = 进程退出 +
 * stdio 管道全关。命令派生的后代进程（Start-Process / dev server /
 * watch 等）继承管道写端且脱离父子链时，树杀漏杀它们 → close 永不
 * 触发 → 工具 Promise 永挂。退出/树杀后限时等 close，宽限过即销毁
 * 本端读端强制收束。
 */
const CLOSE_FALLBACK_MS = 2500;

/** 树杀存活确认宽限 ms（永挂窗口补丁）：超时/中止 kill 后轮询确认 */
const KILL_CONFIRM_MS = 4000;

/** 执行限额（工具行按 call.agentId 合成后传入） */
export interface ExecLimits {
  defaultTimeout: number;
  maxTimeout: number;
  outputMaxLen: number;
  /**
   * 超时处置（2026-12）：'kill'（缺省，树杀 + timed_out 报告）或
   * 'handoff'（不杀——前台结果让位，命令移交后台 job 继续跑，
   * 累积输出与 job_id 随结果返回）。
   */
  timeoutAction: 'kill' | 'handoff';
}

/** 执行体依赖注入（工具行闭包持有，见 index.ts） */
export interface ExecutorDeps {
  /** 沙箱解析器工厂（per-call——执行身份感知） */
  sandboxOf: (call: { agentId?: string; conversationId?: string }) => SandboxResolver;
  /** agents 注册表软依赖（档位判定；未装 = undefined） */
  agentsOf: () => { get(id: string): AgentConfig | undefined } | undefined;
  /** 后台 job 登记（ac-jobs ctx.jobs） */
  jobs: Context['jobs'];
  /** 工具家族名（job kind 与 label 语义：'pwsh' | 'bash'） */
  family: string;
  /** 工具名（报错引导文案归因用） */
  toolName: string;
}

/** 命令预处理钩子（pwsh = 翻译+编码前缀；bash = 纯透传） */
export type PrepareFn = (command: string) => { commandToRun: string; translatedCommand?: string };

/** effectiveTier（access-tier §3.2）：elevation ?? tierOf(agent)——与 ac-security 共用单源 */
function tierOfCall(
  call: { agentId?: string; elevation?: string },
  agentsOf: () => { get(id: string): AgentConfig | undefined } | undefined,
): 'full-access' | 'sandbox-access' | 'base-access' {
  const agent = call.agentId !== undefined ? agentsOf()?.get(call.agentId) : undefined;
  return effectiveTierOf(
    agent,
    call.elevation === 'full-access' ? 'full-access' : call.elevation === 'sandbox-access' ? 'sandbox-access' : undefined,
  );
}

/**
 * 平台无关执行体：一次命令调用的全生命周期。
 * 参数形状与旧 bash 工具体一致（command/description/workdir/timeout/
 * background/stdin）。
 */
export function executeShellCommand(
  ctx: Context,
  deps: ExecutorDeps,
  spec: ShellSpec,
  prepare: PrepareFn,
  args: Record<string, unknown>,
  call: {
    agentId?: string;
    conversationId?: string;
    signal?: AbortSignal;
    onProgress?: (chunk: string) => void;
    elevation?: string;
  },
  limits: ExecLimits,
): Promise<ToolResult> {
  const command = args.command == null ? '' : String(args.command);
  const wd = (args.workdir ?? args.cwd) as string | undefined;
  const sandbox = deps.sandboxOf(call);
  // 基线 tierOf 感知（full "不做任何限制"的字面义）：workdir 只锚定不设
  // 白名单；命令级扫描跳过（软边界语义只约束 base/sandbox）
  const unrestricted = tierOfCall(call, deps.agentsOf) === 'full-access';
  let dir: string;
  if (unrestricted) {
    dir = wd ? path.resolve(sandbox.workdir, String(wd)) : sandbox.workdir;
  } else {
    try {
      dir = wd ? sandbox.resolve(String(wd)) : sandbox.workdir;
    } catch (err: unknown) {
      return Promise.resolve({
        ok: false,
        error: `${err instanceof Error ? err.message : String(err)}。workdir 仅限沙箱允许范围内（相对沙箱工作目录解析）`,
      });
    }
  }
  if (!fs.existsSync(dir)) {
    return Promise.resolve({
      ok: false,
      error: `工作目录不存在：${dir}（workdir 相对沙箱工作目录解析，缺省即沙箱工作目录）`,
    });
  }
  // 防自杀保护（2026-09-15 后端无端中断事故）：按进程名广谱杀
  // node/pnpm 会把宿主（与 supervisor）一起杀掉——任何档位都拦，
  // 不属于沙箱边界而是宿主存活保护
  const hostKill = hostKillViolation(command);
  if (hostKill) {
    return Promise.resolve({ ok: false, error: hostKill, output: { command, cwd: dir } });
  }
  // 命令级沙箱：拦截允许范围外访问——full 档跳过（与 ac-security
  // 加严层同口径，防基线与复检漂移）
  if (!unrestricted) {
    const violation = bashCommandViolation(command, { roots: sandbox.allowedRoots, cwd: dir });
    if (violation) {
      return Promise.resolve({ ok: false, error: violation, output: { command, cwd: dir } });
    }
  }

  const { commandToRun, translatedCommand } = prepare(command);

  // Python 默认 UTF-8：消除 Windows 下 print 中文的 GBK UnicodeEncodeError
  const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const stdin = args.stdin != null ? String(args.stdin) : undefined;

  // ---- 后台执行：detached spawn + 日志文件，立即返回 job_id ----
  if (args.background === true) {
    try {
      const logFile = bashTempLogPath();
      const fd = fs.openSync(logFile, 'a');
      const child: ChildProcess = spawn(spec.shell, [...spec.args, commandToRun], {
        cwd: dir,
        env: childEnv,
        // Windows：detached:false + unref 即可让子进程存活；Unix：detached:true 创建独立进程组
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        shell: false,
      });
      child.unref();
      if (child.pid == null) {
        return Promise.resolve({ ok: false, error: '后台启动失败：未取得子进程 PID' });
      }
      // owner = 执行身份；conversationId = 发起会话（完成通知回投本会话）；
      // label = 意图优先展示标签，原始命令恒存 meta.command
      const intent = typeof args.description === 'string' ? args.description.trim() : '';
      const jobId = deps.jobs.start({
        kind: deps.family,
        label: intent || command,
        ...(call.agentId !== undefined ? { ownerAgentId: call.agentId } : {}),
        ...(call.conversationId ? { conversationId: call.conversationId } : {}),
        meta: { pid: child.pid, command, cwd: dir, logFile },
        run: () => {
          const done = new Promise<import('ac-jobs').JobOutcome>((resolve) => {
            child.on('close', (code, signal) => {
              resolve(
                signal !== null
                  ? { status: 'killed', detail: `signal: ${signal}` }
                  : { status: 'completed', detail: `exit code: ${code ?? 0}` },
              );
            });
          });
          return { cancel: () => killProcessTree(child.pid!), done };
        },
      });
      return Promise.resolve({
        ok: true,
        output: {
          command,
          ...(translatedCommand ? { translated_command: translatedCommand } : {}),
          cwd: dir,
          background: true,
          pid: child.pid,
          job_id: jobId,
          log_file: logFile,
          message: `已在后台启动（任务 ${jobId}，PID ${child.pid}）。日志：${logFile}。用 job 工具管理（list/kill/logs）。`,
        },
      });
    } catch (err: unknown) {
      return Promise.resolve({ ok: false, error: `后台启动失败: ${String(err)}` });
    }
  }

  // ---- 前台执行（流式输出 + 超时 + signal 中止）----
  cleanupOldLogs();
  return new Promise<ToolResult>((resolve) => {
    // 分轨收集（stdout/stderr 输出字段对齐 Agent 直觉，2026-12）：两流各自
    // 累积 + 合流 output（时序交错价值）三本账；finish 各自清理/截断/汇报
    let stdoutRaw = '';
    let stderrRaw = '';
    let timedOut = false;
    /** 调用方 signal 中止（区别于超时/正常退出——收束语义同超时：ok:false） */
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let killWatchdog: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    // timeout 三态：显式 0 = 不限；未传/非法 = 缺省档；正值按 maxTimeout clamp
    const timeout = args.timeout as number | undefined;
    const effectiveTimeout =
      timeout === 0
        ? 0
        : typeof timeout === 'number' && timeout > 0
          ? limits.maxTimeout > 0
            ? Math.min(timeout, limits.maxTimeout)
            : timeout
          : limits.defaultTimeout;

    const child: ChildProcess = spawn(spec.shell, [...spec.args, commandToRun], {
      cwd: dir,
      env: childEnv,
      windowsHide: true,
      // Unix：detached 使子进程成为进程组组长——超时/中止的负 PID 组杀
      // （killProcessTree）依赖组长身份；Windows 无此语义（false 同效）
      detached: process.platform !== 'win32',
      stdio: stdin != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    // C1：data 回调在子进程 stdout/stderr 流里执行——任何抛错都是
    // uncaughtException（无外层帧兜底）；进度链失败只丢该片流式
    const onStdout = (data: Buffer) => {
      try {
        const chunk = data.toString('utf-8');
        stdoutRaw += chunk;
        call.onProgress?.(chunk);
      } catch (err: unknown) {
        stdoutRaw += `\n[stream error] ${err instanceof Error ? err.message : String(err)}\n`;
      }
    };
    const onStderr = (data: Buffer) => {
      try {
        const chunk = data.toString('utf-8');
        stderrRaw += chunk;
        call.onProgress?.(chunk);
      } catch (err: unknown) {
        stderrRaw += `\n[stream error] ${err instanceof Error ? err.message : String(err)}\n`;
      }
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    if (stdin != null && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    /** 收束统一出口（幂等）：清计时器 → resolve */
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (killWatchdog) clearInterval(killWatchdog);
      call.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // handoff 模式（2026-12）：不杀——后台登记 + 输出改道日志文件，
        // 累积输出与 job_id 随前台结果一并返回（模型可继续 job 工具接力）
        if (limits.timeoutAction === 'handoff') {
          handoffToJob();
        } else {
          killWithConfirm();
        }
      }, effectiveTimeout);
    }
    const onAbort = () => {
      aborted = true; // signal 中止 ≠ 命令反馈：非零退出是被杀所致，非命令语义
      killWithConfirm();
    };
    call.signal?.addEventListener('abort', onAbort, { once: true });

    /** exit 后限时等 close；宽限过 = 管道被活后代持有 → 销毁读端强制收束 */
    const armCloseFallback = (exitCode: number | null) => {
      fallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, CLOSE_FALLBACK_MS);
    };

    /** 超时 handoff 产物（job 登记结果——timedOut 结果分支引用） */
    let handoff: { jobId: string; logFile: string; pid: number } | undefined;

    /**
     * 超时降级 handoff（2026-12）：命令超时但 timeoutAction='handoff'——
     * 不杀进程：前台输出泵改道日志文件（不能销毁读端——管道断裂会让
     * 子进程后续写入吃 EPIPE 而死，违背"继续跑"语义）+ 后台登记 job，
     * 随即以前台结果收束（命令移交后台，输出快照 + job_id 随结果返回）。
     * handoff 失败（磁盘/登记异常）回退 kill 语义。
     */
    const handoffToJob = (): void => {
      try {
        const logFile = bashTempLogPath();
        const log = fs.createWriteStream(logFile, { flags: 'a' });
        // 已累积输出落日志（前台账本此后停更——快照已随结果带走）
        log.write(stdoutRaw + stderrRaw);
        // 改道：摘前台 handler，新 chunk 泵进日志文件（前台 Promise 闭包
        // 持有监听器直至子进程退出，输出零丢失；fd 随 close 收口）
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        const pump = (d: Buffer) => {
          try {
            log.write(d);
          } catch {
            /* 写失败丢弃该 chunk（日志尽力而为） */
          }
        };
        child.stdout?.on('data', pump);
        child.stderr?.on('data', pump);
        child.on('close', () => log.end());
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
        const intent = typeof args.description === 'string' ? args.description.trim() : '';
        const jobId = deps.jobs.start({
          kind: deps.family,
          label: intent || command,
          ...(call.agentId !== undefined ? { ownerAgentId: call.agentId } : {}),
          ...(call.conversationId ? { conversationId: call.conversationId } : {}),
          meta: { pid: child.pid, command, cwd: dir, logFile },
          run: () => {
            const done = new Promise<import('ac-jobs').JobOutcome>((resolve) => {
              child.on('close', (code, signal) => {
                resolve(
                  signal !== null
                    ? { status: 'killed', detail: `signal: ${signal}` }
                    : { status: 'completed', detail: `exit code: ${code ?? 0}` },
                );
              });
            });
            return { cancel: () => killProcessTree(child.pid!), done };
          },
        });
        handoff = { jobId, logFile, pid: child.pid! };
        // 立即收束前台（timedOut 分支读 handoff 组装结果）；子进程后续
        // 生命周期归 job（完成时 job/settled 通知）
        finish(child.exitCode);
      } catch {
        killWithConfirm();
      }
    };

    /** 树杀 + 存活确认看门狗：kill 后轮询，宽限过仍活 = kill 没生效 → 强制收束 */
    const killWithConfirm = (): void => {
      const pid = child.pid;
      if (!pid) return;
      killProcessTree(pid);
      const killAt = Date.now();
      killWatchdog = setInterval(() => {
        if (settled || !isProcessAlive(pid)) {
          if (killWatchdog) clearInterval(killWatchdog);
          killWatchdog = undefined;
          return;
        }
        if (Date.now() - killAt >= KILL_CONFIRM_MS) {
          if (killWatchdog) clearInterval(killWatchdog);
          killWatchdog = undefined;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(child.exitCode);
        }
      }, 100);
    };

    const finish = (code: number | null) => {
      if (timedOut) {
        if (limits.timeoutAction === 'handoff') {
          // handoff：命令仍活——把已累积输出做全预算快照随结果返回；完整体
          // 恒在日志文件（前台期间已 + 前台后增量），job 工具接力查看
          const clean = stripAnsi(stdoutRaw + stderrRaw);
          const snap = truncateMiddle(clean, limits.outputMaxLen);
          settle({
            ok: false,
            error: `命令超时（${effectiveTimeout}ms），已自动转后台继续执行（任务 ${handoff?.jobId ?? '未登记'}）——日志：${handoff?.logFile ?? '(日志文件不可用)'}。用 job 工具管理（list/logs/kill）；需要前台完整结果时，增大 timeout 参数或显式 background 执行。`,
            output: {
              command,
              ...(translatedCommand ? { translated_command: translatedCommand } : {}),
              cwd: dir,
              timed_out: true,
              timeout_action: 'handoff',
              output: snap.text || '(无输出)',
              stdout: truncateMiddle(stripAnsi(stdoutRaw), limits.outputMaxLen).text,
              stderr: truncateMiddle(stripAnsi(stderrRaw), limits.outputMaxLen).text,
              total_bytes: Buffer.byteLength(stdoutRaw + stderrRaw, 'utf-8'),
              ...(handoff ? { job_id: handoff.jobId, log_file: handoff.logFile, pid: handoff.pid } : {}),
            },
          });
        } else {
          settle({
            ok: false,
            error: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。`,
            output: { command, cwd: dir, timed_out: true },
          });
        }
        return;
      }
      if (aborted) {
        // signal 中止：进程被调用方主动杀掉（run 中断/会话切换）——不是命令
        // 语义输出也不是链路错误，但工具面必须 ok:false（调用方发起的中止已生效）
        settle({
          ok: false,
          error: '命令被调用方中止（AbortSignal）。输出已部分收集。',
          output: {
            command,
            cwd: dir,
            aborted: true,
            output: stdoutRaw + stderrRaw || '(无输出)',
            stdout: stripAnsi(stdoutRaw),
            stderr: stripAnsi(stderrRaw),
          },
        });
        return;
      }
      const exitCode = typeof code === 'number' ? code : null;
      const success = exitCode === 0;
      // 合流账本：旧 output 字段（时序交错）与错误归因（buildErrorMessage /
      // looksLikeInvocationError 吃全量输出）的语义不变量
      const combined = stdoutRaw + stderrRaw;
      // ANSI 清理放汇总处而非 onProgress 流式片：转义序列可能跨 chunk 撕裂
      const clean = stripAnsi(combined);
      const totalBytes = Buffer.byteLength(combined, 'utf-8');
      const displayed = truncateMiddle(clean, limits.outputMaxLen);
      // 分轨输出（stdout/stderr 字段，2026-12 对齐 Agent 直觉）：与合流同口径
      // 清理与截断，两流各享全额预算——双流大输出时信息量优于合流互挤
      const stdoutView = truncateMiddle(stripAnsi(stdoutRaw), limits.outputMaxLen);
      const stderrView = truncateMiddle(stripAnsi(stderrRaw), limits.outputMaxLen);
      const truncated = displayed.truncated || stdoutView.truncated || stderrView.truncated;
      let guidance = success ? '' : buildErrorMessage(command, combined, exitCode);
      // 报错归因对齐（2026-09-16 审查）：译文失败时 Agent 面对的是
      // "写了 A、执行了 B、报错指向 A"的错位反馈回路。失败且命令被
      // 翻译过 → error 显式附译文与提示，让归因落回真实执行物。
      if (!success && translatedCommand) {
        guidance = [
          guidance,
          `实际执行的是 Unix→PowerShell 翻译产物（可能偏离原命令语义）：${translatedCommand}。若怀疑翻译有误，可直接改写为 PowerShell 原生命令重试。`,
        ].filter(Boolean).join(' ');
      }
      // 反馈型/错误型分类（2026-11-19 画像 Ⓐ）：exit≠0 有两类——
      //   · command-feedback = 命令按预期运行并报告了非零退出（测试红灯、
      //     grep 无命中、断言失败等）：命令的语义输出，不是工具链路错误；
      //   · invocation-error = 命令没跑起来/语法层失败（ParserError、
      //     command not found 等）：工具链路错误，ok:false + error。
      // 旧形态把两类混算成 error——统计失真（vitest 红灯占 82 失败的过半）
      // 且模型易误判为工具故障而绕路。分类不改变输出可见性（output 全量
      // 保留），只改变 ok/error 语义面。
      const isInvocationError = !success && looksLikeInvocationError(clean);
      const classification = success
        ? undefined
        : isInvocationError
          ? ('invocation-error' as const)
          : ('command-feedback' as const);
      if (!success && !isInvocationError) {
        // 反馈型：无 error 字段——命令已忠实执行并返回结果，退出码在
        // exit_code 字段；引导文案（如有）随 note 送达不冒充错误
        const parts = [
          guidance,
          `命令退出码 ${exitCode}（command-feedback：命令按预期运行后的非零退出——如测试红灯/断言失败/无命中，属命令语义输出而非工具错误；输出已在 output 字段）`,
        ].filter(Boolean);
        settle({
          ok: true,
          output: {
            command,
            ...(translatedCommand ? { translated_command: translatedCommand } : {}),
            cwd: dir,
            output: displayed.text || '(无输出)',
            stdout: stdoutView.text,
            stderr: stderrView.text,
            exit_code: exitCode,
            failure_class: 'command-feedback',
            ...(parts.length > 0 ? { note: parts.join(' ') } : {}),
            truncated,
            total_bytes: totalBytes,
          },
        });
        return;
      }
      settle({
        ok: success,
        output: {
          command,
          ...(translatedCommand ? { translated_command: translatedCommand } : {}),
          cwd: dir,
          output: displayed.text || '(无输出)',
          stdout: stdoutView.text,
          stderr: stderrView.text,
          exit_code: exitCode,
          ...(classification !== undefined ? { failure_class: classification } : {}),
          truncated,
          total_bytes: totalBytes,
        },
        ...(success ? {} : { error: guidance || `命令未正常启动或语法失败（invocation-error，退出码 ${exitCode}）` }),
      });
    };

    child.on('close', (code) => finish(code));
    child.on('exit', (code) => armCloseFallback(code));
    child.on('error', (err) => {
      settle({ ok: false, error: err?.message ?? String(err), output: { command, cwd: dir } });
    });
  });
}
