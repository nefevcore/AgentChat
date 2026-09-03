// ============================================================
// ac-shell-tools/src/index.ts —— 命令执行工具行（bash + job）
//
// src shell 平移（输出归一 {ok, output}）。preview 形态差异（地图 §3.4
// 核心映射规律）：src 的"注册期 per-Agent 烘焙"→ "全局注册 + 执行期身份"：
//   · ownerAgentId = call.agentId（M11 执行身份；缺省无主任务）
//   · signal = call.signal（bash 超时/取消；loop request.signal 透传）
//   · onProgress = call.onProgress（流式输出回调挂 call）
//   · 命名空间配置 tool.bash → 行配置（defaultTimeout/maxTimeout/outputMaxLen）
// 命令级沙箱（heredoc 剥离 + 段级启发式）住 ac-sandbox-core；
// bash 命令扫描的 per-Agent 执行面归 ac-security 行（M11 并入）。
// job 工具接 ctx.jobs（统一任务词汇：bash background / subagent / timer）。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { bashCommandViolation, createAgentSandboxCache, type SandboxResolverOptions, type SandboxWorkdirSource } from 'ac-sandbox-core';
import { getShellConfig } from './shell.ts';
import { translateUnixToPowerShell } from './unix-translate.ts';
import { buildErrorMessage, isProcessAlive, killProcessTree, tailLogFile, truncateMiddle } from './process.ts';

export interface ShellToolsRowOptions extends SandboxResolverOptions {
  /** 命令默认超时毫秒（缺省 30000） */
  defaultTimeout?: number;
  /** 命令允许的最大超时毫秒（缺省 120000） */
  maxTimeout?: number;
  /** 命令输出最大保留字符数（缺省 50000） */
  outputMaxLen?: number;
}

/** bash 后台任务临时日志前缀（>1 小时清理） */
const BASH_TEMP_PREFIX = 'ac-bash-';

function bashTempLogPath(): string {
  return path.join(os.tmpdir(), `${BASH_TEMP_PREFIX}${randomBytes(8).toString('hex')}.log`);
}

