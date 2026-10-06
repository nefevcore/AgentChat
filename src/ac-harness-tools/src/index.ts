// ============================================================
// ac-harness-tools —— harness 委托工具行（run_harness）
//
// harness 桥接方案 B（docs/harness-bridge-plan.md）：把完整任务委托给
// 本地 CLI harness（Claude Code / Codex CLI——订阅额度复用，AgentChat
// 侧零 API key 管理）。算法住 ac-harness-core 纯库；本行只做注册胶水
// 与权限/并发/生命周期编排。
//
// 门禁面：
//   · requiredTags [harness]（tag-registry 目录自动采集 + 手工声明双保险）
//   · needPermission（真实子进程 + 外部模型计费——base 档审批）
//   · 会话开关 harnessTier（conv-settings 实验性组，cr-277：缺省 enabled
//     ——实验性=发现入口归属非能力开关；disabled = execute 自查拒绝，
//     issueSubmit 同款口径）
//   · 沙箱两档收死（plan 只读 / workspace-write），无 full 档
//   · agent 维互斥（同 Agent 同时仅一个 harness run）+ 全局上限
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools'; // ctx.tools 服务类型增强（type-only）
import { runGateway, claudeCodeAdapter, codexAdapter, type HarnessRunResult } from 'ac-harness-core';
import { sessionRunKeyOf, recordSession } from './sessions.ts';
import type { ExtensionMeta } from 'ac-extension-core';
import type { TagDeclaration } from 'ac-tag-registry';
import type { ConvSettingsKeyDef } from 'ac-conv-settings';

export const name = 'ac-harness-tools';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明）──
export const extension: ExtensionMeta = {
  name: 'harness-tools',
  label: 'Harness 委托',
  description: 'run_harness 工具：把完整任务委托给本地 CLI harness（Claude Code/Codex）执行，终稿回流（沙箱两档 + agent 维互斥）',
  automatic: true,
  fields: [
    { name: 'enabled', type: 'boolean', description: '全局停用 run_harness（缺省启用）' },
    { name: 'maxConcurrent', type: 'number', description: '全局并发上限（缺省 2）' },
    { name: 'defaultTimeoutMs', type: 'number', description: '看门狗缺省毫秒（缺省 600000 = 10 分钟）' },
  ],
};

/** 标签目录声明（tag-registry 扫描面；RESERVED 未占——D10 已核） */
export const tagDeclarations: TagDeclaration[] = [
  { tag: 'harness', description: '本地 harness 委托（run_harness 把任务委托给 Claude Code/Codex CLI——订阅额度执行）', tools: ['run_harness'] },
];

export interface HarnessToolsRowOptions {
  /** 全局停用（缺省启用） */
  enabled?: boolean;
  /** 全局并发上限（缺省 2；超出报忙不排队） */
  maxConcurrent?: number;
  /** 看门狗缺省毫秒（缺省 600000） */
  defaultTimeoutMs?: number;
  /** 网关命令覆盖（缺省 PATH 解析：claude / codex） */
  gateways?: Partial<Record<'claude-code' | 'codex', { command: string; enabled?: boolean }>>;
}

/** 会话实验键注册（§5.7/D11）：harnessTier——grants 通路见 sessionCapsOf */
const HARNESS_TIER_KEY: ConvSettingsKeyDef = {
  key: 'harnessTier',
  enum: ['enabled', 'disabled'],
  description: '跟随 Agent tags（harness 标签）；缺省即启用——实验性是发现入口，非能力开关',
  group: 'experimental',
  label: 'Harness 委托',
  order: 3,
  options: { enabled: '本会话启用', disabled: '本会话禁用（防误委托/省订阅额度）' },
  grants: { enabled: ['harness'] },
};

const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_CONCURRENT = 2;
/** 过程事件摘要上限（notices 有界——防大 run 撑爆上下文） */
const NOTICES_MAX = 20;

export const inject = ['tools', 'convSettings'];

