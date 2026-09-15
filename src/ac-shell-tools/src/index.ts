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
import { bashCommandViolation, createAgentSandboxCache, hostKillViolation, type SandboxResolverOptions, type SandboxWorkdirSource } from 'ac-sandbox-core';
import { effectiveTierOf } from 'ac-agents';
import type { AgentConfig } from 'ac-agents';
import { getShellConfig } from './shell.ts';
import { translateUnixToPowerShell } from './unix-translate.ts';
import { buildErrorMessage, isProcessAlive, killProcessTree, stripAnsi, tailLogFile, truncateMiddle } from './process.ts';

export interface ShellToolsRowOptions extends SandboxResolverOptions {
  /** 命令默认超时毫秒（缺省 30000；0 = 不限；settings['shell-tools'] 分层覆盖） */
  defaultTimeout?: number;
  /** 命令允许的最大超时毫秒（缺省 120000；0 = 不设上限；settings['shell-tools'] 分层覆盖） */
  maxTimeout?: number;
  /** 命令输出最大保留字符数（缺省 50000；settings['shell-tools'] 分层覆盖） */
  outputMaxLen?: number;
}

/** settings['shell-tools'] 配置形状（全局默认层 ∪ Agent 差异层；行 options = 基线） */
export interface ShellToolsSettings {
  defaultTimeout?: number;
  maxTimeout?: number;
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

/**
 * 树杀后 close 兜底宽限 ms（2026-09-12 卡死修复）：close = 进程退出 + stdio
 * 管道全关。命令派生的后代进程（Start-Process / dev server / watch 等）
 * 继承管道写端且脱离父子链时，进程树杀（taskkill /T 按父子链）漏杀它们 →
 * 管道写端永不释放 → child 'close' 永不触发 → 工具 Promise 永挂、run 卡死
 * （前端流式态永真、会话串行化门不释放——用户反馈"得刷新才恢复"）。
 * 退出/树杀后限时等 close，宽限期过即销毁本端读端强制收束（输出已收齐，
 * close 只是被动活孙进程拖住）。本机复现锚：父退出后 close 不来，
 * taskkill /F /T 树杀后仍不来。
 */
const CLOSE_FALLBACK_MS = 2500;

/**
 * 树杀存活确认宽限 ms（永挂窗口补丁）：exit/close 双兜底只覆盖"exit
 * 已到、close 不来"；若树杀本身没杀掉（taskkill 异步静默失败/特权进程
 * 拒杀），exit 永不到 → 兜底永不 arm → 工具 Promise 永挂（与 close
 * 悬挂同症状，触发面更苛刻）。超时/中止 kill 后轮询确认进程已死，
 * 宽限过仍活即销毁本端读端强制收束。
 */
const KILL_CONFIRM_MS = 4000;

export const name = 'ac-shell-tools';

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'shell-tools',
  label: '命令执行',
  description: 'bash（前台超时/流式 + 后台 job）+ job 管理（owner 隔离）；超时/输出预算 = settings.shell-tools 分层（行 config 基线 → 全局默认层 → Agent 差异层，执行期按 call.agentId 合成）。启停走 shell 能力标签（AgentConfig.tags）',
  automatic: true,
  fields: [
    { name: 'defaultTimeout', type: 'number', min: 0, step: 1000, default: 30_000, description: '命令缺省超时毫秒（bash 未传 timeout 时；0 = 不限）——差异层覆盖后本 Agent 长任务免逐次传参' },
    { name: 'maxTimeout', type: 'number', min: 0, step: 1000, default: 120_000, description: '命令超时上限毫秒（timeout 参数按本 Agent 生效值 clamp；0 = 不设上限）。defaultTimeout 收敛不超过它（两者同为 0 时即全不限）' },
    { name: 'outputMaxLen', type: 'number', min: 0, step: 1000, default: 50_000, description: '单次命令输出最大保留字符数（超出中段截断并标注）' },
  ],
};

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
  const baseLimits = { defaultTimeout, maxTimeout, outputMaxLen };

  /**
   * 执行期生效限额（settings['shell-tools'] 分层：行 config 基线 → 全局
   * 默认层 → Agent 差异层；按执行身份合成——无身份/未装 agents 行回落
   * 基线。defaultTimeout 收敛不超过生效 maxTimeout）
   */
  function limitsOf(agentId: string | undefined): typeof baseLimits {
    if (agentId === undefined) return baseLimits;
    const agents = ctx.get('agents', false) as
      | { settingsOf?(id: string, name?: string): unknown }
      | undefined;
    const s = agents?.settingsOf?.(agentId, 'shell-tools') as ShellToolsSettings | undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return baseLimits;
    // 0 = 显式关闭（不限时/不设上限）为合法值；负数/NaN/非数 = 无效回落基线
    const num0 = (v: unknown, fb: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb;
    // outputMaxLen 语义不变：仅正值覆盖（0 无意义）
    const num = (v: unknown, fb: number): number => (typeof v === 'number' && v > 0 ? v : fb);
    const max = num0(s.maxTimeout, maxTimeout);
    const def = num0(s.defaultTimeout, defaultTimeout);
    return {
      defaultTimeout: max > 0 ? Math.min(def, max) : def,
      maxTimeout: max,
      outputMaxLen: num(s.outputMaxLen, outputMaxLen),
    };
  }

  /** agents 软依赖（档位判定 tierOf 单源） */
  const agentsOf = (): { get(id: string): AgentConfig | undefined } | undefined =>
    ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;

  /** effectiveTier（§3.2）：call.elevation（机制提权/审批注入）?? tierOf(agent)
   *  ——与 ac-security 加严层共用单源（effectiveTierOf），防基线与复检漂移 */
  function tierOfCall(call: { agentId?: string; elevation?: string }): 'full-access' | 'sandbox-access' | 'base-access' {
    const agent = call.agentId !== undefined ? agentsOf()?.get(call.agentId) : undefined;
    return effectiveTierOf(
      agent,
      call.elevation === 'full-access' ? 'full-access' : call.elevation === 'sandbox-access' ? 'sandbox-access' : undefined,
    );
  }

  // ---- bash：前台（超时/signal/流式）+ 后台（job 登记） ----
  // A3（2026-08-31 审查）：bash 此前无 requiredTags——一切 Agent 含默认
  // 预设默认可执行命令，是凭据窃取链的第一环（提示注入 → 一次 bash 即
  // 中）。门禁标签 dev → shell 拆分：命令执行与开发工具（read_logs/
  // reload 等 dev 面）分治授权——Agent 须显式带 tags:['shell'] 才可用
  // shell；内置预设已随行带上，自建 Agent 显式授权（存量 tags:['dev']
  // 不再覆盖 bash，须补 shell）。access-tier 起 bash 另标
  // needPermission=true：无人审时还有档位门（sandbox 软边界内自由，
  // base 有人桶询问/无人桶拒绝）。
  ctx.tools.register({
    name: 'bash',
    requiredTags: ['shell'],
    // 权限轴（access-tier §3.3）：命令执行 = 敏感动作——无人审时需要
    // 档位门（sandbox 档软边界内自由；base 有人桶询问/无人桶拒绝）
    needPermission: true,
    description: '执行 shell 命令并返回输出（Windows 自动翻译常见 Unix 命令；background=true 转后台任务）。需要 shell 能力标签。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        description: { type: 'string', description: '命令作用的一句话说明' },
        workdir: { type: 'string', description: '工作目录（默认沙箱工作目录）' },
        timeout: { type: 'number', description: '超时毫秒（0 = 不限；缺省与上限随本 Agent 的 shell-tools 配置生效，超上限自动截断）。background=true 时本参数不适用（后台任务不限时）', minimum: 0 },
        background: { type: 'boolean', description: '后台执行，立即返回 job_id（用 job 工具管理）' },
      },
      required: ['command'],
    },
    async execute(args, call): Promise<ToolResult> {
      const command = args.command == null ? '' : String(args.command);
      const limits = limitsOf(call.agentId); // per-Agent 生效限额（执行期合成）
      const wd = (args.workdir ?? args.cwd) as string | undefined;
      const sandbox = sandboxOf(call);
      // 基线 tierOf 感知（§9.3/§3.2：full"不做任何限制"的字面义）：
      // workdir 只锚定不设白名单；命令级扫描跳过（软边界语义只约束
      // base/sandbox——bash 软边界如实接受，见 §2.2）
      const unrestricted = tierOfCall(call) === 'full-access';
      let dir: string;
      if (unrestricted) {
        dir = wd ? path.resolve(sandbox.workdir, String(wd)) : sandbox.workdir;
      } else {
        try {
          dir = wd ? sandbox.resolve(String(wd)) : sandbox.workdir;
        } catch (err: unknown) {
          return {
            ok: false,
            error: `${err instanceof Error ? err.message : String(err)}。workdir 仅限沙箱允许范围内（相对沙箱工作目录解析）`,
          };
        }
      }
      if (!fs.existsSync(dir)) {
        return { ok: false, error: `工作目录不存在：${dir}（workdir 相对沙箱工作目录解析，缺省即沙箱工作目录）` };
      }
      // 防自杀保护（2026-09-15 后端无端中断事故）：按进程名广谱杀
      // node/pnpm 会把宿主（与 supervisor）一起杀掉——**任何档位（含
      // full-access）都拦**，不属于沙箱边界而是宿主存活保护
      const hostKill = hostKillViolation(command);
      if (hostKill) {
        return { ok: false, error: hostKill, output: { command, cwd: dir } };
      }
      // 命令级沙箱：拦截允许范围外访问（cd .. 越界 / 盘符 / 绝对路径 / ../
      // 引用）——full 档跳过（与 ac-security 加严层同口径，防基线与复检漂移）
      if (!unrestricted) {
        const violation = bashCommandViolation(command, { roots: sandbox.allowedRoots, cwd: dir });
        if (violation) {
          return { ok: false, error: violation, output: { command, cwd: dir } };
        }
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
          // label = 展示标签（JobStartSpec 契约语义）：description 意图优先，
          // 缺省回落原始命令——会话头任务 chip / 侧边栏运行跟踪 / job list
          // 共用（一处修正，全消费面友好化）。原始命令恒存 meta.command，
          // tooltip 详情层可见。
          const intent = typeof args.description === 'string' ? args.description.trim() : '';
          const jobId = ctx.jobs.start({
            kind: 'bash',
            label: intent || command,
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
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        let killWatchdog: ReturnType<typeof setInterval> | undefined;
        let settled = false;

        // timeout 三态：显式 0 = 不限；未传/非法 = 本 Agent 缺省档；正值按
        // 本 Agent 生效 maxTimeout clamp（maxTimeout=0 = 不设上限，跳过 clamp）
        const timeout = args.timeout as number | undefined;
        const effectiveTimeout =
          timeout === 0
            ? 0
            : typeof timeout === 'number' && timeout > 0
              ? limits.maxTimeout > 0
                ? Math.min(timeout, limits.maxTimeout)
                : timeout
              : limits.defaultTimeout;

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

        /** 收束统一出口（幂等）：清计时器 → resolve。close 兜底注释见 CLOSE_FALLBACK_MS */
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
            killWithConfirm();
          }, effectiveTimeout);
        }
        const onAbort = () => killWithConfirm();
        call.signal?.addEventListener('abort', onAbort, { once: true });

        /**
         * exit 后限时等 close；宽限期内 close 不来 = 管道被命令派生的活
         * 后代进程持有（树杀漏杀对象）——销毁本端读端强制收束。本端销毁
         * 只影响输出采集（输出已随 exit 齐了），孙进程写已关管道得 EPIPE
         * 自灭，不碍事。
         */
        const armCloseFallback = (exitCode: number | null) => {
          fallbackTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(exitCode);
          }, CLOSE_FALLBACK_MS);
        };

        /**
         * 树杀 + 存活确认看门狗（KILL_CONFIRM_MS）：kill 后轮询，进程确认
         * 死亡或已收束即停；宽限过仍活 = kill 没生效（exit 不会来、close
         * 兜底永不 arm）→ 销毁本端读端强制收束，活进程后续写已关管道得
         * EPIPE 自灭。timedOut 路径 destroy 后走 finish → 超时口径收束。
         */
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
            settle({
              ok: false,
              error: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。`,
              output: { command, cwd: dir, timed_out: true },
            });
            return;
          }
          const exitCode = typeof code === 'number' ? code : null;
          const success = exitCode === 0;
          // ANSI 清理放汇总处而非 onProgress 流式片：转义序列可能跨 chunk
          // 撕裂，onData 逐片清会留下半截残留——收尾一次性清理最稳。
          const clean = stripAnsi(output);
          const totalBytes = Buffer.byteLength(output, 'utf-8');
          const displayed = truncateMiddle(clean, limits.outputMaxLen);
          const guidance = success ? '' : buildErrorMessage(command, output, exitCode);
          settle({
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
        };

        child.on('close', (code) => finish(code));
        child.on('exit', (code) => armCloseFallback(code));
        child.on('error', (err) => {
          settle({ ok: false, error: err?.message ?? String(err), output: { command, cwd: dir } });
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
        description: { type: 'string', description: '本次操作意图的一句话说明（用于前端展示）' },
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
