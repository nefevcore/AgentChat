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
// ============================================================
import type { Context } from '@agentchat/cordis';
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

const ENV_KEY_MAP: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
  brave: 'BRAVE_API_KEY',
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

function truncateRawContent(results: SearchResponse['results'], maxLen: number): void {
  for (const r of results) {
    if (r.raw_content && r.raw_content.length > maxLen) {
      r.raw_content = r.raw_content.substring(0, maxLen) + '…';
    }
  }
}

export const name = 'ac-web-tools';

export const inject = ['tools'];

export function apply(ctx: Context, options: WebToolsRowOptions = {}) {
  // 直接实例化（Service 构造器即 reflect.provide 注册，随本行 fiber 卸载回收）：
  // 工具闭包本地捕获实例——同行闭包经 ctx.browser 访问需 inject 声明，
  // 而 browser 服务由本行自身提供（自依赖循环）；外部消费方仍可 ctx.browser。
  const browser = new BrowserService(ctx, options);

  // ---- web_search：provider 解析 + key 三源链 ----
  ctx.tools.register({
    name: 'web_search',
    description: '搜索互联网，获取最新信息（provider 可配置：tavily/serpapi/brave/duckduckgo/deepseek）。',
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
        // M24 A1 settingsOf）
        let webSettings: WebToolsSettings = {};
        if (call.agentId !== undefined) {
          const h = ctx.get('agents')?.settingsOf(call.agentId, 'web-tools');
          if (h && typeof h === 'object') webSettings = h as WebToolsSettings;
        }
        const providerName = String(webSettings.provider ?? options.provider ?? 'tavily');
        const factory = PROVIDER_REGISTRY[providerName];
        if (!factory) {
          return {
            ok: false,
            error: `未知的搜索 provider "${providerName}"。可用选项：${Object.keys(PROVIDER_REGISTRY).join(', ')}`,
          };
        }
        const provider = factory();

        // key 三源链：行配置直配 → ac-credentials（Agent 级→全局）→ 环境变量
        let apiKey = options.apiKeys?.[providerName] ?? '';
        if (!apiKey && call.agentId !== undefined) {
          const credentials = ctx.get('credentials');
          apiKey = credentials?.resolve(call.agentId, providerName) ?? '';
        }
        if (!apiKey && call.agentId === undefined) {
          apiKey = ctx.get('credentials')?.getGlobal(providerName) ?? '';
        }
        if (!apiKey) {
          const envVar = ENV_KEY_MAP[providerName];
          if (envVar && process.env[envVar]) apiKey = process.env[envVar]!;
        }

        const providerCfg: ProviderConfig = {
          apiKey,
          ...(typeof webSettings.baseURL === 'string' && webSettings.baseURL.trim()
            ? { baseURL: webSettings.baseURL.trim() }
            : {}),
          ...(typeof webSettings.model === 'string' && webSettings.model.trim() ? { model: webSettings.model.trim() } : {}),
          ...(positiveInt(webSettings.maxUses) !== undefined ? { maxUses: positiveInt(webSettings.maxUses) } : {}),
          ...(positiveInt(webSettings.maxTokens) !== undefined ? { maxTokens: positiveInt(webSettings.maxTokens) } : {}),
          ...(typeof webSettings.apiVersion === 'string' && webSettings.apiVersion.trim()
            ? { apiVersion: webSettings.apiVersion.trim() }
            : {}),
        };
        provider.validateConfig(providerCfg);

        call.onProgress?.(`正在使用 ${provider.label} 搜索: ${String(args.query)}...\n`);

        const params: SearchParams = {
          query: String(args.query ?? ''),
          search_depth: (args.search_depth as SearchParams['search_depth']) ?? webSettings.defaultDepth ?? options.defaultDepth ?? 'advanced',
          max_results: (args.max_results as number) ?? webSettings.defaultResults ?? options.defaultResults ?? 5,
          topic: (args.topic as SearchParams['topic']) ?? webSettings.defaultTopic ?? options.defaultTopic ?? 'general',
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
        truncateRawContent(data.results, webSettings.rawContentMaxLen ?? options.rawContentMaxLen ?? 2000);

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

  // ---- browser：真实 Chromium 操作（ctx.browser 守护进程）----
  ctx.tools.register({
    name: 'browser',
    description:
      '操作浏览器：open 打开页面、click 点击、type 输入、press 按键、content 提取文本、screenshot 截图、html 取源码、eval 执行 JS、close 关闭。可用 steps 批量执行多个动作。',
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
