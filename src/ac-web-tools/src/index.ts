// ============================================================
// ac-web-tools/src/index.ts —— 网络工具行（web_search + browser）
//
// src web 平移（输出归一 {ok, output}）。preview 形态差异：
//   · provider 算法住纯库 ac-web-search-core（5 provider）
//   · key 三源解析链：行配置 → ac-credentials（Agent 级→全局，
//     call.agentId 执行身份）→ 环境变量（TAVILY_API_KEY 等）
//   · per-Agent 调优走 settings['web-tools']（provider/baseURL/model/
//     defaultResults 等——地图 §3.4 命名空间配置 → settings[具名]；
//     M24 A1 经 settingsOf 合成全局默认层）
//   · browser 是 ctx.browser Service（独立守护进程 + 请求队列）
//
// browser 能力门禁（web + 权限分层复合标签）：
//   · 工具级地板 requiredTags ['web','observe']——通用门禁（ac-security 行
//     执行，AND 语义）；
//   · 动作级分层由本行 before-execute 监听器执行：observe(1) ⊂ manipulate(2)
//     ⊂ inject(3)，调用方层级 = 所持分层标签的最高级；steps 批量载荷逐动作
//     取最大需求。层级嵌套的理由：click 前提是能 open，eval 能做 click 的
//     一切——低层不单独授予高层也放行高层动作之外的读取。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools'; // ctx.tools 服务类型增强（type-only，无运行时依赖）
import { BrowserService, type BrowserRowOptions } from './browser.ts';
import {
  PROVIDER_REGISTRY,
  type ProviderConfig,
  type SearchParams,
  type SearchResponse,
} from 'ac-web-search-core';

export interface WebToolsRowOptions extends BrowserRowOptions {
  /** 缺省搜索 provider（缺省 'tavily'；per-Agent 经 settings['web-tools'].provider 覆盖） */
  provider?: string;
  /** 行级 API Key 直配（缺省走 ac-credentials / 环境变量链） */
  apiKeys?: Record<string, string>;
  /** 缺省结果条数（缺省 5） */
  defaultResults?: number;
  /** 缺省搜索深度（缺省 'advanced'） */
  defaultDepth?: 'basic' | 'advanced';
  /** 缺省主题（缺省 'general'） */
  defaultTopic?: 'general' | 'news' | 'finance';
  /** raw_content 截断长度（缺省 2000） */
  rawContentMaxLen?: number;
}

// ── 缺省常量（实现兜底——2026-10 收敛：provider 只保留经实证的
//    tavily/deepseek，缺省 deepseek；缺省源 = 全局「搜索引擎」池页） ──
const DEFAULT_PROVIDER = 'deepseek';
const DEFAULT_SEARCH_DEPTH = 'advanced';
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TOPIC = 'general';
const DEFAULT_RAW_CONTENT_MAX_LEN = 2000;

const ENV_KEY_MAP: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/** settings['web-tools'] 的 per-Agent 配置形状 */
interface WebToolsSettings {
  enabled?: boolean;
  provider?: string;
  baseURL?: string;
  model?: string;
  maxUses?: number;
  maxTokens?: number;
  apiVersion?: string;
  defaultResults?: number;
  defaultDepth?: 'basic' | 'advanced';
  defaultTopic?: 'general' | 'news' | 'finance';
  rawContentMaxLen?: number;
}

/** 正整数校验（数字字段防御；非法值交由 provider 内置默认） */
function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ---- browser 动作分层（能力门禁用） ----
/** 动作 → 权限层级：observe(1) 只读族 ⊂ manipulate(2) 交互族 ⊂ inject(3) JS 注入 */
const ACTION_TIER: Record<string, number> = {
  open: 1,
  content: 1,
  html: 1,
  screenshot: 1,
  close: 1,
  click: 2,
  type: 2,
  press: 2,
  eval: 3,
};
/** 层级 → 标签名（错误文案用） */
const TIER_TAG: Record<number, string> = { 1: 'observe', 2: 'manipulate', 3: 'inject' };