export function apply(ctx: Context, options: HarnessToolsRowOptions = {}) {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandOf = (gw: 'claude-code' | 'codex'): { command: string; enabled: boolean } => {
    const override = options.gateways?.[gw];
    return {
      command: override?.command ?? (gw === 'claude-code' ? 'claude' : 'codex'),
      enabled: override?.enabled !== false,
    };
  };

  // 会话实验键注册（注册即归属——本行卸载键自动回收，存量值回读同被清）。
  // inject 声明 convSettings 硬依赖（loader 并发激活下行序 ≠ 激活序——软取会
  // 永久漏注册，cr-280 根因）；bootTree 顺序 await 路径天然满足。
  ctx.convSettings.registerKey(HARNESS_TIER_KEY);

  // 并发纪律（D4）：agent 维互斥（内存表）+ 全局上限；占线报忙不排队
  const busyAgents = new Set<string>();
  let inFlight = 0;

  ctx.tools.register({
    name: 'run_harness',
    requiredTags: ['harness'],
    needPermission: true,
    description:
      '把一个完整任务委托给本地 CLI harness（Claude Code / Codex CLI）执行：harness 全权跑自己的 agent 循环（工具/文件/命令），终稿作为本工具结果回流。harness 使用自己的登录凭证（订阅额度），无需 API key。task 必须是自足完整的委托任务书（把背景、目标、产出要求全部写进 task）；同会话非首次委托默认续接上次 harness 会话（resume=auto——上下文已延续，task 只写增量即可）。工作目录缺省为本 Agent 的专属空间 files/<id>/harness/。沙箱两档：plan（只读分析）/ workspace-write（可写工作区，Codex 保持默认禁网）。长任务建议显式放宽 timeout_ms（缺省 10 分钟）。同一 Agent 同时仅一个 harness run（占线报忙）。',
    parameters: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['claude-code', 'codex'], description: '目标 harness 网关' },
        task: { type: 'string', description: '完整委托任务书（原样作为 prompt 传入——自足完整，含背景/目标/产出要求）' },
        cwd: { type: 'string', description: '工作目录（相对 Agent 专属空间解析；缺省 files/<agentId>/harness/）' },
        sandbox: { type: 'string', enum: ['plan', 'workspace-write'], description: '沙箱档（plan=只读分析；workspace-write=可写工作区；无更高档）' },
        model: { type: 'string', description: 'harness 侧模型覆盖（可选，走 harness 自己的模型名）' },
        timeout_ms: { type: 'number', description: '看门狗超时毫秒（缺省 600000；长任务显式放宽）' },
        resume: { type: 'string', enum: ['auto', 'new'], description: '会话续接（P2）：auto=有本会话上次成功的 runKey 则续接 harness 侧会话（上下文延续，task 可只写增量）；new=强制新会话。续接凭据过期时 harness 报错，改 new 重试即可' },
      },
      required: ['harness', 'task'],
    },
    async execute(args, call) {
      // 行全局停用（settings[harness-tools].enabled 约定键自查——respectsEnabled 口径）
      if (call.agentId !== undefined) {
        const s = ctx.get('agents')?.settingsOf(call.agentId, 'harness-tools') as { enabled?: boolean } | undefined;
        if (s && typeof s === 'object' && s.enabled === false) {
          return { ok: false, error: 'run_harness 已被停用（settings[harness-tools].enabled）' };
        }
      }
      if (options.enabled === false) {
        return { ok: false, error: 'run_harness 已被本行配置停用' };
      }

      // 会话开关（cr-277 §5.7）：disabled = 本会话禁用（配了 tags 的 Agent 同样被拦——
      // caps 通路只做加法，减法在这里）；无键 = enabled 默认启用
      if (call.conversationId !== undefined
        && ctx.convSettings.get(call.conversationId).harnessTier === 'disabled') {
        return { ok: false, error: 'run_harness 已被本会话禁用（输入框「实验性 → Harness 委托」）——如需使用请切换为本会话启用。' };
      }

      const gw = args.harness === 'codex' ? 'codex' : args.harness === 'claude-code' ? 'claude-code' : undefined;
      if (gw === undefined) {
        return { ok: false, error: '未知 harness "' + String(args.harness) + '"（可选：claude-code, codex）' };
      }
      const gateway = commandOf(gw);
      if (!gateway.enabled) {
        return { ok: false, error: '网关 ' + gw + ' 已在行配置中停用（gateways.' + gw + '.enabled=false）' };
      }
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) {
        return { ok: false, error: 'task 不能为空——委托任务书是唯一信息载体（背景/目标/产出要求全部写进 task）' };
      }

      // cwd 解析：缺省 Agent 专属空间 files/<id>/harness/（workspace 行缺席或无执行身份
      // → 进程 cwd 兜底）；workspace 相对路径解析
      const workspace = ctx.get('workspace', false) as
        | { sandboxWorkdir(agentId: string | undefined, conversationId?: string): string | undefined }
        | undefined;
      const base = workspace?.sandboxWorkdir(call.agentId, call.conversationId) ?? process.cwd();
      const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
      const cwd = path.resolve(base, cwdArg ?? path.join('harness', ''));

      const sandbox = args.sandbox === 'plan' ? 'plan' as const : 'workspace-write' as const;
      const maxMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : defaultTimeoutMs;
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;

      // 会话续接（P2）：resume=auto（缺省）查 Agent 专属空间映射表——同会话同网关的
      // 上次成功 runKey；new 或无记录 = 新会话。agentDir 与 cwd 同基准（专属空间根）。
      const resumeMode = args.resume === 'new' ? 'new' as const : 'auto' as const;
      const agentDir = path.dirname(cwd); // cwd 缺省 <agentDir>/harness；显式 cwd 时以基准为家
      const resumeKey = resumeMode === 'auto'
        ? sessionRunKeyOf(agentDir, call.conversationId, gw)
        : undefined;

      // 并发闸（agent 维互斥 + 全局上限；报忙不排队——模型自行决定等待策略）
      const agentKey = call.agentId ?? '<host>';
      if (busyAgents.has(agentKey)) {
        return { ok: false, error: '本 Agent 已有一个 harness run 在执行（agent 维互斥）——等它完成后再委托。' };
      }
      if (inFlight >= maxConcurrent) {
        return { ok: false, error: 'harness 全局并发已满（' + maxConcurrent + '）——稍后再试或减小任务粒度。' };
      }
      busyAgents.add(agentKey);
      inFlight++;

      // 过程事件直播（onProgress）+ notices 摘要（有界）
      const notices: string[] = [];
      const pushNotice = (line: string) => {
        if (notices.length < NOTICES_MAX) notices.push(line);
        else if (notices.length === NOTICES_MAX) notices.push('…[后续事件省略]');
      };
      try {
        const result: HarnessRunResult = await runGateway(
          gw === 'claude-code' ? claudeCodeAdapter : codexAdapter,
          gateway.command,
          { prompt: task, cwd, sandbox, model, maxMs, signal: call.signal, ...(resumeKey !== undefined ? { resumeKey } : {}) },
          {
            onEvent(e) {
              if (e.kind === 'started') {
                const line = `已启动（${e.model ?? gw}${e.runKey ? '，runKey=' + e.runKey : ''}）`;
                pushNotice(line);
                call.onProgress?.(line);
              } else if (e.kind === 'notice') {
                pushNotice(e.label);
                call.onProgress?.(e.label);
              } else if (e.kind === 'delta') {
                call.onProgress?.(e.text);
              }
            },
          },
        );
        // 成功即记续接凭据（失败/超时/中止不覆盖——上次成功凭据保留）；无会话上下文不记
        if (result.ok && result.finish === 'stop' && result.runKey !== undefined && call.conversationId !== undefined) {
          recordSession(agentDir, call.conversationId, { gateway: gw, runKey: result.runKey, ts: Date.now() });
        }
        return {
          ok: result.ok,
          output: {
            ok: result.ok,
            text: result.text,
            finish: result.finish,
            ...(resumeKey !== undefined ? { resumed: true } : {}),
            ...(result.runKey !== undefined ? { runKey: result.runKey } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.stats !== undefined ? { stats: result.stats } : {}),
            ...(notices.length ? { notices } : {}),
          },
          ...(result.ok ? {} : { error: result.text }),
        };
      } finally {
        busyAgents.delete(agentKey);
        inFlight--;
      }
    },
  });
}