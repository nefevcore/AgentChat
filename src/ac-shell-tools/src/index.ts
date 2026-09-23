// ============================================================
// ac-shell-tools/src/index.ts —— 命令执行工具行（pwsh / bash + job）
//
// 工具拆分（2026-09-16，长期搁置任务收口）：单平台工具行取代
// 平台自适应的 bash 万金油。组装时按宿主平台注入其一：
//   · Windows  → pwsh（Unix→PS fail-closed 翻译 + UTF-8 编码前缀，
//     唯一翻译落点——Windows 环境调用命令行工具表现最差的对症）
//   · Unix     → bash（原生方言纯透传，零预处理）
// 平台谱系见 ./shells.ts；平台无关执行体（沙箱/超时/流式/后台 job）
// 见 ./executor.ts——两工具行共用同一执行面。
//
// 兼容锚（2026-09-16 工具拆分）：单平台工具取代平台自适应的 bash
// 万金油——存量 AgentConfig.tools include 'bash'（Windows 宿主下指向
// 不存在的工具）由**预设/配置层用 tag:shell 引用**化解（resolveToolNames
// 按平台展开）；宿主不注册别名（双名会让 tag:shell 展开出重复工具、
// 全工具面 LLM schema 翻倍——诚实的一平台一工具）。
//
// job 工具（list/kill/logs）与平台无关，恒注册（owner = 执行身份）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolCall, ToolResult } from 'ac-tools';
import type { AgentConfig } from 'ac-agents';
import { createAgentSandboxCache, type SandboxResolverOptions, type SandboxWorkdirSource } from 'ac-sandbox-core';
import { bashSpec, prepareBash, preparePwsh, pwshSpec, type ShellSpec } from './shells.ts';
import { executeShellCommand, type ExecLimits } from './executor.ts';
import * as fs from 'node:fs';
import { isProcessAlive, tailLogFile } from './process.ts';

export interface ShellToolsRowOptions extends SandboxResolverOptions {
  /** 命令默认超时毫秒（缺省 30000；0 = 不限；settings['shell-tools'] 分层覆盖） */
  defaultTimeout?: number;
  /** 命令允许的最大超时毫秒（缺省 120000；0 = 不设上限；settings['shell-tools'] 分层覆盖） */
  maxTimeout?: number;
  /** 命令输出最大保留字符数（缺省 50000；settings['shell-tools'] 分层覆盖） */
  outputMaxLen?: number;
  /**
   * 超时处置（缺省 'handoff'）：'handoff' = 超时自动转后台 job 继续执行
   * （前台返回已收集输出 + job_id，不杀进程）；'kill' = 旧行为（树杀 +
   * timed_out 报告）。settings['shell-tools'] 分层覆盖。
   */
  timeoutAction?: 'kill' | 'handoff';
}

/** settings['shell-tools'] 配置形状（全局默认层 ∪ Agent 差异层；行 options = 基线） */
export interface ShellToolsSettings {
  defaultTimeout?: number;
  maxTimeout?: number;
  outputMaxLen?: number;
  timeoutAction?: 'kill' | 'handoff';
}

export const name = 'ac-shell-tools';

/** 超时处置缺省（'handoff'——声明与实现单源） */
export const DEFAULT_TIMEOUT_ACTION: 'kill' | 'handoff' = 'handoff';

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'shell-tools',
  label: '命令执行',
  description: 'pwsh（Windows）/ bash（Unix）单平台命令工具 + job 管理（owner 隔离）；组装时按宿主平台注入其一。超时/输出预算 = settings.shell-tools 分层（行 config 基线 → 全局默认层 → Agent 差异层，执行期按 call.agentId 合成）。启停走 shell 能力标签（AgentConfig.tags）',
  automatic: true,
  fields: [
    { name: 'defaultTimeout', type: 'number', min: 0, step: 1000, default: 30_000, description: '命令缺省超时毫秒（未传 timeout 时；0 = 不限）——差异层覆盖后本 Agent 长任务免逐次传参' },
    { name: 'maxTimeout', type: 'number', min: 0, step: 1000, default: 120_000, description: '命令超时上限毫秒（timeout 参数按本 Agent 生效值 clamp；0 = 不设上限）。defaultTimeout 收敛不超过它（两者同为 0 时即全不限）' },
    { name: 'outputMaxLen', type: 'number', min: 0, step: 1000, default: 50_000, description: '单次命令输出最大保留字符数（超出中段截断并标注）' },
    { name: 'timeoutAction', type: 'string', enum: ['handoff', 'kill'], default: DEFAULT_TIMEOUT_ACTION, description: '超时处置：handoff = 超时自动转后台 job 继续执行（前台返回已收集输出 + job_id，不杀进程；推荐）；kill = 树杀 + timed_out 报告（旧行为）' },
  ],
};