/**
 * agents 服务软依赖面（ctx.get 探测；结构化形状——无 agents 服务的组合
 * 恒放行，与 ac-gate-core agentGate 同款形态：无注册表面即无门禁面）。
 */
interface AgentsGateFace {
  get(id: string): { tags?: string[] } | undefined;
  settingsOf(id: string, name: string): Record<string, unknown> | undefined;
}

function truncateRawContent(results: SearchResponse['results'], maxLen: number): void {
  for (const r of results) {
    if (r.raw_content && r.raw_content.length > maxLen) {
      r.raw_content = r.raw_content.substring(0, maxLen) + '…';
    }
  }
}

/** 非空 trim 字符串提取（settings/池条目字段共用的类型守卫） */
function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 缺省搜索池条目（全局设置「搜索引擎」页 = config.searchProviders）：
 * default:true 的条目。2026-10 起 web_search 的缺省 provider/参数由此
 * 控制（本行可配置项已移除）。软依赖 config（M12 铁律 2：ctx.get——
 * 组合缺行不炸搜索，回落内置缺省）。
 */
function defaultSearchPool(ctx: Context): { name: string; entry: Record<string, unknown> } | undefined {
  const config = ctx.get('config', false) as { get?(key: string): unknown } | undefined;
  const pools = config?.get?.('searchProviders');
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return undefined;
  for (const [name, entry] of Object.entries(pools as Record<string, unknown>)) {
    if (name.startsWith('$') || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if ((entry as { default?: unknown }).default === true) {
      return { name, entry: entry as Record<string, unknown> };
    }
  }
  return undefined;
}

export const name = 'ac-web-tools';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
//    2026-10 起无可配置项（fields 移除）：web_search 缺省 provider/参数由全局
//    设置「搜索引擎」页（config.searchProviders 池）控制；browser 参数走
//    行配置。存量 settings['web-tools'] 键仍被读取（兼容，UI 不再暴露）。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'web-tools',
  label: '网络工具行',
  description: 'web_search（tavily/deepseek 双 provider + key 三源链；缺省源 = 全局设置「搜索引擎」页）/browser 工具',
  automatic: true,
};


export const inject = ['tools'];