/** 清理超过 1 小时的旧 bash 临时日志（非阻塞） */
function cleanupOldBashLogs(): void {
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

export const name = 'ac-shell-tools';

export const inject = ['tools', 'jobs'];

export function apply(ctx: Context, options: ShellToolsRowOptions = {}) {
  // 沙箱解析基准（M18 反馈 #3）：Agent 专用空间（ac-workspace.sandboxWorkdir
  // 唯一事实源——bash 缺省 cwd 随之落到 files/<agentId>；缺 → 行缺省）。
  // 按基准缓存解析器（共用实现住 ac-sandbox-core）。
  const sandboxOf = createAgentSandboxCache(options, () =>
    ctx.get('workspace') as SandboxWorkdirSource | undefined,
  );
  const defaultTimeout = options.defaultTimeout ?? 30_000;
  const maxTimeout = options.maxTimeout ?? 120_000;
  const outputMaxLen = options.outputMaxLen ?? 50_000;

  // ---- bash：前台（超时/signal/流式）+ 后台（job 登记） ----
  // A3（2026-08-31 审查）：bash 此前无 requiredTags——一切 Agent 含默认
  // 预设默认可执行命令，是凭据窃取链的第一环（提示注入 → 一次 bash 即
  // 中）。门禁标签 dev → shell 拆分：命令执行与开发工具（read_logs/
  // reload 等 dev 面）分治授权——Agent 须显式带 tags:['shell']（或
  // capabilities 追加）才可用 shell；内置预设已随行带上，自建 Agent
  // 显式授权（存量 tags:['dev'] 不再覆盖 bash，须补 shell）。
  ctx.tools.register({
    name: 'bash',
    requiredTags: ['shell'],
    description: '执行 shell 命令并返回输出（Windows 自动翻译常见 Unix 命令；background=true 转后台任务）。需要 shell 能力标签。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        description: { type: 'string', description: '命令作用的一句话说明' },
        workdir: { type: 'string', description: '工作目录（默认沙箱工作目录）' },
        timeout: { type: 'number', description: `超时毫秒（默认 ${defaultTimeout}，上限 ${maxTimeout}）`, minimum: 1000, maximum: maxTimeout },
        background: { type: 'boolean', description: '后台执行，立即返回 job_id（用 job 工具管理）' },
      },
      required: ['command'],
    },
    async execute(args, call): Promise<ToolResult> {
      const command = args.command == null ? '' : String(args.command);
      const wd = (args.workdir ?? args.cwd) as string | undefined;
      const sandbox = sandboxOf(call);
      let dir: string;
      try {
        dir = wd ? sandbox.resolve(String(wd)) : sandbox.workdir;
      } catch (err: unknown) {
        return {
          ok: false,
          error: `${err instanceof Error ? err.message : String(err)}。workdir 仅限沙箱允许范围内（相对沙箱工作目录解析）`,
        };
      }
      if (!fs.existsSync(dir)) {
        return { ok: false, error: `工作目录不存在：${dir}（workdir 相对沙箱工作目录解析，缺省即沙箱工作目录）` };
      }
      // 命令级沙箱：拦截允许范围外访问（cd .. 越界 / 盘符 / 绝对路径 / ../ 引用）
      const violation = bashCommandViolation(command, { roots: sandbox.allowedRoots, cwd: dir });
      if (violation) {
        return { ok: false, error: violation, output: { command, cwd: dir } };
      }
      const { shell, args: shellArgs } = getShellConfig();

      // Unix → PowerShell 自动翻译（Windows PowerShell 系列；cmd 回退不支持 PS 语法）
      let commandToRun = command;
      let translatedCommand: string | undefined;
      if (process.platform === 'win32' && shell !== 'cmd') {
        const translated = translateUnixToPowerShell(command);
        if (translated.translated) {
          commandToRun = translated.command;
          translatedCommand = translated.command;
        }
        // 强制 UTF-8 输出编码（cmd 不支持该语法，跳过）
        commandToRun = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${commandToRun}`;
      }

      // Python 默认 UTF-8：消除 Windows 下 print 中文的 GBK UnicodeEncodeError
      const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
      const stdin = args.stdin != null ? String(args.stdin) : undefined;

      // ---- 后台执行：detached spawn + 日志文件，立即返回 job_id ----
      if (args.background === true) {
        try {
          const logFile = bashTempLogPath();
          const fd = fs.openSync(logFile, 'a');
          const child: ChildProcess = spawn(shell, [...shellArgs, commandToRun], {
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
            return { ok: false, error: '后台启动失败：未取得子进程 PID' };
          }
          // owner = 执行身份（M11：全局注册 + 执行期身份取代 per-Agent 烘焙）；
          // conversationId = 发起会话（完成通知回投本会话——任务结果不再
          // 落 owner 自会话桶造成"回到别的会话"）
          const jobId = ctx.jobs.start({
            kind: 'bash',
            label: command,
            ...(call.agentId !== undefined ? { ownerAgentId: call.agentId } : {}),
            ...(call.conversationId ? { conversationId: call.conversationId } : {}),
            meta: { pid: child.pid, command, cwd: dir, logFile },
            run: () => {
              // 进程 close → done 终态（非零退出 = completed + detail，报告不报错）
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
          return {
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
          };
        } catch (err: unknown) {
          return { ok: false, error: `后台启动失败: ${String(err)}` };
        }
      }

      // ---- 前台执行（流式输出 + 超时 + signal 中止）----
      cleanupOldBashLogs();
      return new Promise<ToolResult>((resolve) => {
        let output = '';
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // timeout 可调，clamp 到 maxTimeout
        const timeout = args.timeout as number | undefined;
        const effectiveTimeout =
          typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, maxTimeout) : defaultTimeout;

        const child: ChildProcess = spawn(shell, [...shellArgs, commandToRun], {
          cwd: dir,
          env: childEnv,
          windowsHide: true,
          // Unix：detached 使子进程成为进程组组长——超时/中止的负 PID 组杀
          // （killProcessTree）依赖组长身份；Windows 无此语义（false 同效）
          detached: process.platform !== 'win32',
          stdio: stdin != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        const onData = (data: Buffer) => {
          // C1：本回调在子进程 stdout/stderr 流里执行——任何抛错都是
          // uncaughtException（无外层帧兜底）；进度链失败只丢该片流式
          try {
            const chunk = data.toString('utf-8');
            output += chunk;
            call.onProgress?.(chunk); // 流式输出（M11：进度回调挂 call）
          } catch (err: unknown) {
            // 保留最后错误文本进 output 供诊断
            output += `\n[stream error] ${err instanceof Error ? err.message : String(err)}\n`;
          }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        if (stdin != null && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }

        if (effectiveTimeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, effectiveTimeout);
        }
        const onAbort = () => {
          if (child.pid) killProcessTree(child.pid);
        };
        call.signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          call.signal?.removeEventListener('abort', onAbort);
          if (timedOut) {
            resolve({
              ok: false,
              error: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。`,
              output: { command, cwd: dir, timed_out: true },
            });
            return;
          }
          const exitCode = typeof code === 'number' ? code : null;
          const success = exitCode === 0;
          const totalBytes = Buffer.byteLength(output, 'utf-8');
          const displayed = truncateMiddle(output, outputMaxLen);
          const guidance = success ? '' : buildErrorMessage(command, output, exitCode);
          resolve({
            ok: success,
            output: {
              command,
              ...(translatedCommand ? { translated_command: translatedCommand } : {}),
              cwd: dir,
              output: displayed.text || '(无输出)',
              exit_code: exitCode,
              truncated: displayed.truncated,
              total_bytes: totalBytes,
            },
            ...(success ? {} : { error: guidance || `命令退出码 ${exitCode}` }),
          });
        });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          call.signal?.removeEventListener('abort', onAbort);
          resolve({ ok: false, error: err?.message ?? String(err), output: { command, cwd: dir } });
        });
      });
    },
  });

  // ---- job：后台任务管理（list/kill/logs；owner = 执行身份） ----
  ctx.tools.register({
    name: 'job',
    description: '管理后台任务：list 列出、kill 终止、logs 查看输出（bash background / subagent 的任务）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'kill', 'logs'], description: '操作' },
        job_id: { type: 'string', description: '[kill/logs] 任务 id（bash background / subagent 返回）' },
        limit: { type: 'number', description: '[logs] 返回尾部行数（默认 50，最大 500）', minimum: 1, maximum: 500 },
      },
      required: ['action'],
    },
    async execute(args, call): Promise<ToolResult> {
      const action = args.action;
      const owner = call.agentId; // owner 分桶：只作用于本 Agent 的任务
      try {
        if (action === 'list') {
          const jobsList = ctx.jobs.list(owner).map((j) => {
            const pid = typeof j.meta?.pid === 'number' ? (j.meta.pid as number) : undefined;
            const logFile = typeof j.meta?.logFile === 'string' ? (j.meta.logFile as string) : undefined;
            return {
              id: j.id,
              kind: j.kind,
              command: typeof j.meta?.command === 'string' ? (j.meta.command as string) : j.label,
              ...(logFile ? { log_file: logFile } : {}),
              started_at: new Date(j.startedAt).toISOString(),
              status: j.status,
              ...(j.detail !== undefined ? { detail: j.detail } : {}),
              ...(j.finishedAt !== undefined ? { finished_at: new Date(j.finishedAt).toISOString() } : {}),
              ...(pid !== undefined
                ? { alive: isProcessAlive(pid), log_size: logFile && fs.existsSync(logFile) ? fs.statSync(logFile).size : 0 }
                : {}),
            };
          });
          return { ok: true, output: { count: jobsList.length, jobs: jobsList } };
        }

        if (action === 'kill') {
          const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
          if (!id) return { ok: false, error: '缺少 job_id 参数（bash background / subagent 返回的任务 id）' };
          const { outcome, job } = ctx.jobs.kill(id, owner);
          return {
            ok: true,
            output: {
              outcome,
              job_id: id,
              message:
                outcome === 'already-finished'
                  ? `后台任务 ${id} 已结束（${job.status}${job.detail ? `, ${job.detail}` : ''}）`
                  : `已请求终止后台任务 ${id}（settle 为 killed）`,
            },
          };
        }

        if (action === 'logs') {
          const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
          if (!id) return { ok: false, error: '缺少 job_id 参数（要读取输出的任务 id）' };
          const { text, job } = ctx.jobs.read(id, owner);
          const logFile = typeof job.meta?.logFile === 'string' ? (job.meta.logFile as string) : undefined;
          const lines = Math.min(500, Math.max(1, Number(args.limit ?? args.lines) || 50));
          const content = logFile ? tailLogFile(logFile, lines) || text || '(日志为空)' : text || '(暂无输出)';
          return { ok: true, output: { job_id: id, lines: content ? content.split('\n').length : 0, content } };
        }

        return { ok: false, error: `未知 action "${String(action)}"，应为 list/kill/logs 之一。` };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