export const inject = ['tools', 'jobs'];

/** 命令工具参数 schema（pwsh/bash 共用形状） */
const COMMAND_TOOL_PARAMETERS = {
  type: 'object' as const,
  properties: {
    command: { type: 'string', description: '要执行的命令' },
    description: { type: 'string', description: '命令作用的一句话说明' },
    workdir: { type: 'string', description: '工作目录（默认沙箱工作目录）' },
    timeout: { type: 'number', description: '超时毫秒（0 = 不限；缺省与上限随本 Agent 的 shell-tools 配置生效，超上限自动截断；超时处置缺省转后台继续执行）。background=true 时本参数不适用（后台任务不限时）', minimum: 0 },
    background: { type: 'boolean', description: '后台执行，立即返回 job_id（用 job 工具管理）' },
  },
  required: ['command'],
};

export function apply(ctx: Context, options: ShellToolsRowOptions = {}) {
  // 沙箱解析基准：Agent 专用空间（ac-workspace.sandboxWorkdir 唯一事实源）
  // 按基准缓存解析器（共用实现住 ac-sandbox-core）
  const sandboxOf = createAgentSandboxCache(options, () =>
    ctx.get('workspace') as SandboxWorkdirSource | undefined,
  );
  const defaultTimeout = options.defaultTimeout ?? 30_000;
  const maxTimeout = options.maxTimeout ?? 120_000;
  const outputMaxLen = options.outputMaxLen ?? 50_000;
  const timeoutAction = options.timeoutAction ?? DEFAULT_TIMEOUT_ACTION;
  const baseLimits: ExecLimits = { defaultTimeout, maxTimeout, outputMaxLen, timeoutAction };

  /**
   * 执行期生效限额（settings['shell-tools'] 分层：行 config 基线 →
   * 全局默认层 → Agent 差异层；按执行身份合成——无身份/未装 agents
   * 行回落基线。defaultTimeout 收敛不超过生效 maxTimeout）
   */
  function limitsOf(agentId: string | undefined): ExecLimits {
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
    const action = s.timeoutAction === 'kill' || s.timeoutAction === 'handoff' ? s.timeoutAction : timeoutAction;
    return {
      defaultTimeout: max > 0 ? Math.min(def, max) : def,
      maxTimeout: max,
      outputMaxLen: num(s.outputMaxLen, outputMaxLen),
      timeoutAction: action,
    };
  }

  /** agents 软依赖（档位判定 tierOf 单源） */
  const agentsOf = (): { get(id: string): AgentConfig | undefined } | undefined =>
    ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;

  // ---- 单平台命令工具注册（Windows → pwsh；Unix → bash） ----
  // A3 门禁语义原样：requiredTags ['shell'] + needPermission（无人审时
  // 档位门兜底——sandbox 软边界内自由，base 有人桶询问/无人桶拒绝）。
  const spec: ShellSpec | null =
    process.platform === 'win32' ? pwshSpec() : bashSpec();
  if (spec) {
    const isWin = spec.family === 'pwsh';
    const deps = {
      sandboxOf,
      agentsOf,
      jobs: ctx.jobs,
      family: spec.family,
      toolName: spec.family,
    };
    const def = {
      name: spec.family,
      requiredTags: ['shell'],
      needPermission: true,
      description: isWin
        ? '在 PowerShell 中执行命令并返回输出（常见 Unix 命令自动 fail-closed 翻译；background=true 转后台任务）。需要 shell 能力标签。'
        : '在 bash 中执行命令并返回输出（background=true 转后台任务）。需要 shell 能力标签。',
      parameters: COMMAND_TOOL_PARAMETERS,
      async execute(args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> {
        return executeShellCommand(ctx, deps, spec, isWin ? preparePwsh : prepareBash, args, call, limitsOf(call.agentId));
      },
    };
    ctx.tools.register(def);
  }

  // ---- job：后台任务管理（list/kill/logs；owner = 执行身份） ----
  // shell 标签（2026-09-16 全量标签化）：job 是命令工具的后台伴生面，
  // 与 pwsh/bash 同族授权（有 shell 才有后台命令管理）
  ctx.tools.register({
    name: 'job',
    requiredTags: ['shell'],
    description: '管理后台任务：list 列出、kill 终止、logs 查看输出（pwsh/bash background / subagent 的任务）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'kill', 'logs'], description: '操作' },
        job_id: { type: 'string', description: '[kill/logs] 任务 id（pwsh/bash background / subagent 返回）' },
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
          if (!id) return { ok: false, error: '缺少 job_id 参数（pwsh/bash background / subagent 返回的任务 id）' };
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