export function apply(ctx: Context, options: WebToolsRowOptions = {}) {
  // 直接实例化（Service 构造器即 reflect.provide 注册，随本行 fiber 卸载回收）：
  // 工具闭包本地捕获实例——同行闭包经 ctx.browser 访问需 inject 声明，
  // 而 browser 服务由本行自身提供（自依赖循环）；外部消费方仍可 ctx.browser。
  const browser = new BrowserService(ctx, options);

  // ---- web_search：provider 解析 + key 三源链 ----
  ctx.tools.register({
    name: 'web_search',
    requiredTags: ['web'],
    description:
      '搜索互联网，获取最新信息（provider：tavily/deepseek——缺省源由全局设置「搜索引擎」页控制）。需要 web 能力标签。',
    // schema 正典 = src 2026-08-20 简化形（仅 query+description——真实调用
    // 统计的调优收敛；条数/深度等 provider 级参数走 settings['web-tools']/
    // 行配置，不暴露给 LLM。M15 对账：preview 此前恢复了全参数 schema
    // 属回退，收敛回 src 正典；execute 层仍兼容全参数）
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        description: { type: 'string', description: '搜索目的的一句话说明' },
      },
      required: ['query'],
    },
    async execute(args, call) {
      try {
        // per-Agent settings['web-tools'] 合成（M11 执行身份查 AgentConfig；
        // M24 A1 settingsOf——2026-10 起 UI 不再暴露，存量键兼容读取）
        let webSettings: WebToolsSettings = {};
        if (call.agentId !== undefined) {
          const h = ctx.get('agents')?.settingsOf(call.agentId, 'web-tools');
          if (h && typeof h === 'object') webSettings = h as WebToolsSettings;
        }
        // 缺省源分层：settings（存量）→ 行配置 → 全局「搜索引擎」池
        // default 条目 → 内置缺省（deepseek）
        const pool = defaultSearchPool(ctx);
        const poolSettings = pool?.entry ?? {};
        const providerName = String(
          nonEmptyStr(webSettings.provider) ?? nonEmptyStr(options.provider) ??
          nonEmptyStr(poolSettings.provider) ?? DEFAULT_PROVIDER,
        );
        const factory = PROVIDER_REGISTRY[providerName];
        if (!factory) {
          return {
            ok: false,
            error: `未知的搜索 provider "${providerName}"。可用选项：${Object.keys(PROVIDER_REGISTRY).join(', ')}`,
          };
        }
        const provider = factory();

        // key 链：行配置直配 → ac-credentials（Agent 级→全局）→ 池引用
        // （searchpool:<池名>——池页保存时侧信道提取，全局级）→ 环境变量
        let apiKey = options.apiKeys?.[providerName] ?? '';
        if (!apiKey && call.agentId !== undefined) {
          const credentials = ctx.get('credentials');
          apiKey = credentials?.resolve(call.agentId, providerName) ?? '';
        }
        if (!apiKey && call.agentId === undefined) {
          apiKey = ctx.get('credentials')?.getGlobal(providerName) ?? '';
        }
        if (!apiKey && pool) {
          apiKey = ctx.get('credentials')?.getGlobal(`searchpool:${pool.name}`) ?? '';
        }
        if (!apiKey) {
          const envVar = ENV_KEY_MAP[providerName];
          if (envVar && process.env[envVar]) apiKey = process.env[envVar]!;
        }

        // 单次求值（positiveInt 双调用 → 局部变量）；settings 层覆盖池层
        const maxUses = positiveInt(webSettings.maxUses ?? poolSettings.maxUses);
        const maxTokens = positiveInt(webSettings.maxTokens ?? poolSettings.maxTokens);
        const sBase = nonEmptyStr(webSettings.baseURL) ?? nonEmptyStr(poolSettings.baseURL);
        const sModel = nonEmptyStr(webSettings.model) ?? nonEmptyStr(poolSettings.model);
        const sApiVer = nonEmptyStr(webSettings.apiVersion) ?? nonEmptyStr(poolSettings.apiVersion);
        const providerCfg: ProviderConfig = {
          apiKey,
          ...(sBase ? { baseURL: sBase } : {}),
          ...(sModel ? { model: sModel } : {}),
          ...(maxUses !== undefined ? { maxUses } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(sApiVer ? { apiVersion: sApiVer } : {}),
        };
        provider.validateConfig(providerCfg);

        call.onProgress?.(`正在使用 ${provider.label} 搜索: ${String(args.query)}...\n`);

        // 搜索参数分层：args（LLM 显式）→ settings（存量）→ 池条目 → 行配置 → 内置缺省
        const poolDepth = poolSettings.defaultDepth === 'basic' || poolSettings.defaultDepth === 'advanced'
          ? (poolSettings.defaultDepth as 'basic' | 'advanced')
          : undefined;
        const poolTopic = ['general', 'news', 'finance'].includes(String(poolSettings.defaultTopic))
          ? (poolSettings.defaultTopic as SearchParams['topic'])
          : undefined;
        const poolResults = positiveInt(poolSettings.defaultResults);
        const params: SearchParams = {
          query: String(args.query ?? ''),
          search_depth: (args.search_depth as SearchParams['search_depth']) ?? webSettings.defaultDepth ?? poolDepth ?? options.defaultDepth ?? DEFAULT_SEARCH_DEPTH,
          max_results: (args.max_results as number) ?? webSettings.defaultResults ?? poolResults ?? options.defaultResults ?? DEFAULT_MAX_RESULTS,
          topic: (args.topic as SearchParams['topic']) ?? webSettings.defaultTopic ?? poolTopic ?? options.defaultTopic ?? DEFAULT_TOPIC,
        };
        if (Array.isArray(args.include_domains) && args.include_domains.length > 0) {
          params.include_domains = args.include_domains as string[];
        }
        if (Array.isArray(args.exclude_domains) && args.exclude_domains.length > 0) {
          params.exclude_domains = args.exclude_domains as string[];
        }
        if (args.time_range) params.time_range = args.time_range as SearchParams['time_range'];
        if (args.include_answer !== undefined) params.include_answer = Boolean(args.include_answer);
        if (args.include_raw_content !== undefined) params.include_raw_content = Boolean(args.include_raw_content);

        const data = await provider.search(params, providerCfg);
        const poolRawMax = positiveInt(poolSettings.rawContentMaxLen);
        truncateRawContent(data.results, webSettings.rawContentMaxLen ?? poolRawMax ?? options.rawContentMaxLen ?? DEFAULT_RAW_CONTENT_MAX_LEN);

        call.onProgress?.(
          `搜索完成，找到 ${data.results.length} 个结果` +
            (data.answer ? '（含 AI 摘要）' : '') +
            ` (${data.response_time.toFixed(1)}s)\n`,
        );

        return {
          ok: true,
          output: {
            provider: providerName,
            query: data.query,
            results: data.results,
            answer: data.answer ?? null,
            response_time: data.response_time,
            credits_used: data.credits_used ?? null,
          },
        };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- browser 动作分层门禁（before-execute 策略拦截；只拦本行工具） ----
  // 工具级地板 ['web','observe'] 由 ac-security 通用门禁执行；本监听器管
  // 高层动作（click/type/press → manipulate；eval → inject；含 steps 批量
  // 载荷逐动作取最大需求）。能力集与 ac-security 同源合成：
  // base ∪ tags ∪ agent:<id> ∪ settings.security.capabilities 覆盖层。
  ctx.on('tool/before-execute', (execution, next) => {
    const call = execution.call;
    if (call.name !== 'browser') return next();
    const agents = ctx.get('agents') as AgentsGateFace | undefined;
    if (!agents) return next(); // 无 agents 服务：无标签面，恒放行（agentGate 同款）

    const args = (call.args ?? {}) as { action?: unknown; steps?: unknown };
    const stepActions = Array.isArray(args.steps)
      ? args.steps.map((s) => (s != null && typeof (s as { action?: unknown }).action === 'string'
          ? ((s as { action: string }).action)
          : ''))
      : [];
    const actions = [...(typeof args.action === 'string' ? [args.action] : []), ...stepActions];
    const need = actions.reduce((max, a) => Math.max(max, ACTION_TIER[a] ?? 0), 0);
    if (need <= 0) return next();

    const agent = call.agentId !== undefined ? agents.get(call.agentId) : undefined;
    const overlayRaw =
      call.agentId !== undefined
        ? (agents.settingsOf(call.agentId, 'security')?.capabilities as unknown)
        : undefined;
    const overlay = Array.isArray(overlayRaw) ? (overlayRaw as unknown[]).filter((c): c is string => typeof c === 'string') : [];
    const caps = new Set<string>(['base', ...(agent?.tags ?? []), ...overlay]);
    if (call.agentId !== undefined) caps.add(`agent:${call.agentId}`);

    let tier = 0;
    if (caps.has('observe')) tier = 1;
    if (caps.has('manipulate')) tier = 2;
    if (caps.has('inject')) tier = 3;
    if (tier >= need) return next();
    return {
      ok: false as const,
      error:
        `browser 动作需要 ${TIER_TAG[need]} 层级或更高（observe ⊂ manipulate ⊂ inject），` +
        `当前调用方（${call.agentId ?? '无身份'}）持有${tier > 0 ? ` ${TIER_TAG[tier]} ` : '无'}层级。` +
        `如需授权请在 Agent 配置 tags 添加 ${TIER_TAG[need]}（工具级另需 web+observe 标签）。`,
    };
  }, { description: 'browser 动作分层门禁（observe/manipulate/inject 层级判定）' });

  // ---- browser：真实 Chromium 操作（ctx.browser 守护进程）----
  ctx.tools.register({
    name: 'browser',
    requiredTags: ['web', 'observe'],
    description:
      '操作浏览器：open 打开页面、click 点击、type 输入、press 按键、content 提取文本、screenshot 截图、html 取源码、eval 执行 JS、close 关闭。可用 steps 批量执行多个动作。需要 web+observe 能力标签；交互动作（click/type/press）另需 manipulate 层级，eval 另需 inject 层级。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'],
          description: '要执行的动作',
        },
        url: { type: 'string', description: '[open] 目标 URL' },
        selector: { type: 'string', description: '[click/type] CSS 选择器' },
        text: { type: 'string', description: '[type] 输入文本' },
        key: { type: 'string', description: '[press] 按键名，如 Enter' },
        name: { type: 'string', description: '[screenshot] 截图文件名' },
        js: { type: 'string', description: '[eval] JS 代码' },
        steps: {
          type: 'array',
          description: '批量模式：依次执行的动作序列',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: '动作' },
              url: { type: 'string', description: '目标 URL' },
              selector: { type: 'string', description: 'CSS 选择器' },
              text: { type: 'string', description: '输入文本' },
              key: { type: 'string', description: '按键名' },
              name: { type: 'string', description: '截图文件名' },
              js: { type: 'string', description: 'JS 代码' },
              repeat: { type: 'number', description: '重复次数（默认 1）', minimum: 1, maximum: 20 },
              delay_ms: { type: 'number', description: '执行后等待毫秒（默认 0）', minimum: 0 },
            },
            required: ['action'],
          },
        },
        continue_on_error: { type: 'boolean', description: '批量模式：某步失败后是否继续（默认 false）' },
      },
    },
    async execute(args) {
      const buildCmd = (step: Record<string, unknown>): Record<string, unknown> => {
        const cmd: Record<string, unknown> = { action: step.action };
        for (const k of ['url', 'selector', 'text', 'key', 'name', 'js'] as const) {
          if (step[k] !== undefined) cmd[k] = step[k];
        }
        return cmd;
      };
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      // 单动作执行（含结果解析）
      const runOne = async (step: Record<string, unknown>, index: number, repeat: number) => {
        const action = String(step.action);
        const cmd = buildCmd(step);
        const raw = await browser.send(cmd);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = { status: 'ok', raw };
        }
        if (parsed && parsed.status === 'error') {
          throw new Error(String(parsed.message || `browser action failed: ${action}`));
        }
        if (cmd.action === 'close') browser.kill();
        return { step: index + 1, action, repeat, params: step, result: parsed };
      };

      try {
        // 批量模式
        if (Array.isArray(args.steps) && args.steps.length > 0) {
          const continueOnError = Boolean(args.continue_on_error ?? args.continueOnError);
          const results: unknown[] = [];
          let fail: { step: number; action: string; message: string } | null = null;
          for (let i = 0; i < args.steps.length; i++) {
            const step = (args.steps[i] ?? {}) as Record<string, unknown>;
            const repeat = Math.max(1, Math.min(20, Number(step.repeat) || 1));
            const delayMs = Math.max(0, Number(step.delay_ms ?? step.delayMs) || 0);
            for (let r = 0; r < repeat; r++) {
              try {
                results.push(await runOne(step, i, r));
                if (delayMs > 0) await sleep(delayMs);
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (!continueOnError) {
                  fail = { step: i + 1, action: String(step.action), message };
                  break;
                }
                results.push({ step: i + 1, action: String(step.action), repeat: r + 1, status: 'error', message });
              }
            }
            if (fail) break;
          }
          if (fail) {
            return { ok: false, error: fail.message, output: { failedStep: fail.step, results } };
          }
          return { ok: true, output: { count: results.length, results } };
        }

        // 单动作模式
        const result = await runOne(args as Record<string, unknown>, 0, 0);
        return { ok: true, output: result.result ?? result };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
