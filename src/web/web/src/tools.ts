// ============================================================
// @agentchat/web —— 网络工具（web_search + browser）
// 迁移自 tools/web.ts（web_search/browser 部分）；领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { defineTool, workspaceRoot, NS_TOOL_WEB_SEARCH } from '@agentchat/toolkit';
import { getNamespaceConfig, CAPABILITY_BASE } from '@agentchat/agent-config';
import { getCredential } from '@agentchat/agents';
import { readLogs, clearLogBuffer, createLogger } from '@agentchat/util';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import { createTavilyProvider } from './web-search/tavily';
import { createSerpApiProvider } from './web-search/serpapi';
import { createBraveProvider } from './web-search/brave';
import { createDuckDuckGoProvider } from './web-search/duckduckgo';
import { createDeepSeekProvider } from './web-search/deepseek';
import type { SearchParams, SearchProvider, SearchProviderFactory, ProviderConfig } from './web-search/types';

const log = createLogger('[web:tools]');

const PROVIDER_REGISTRY: Record<string, SearchProviderFactory> = {
  tavily: createTavilyProvider,
  serpapi: createSerpApiProvider,
  brave: createBraveProvider,
  duckduckgo: createDuckDuckGoProvider,
  deepseek: createDeepSeekProvider,
};

const DEFAULT_PROVIDER = 'tavily';

/** 从 WebSearchConfig 解析 API Key（config → 凭据存储 → 环境变量；照搬旧） */
function resolveApiKey(cfg: Record<string, any>, providerId: string): string {
  const cfgMap: Record<string, string> = {
    tavily: cfg.tavilyApiKey ?? '',
    serpapi: cfg.serpapiApiKey ?? '',
    brave: cfg.braveApiKey ?? '',
    duckduckgo: '',
    deepseek: cfg.deepseekApiKey ?? '',
  };
  const fromConfig = cfgMap[providerId];
  if (fromConfig) return fromConfig;

  const $ref = cfg.$ref as string | undefined;
  if ($ref) {
    const fromCred = getCredential('__global__', `searchpool:${$ref}`);
    if (fromCred) return fromCred;
  }

  // 自动查找 searchProviders 池的 default 条目（配置经 ToolContext 注入）
  const pools = (cfg._searchProviders ?? {}) as Record<string, Record<string, unknown>>;
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  const def = entries.find(([, v]) => v && (v as any).default);
  if (def) {
    const fromPool = getCredential('__global__', `searchpool:${def[0]}`);
    if (fromPool) return fromPool;
  }

  const fromCredDirect = getCredential('__global__', providerId);
  if (fromCredDirect) return fromCredDirect;

  const envMap: Record<string, string> = {
    tavily: 'TAVILY_API_KEY',
    serpapi: 'SERPAPI_API_KEY',
    brave: 'BRAVE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
  };
  const envVar = envMap[providerId];
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  return '';
}

/** 内嵌 ns 配置无 provider 但带了某 provider 的 key 字段时按字段推断 */
function inferProviderFromKeyField(ns: Record<string, any>): string | undefined {
  if (ns.tavilyApiKey) return 'tavily';
  if (ns.serpapiApiKey) return 'serpapi';
  if (ns.braveApiKey) return 'brave';
  if (ns.deepseekApiKey) return 'deepseek';
  return undefined;
}

/** 正整数校验（池条目数字字段防御；非法值交由 provider 内置默认） */
function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 构建 provider 运行时配置（deepseek 扩展字段经命名空间/池条目透传，其余 provider 忽略） */
function buildProviderConfig(cfg: Record<string, any>, providerId: string): ProviderConfig {
  return {
    apiKey: resolveApiKey(cfg, providerId),
    ...(typeof cfg.baseURL === 'string' && cfg.baseURL.trim() ? { baseURL: cfg.baseURL.trim() } : {}),
    ...(typeof cfg.model === 'string' && cfg.model.trim() ? { model: cfg.model.trim() } : {}),
    ...(positiveInt(cfg.maxUses) !== undefined ? { maxUses: positiveInt(cfg.maxUses) } : {}),
    ...(positiveInt(cfg.maxTokens) !== undefined ? { maxTokens: positiveInt(cfg.maxTokens) } : {}),
    ...(typeof cfg.apiVersion === 'string' && cfg.apiVersion.trim() ? { apiVersion: cfg.apiVersion.trim() } : {}),
  };
}

/** 按名称获取 provider 实例（带校验） */
function getProvider(providerName: string, cfg: Record<string, any>): SearchProvider {
  const factory = PROVIDER_REGISTRY[providerName];
  if (!factory) {
    const available = Object.keys(PROVIDER_REGISTRY).join(', ');
    throw new Error(`未知的搜索 provider "${providerName}"。可用选项：${available}`);
  }
  const provider = factory();
  provider.validateConfig(buildProviderConfig(cfg, providerName));
  return provider;
}

/** 截断原始内容 */
function truncateRawContent(results: Array<{ raw_content?: string | null }>, maxLen: number): void {
  for (const r of results) {
    if (r.raw_content && r.raw_content.length > maxLen) {
      r.raw_content = r.raw_content.substring(0, maxLen) + '…';
    }
  }
}

/** web_search 工具（照搬旧，配置经 ToolContext 注入） */
export function makeWebSearchTool(config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'web_search', label: '网络搜索', ns: NS_TOOL_WEB_SEARCH, requires: [CAPABILITY_BASE],
    description: '搜索互联网，获取最新信息。',
    // 2026-08-20 简化：主用 DeepSeek 搜索（仅消费 query）；条数/深度等 provider 级
    // 调优走 tool.web_search 命名空间配置，不再暴露给 LLM。其余参数 execute 层兼容。
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        description: { type: 'string', description: '搜索目的的一句话说明（用于任务列表展示）' },
      },
      required: ['query'],
    },
    extractLabel: (args) => (typeof args.description === 'string' && args.description.trim())
      ? args.description.trim()
      : `搜索 ${String(args.query || '').slice(0, 40)}`,
    execute: async (args, stream) => {
      try {
        // 命名空间配置 + searchProviders 池（L5 注入）
        const ns = getNamespaceConfig(config, NS_TOOL_WEB_SEARCH) as Record<string, any>;
        // 无 ns 配置时按池推断 provider：default 条目优先，无则首项（与 loader resolveSearchPool 语义对齐）
        const pools = (services.searchProviders ?? {}) as Record<string, any>;
        const poolEntries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
        const defPool = poolEntries.find(([, v]) => v && (v as any).default) ?? poolEntries[0];
        const defPoolEntry = defPool?.[1] as Record<string, any> | undefined;
        const wsCfg: Record<string, any> = {
          provider: ns.provider || inferProviderFromKeyField(ns) || defPoolEntry?.provider || DEFAULT_PROVIDER,
          tavilyApiKey: ns.tavilyApiKey,
          serpapiApiKey: ns.serpapiApiKey,
          braveApiKey: ns.braveApiKey,
          deepseekApiKey: ns.deepseekApiKey,
          // deepseek 扩展字段（池条目经 loader 的 resolveSearchPool 合并进 ns）
          baseURL: ns.baseURL,
          model: ns.model,
          maxUses: ns.maxUses,
          maxTokens: ns.maxTokens,
          apiVersion: ns.apiVersion,
          defaultResults: ns.defaultResults ?? defPoolEntry?.defaultResults ?? 5,
          defaultDepth: ns.defaultDepth ?? defPoolEntry?.defaultDepth ?? 'advanced',
          defaultTopic: ns.defaultTopic ?? defPoolEntry?.defaultTopic ?? 'general',
          rawContentMaxLen: ns.rawContentMaxLen ?? defPoolEntry?.rawContentMaxLen ?? 2000,
          _searchProviders: services.searchProviders ?? {},
        };

        const providerName = wsCfg.provider;
        const provider = getProvider(providerName, wsCfg);

        stream?.onChunk?.(`正在使用 ${provider.label} 搜索: ${args.query}...\n`);

        const params: SearchParams = {
          query: args.query as string,
          search_depth: (args.search_depth as SearchParams['search_depth']) ?? wsCfg.defaultDepth,
          max_results: (args.max_results as number) ?? wsCfg.defaultResults,
          topic: (args.topic as SearchParams['topic']) ?? wsCfg.defaultTopic,
        };
        if (args.include_domains?.length) params.include_domains = args.include_domains as string[];
        if (args.exclude_domains?.length) params.exclude_domains = args.exclude_domains as string[];
        if (args.time_range) params.time_range = args.time_range as SearchParams['time_range'];
        if (args.include_answer !== undefined) params.include_answer = args.include_answer as boolean;
        if (args.include_raw_content !== undefined) params.include_raw_content = args.include_raw_content as boolean;

        const data = await provider.search(params, buildProviderConfig(wsCfg, providerName));
        truncateRawContent(data.results, wsCfg.rawContentMaxLen);

        stream?.onChunk?.(
          `搜索完成，找到 ${data.results.length} 个结果` +
          (data.answer ? '（含 AI 摘要）' : '') +
          ` (${data.response_time.toFixed(1)}s)\n`
        );

        return JSON.stringify({
          status: 'success',
          provider: providerName,
          data: { query: data.query, results: data.results, answer: data.answer ?? null, response_time: data.response_time, credits_used: data.credits_used ?? null },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { query: args.query, message: err.message || String(err) } });
      }
    },
  });
}

// ============================================================
// browser —— 操作真实 Chromium（python 守护进程）
// ============================================================

let daemon: ChildProcess | null = null;
let readyResolve: (() => void) | null = null;
let pendingCmd: ((v: string) => void) | null = null;
let buffer = '';
let daemonBooted = false;
let daemonGen = 0;

function boot(): Promise<void> {
  if (daemonBooted && daemon && !daemon.killed) return Promise.resolve();

  const workspace = workspaceRoot();
  const scriptPath = path.resolve(workspace, 'files/shared/scripts/browser_daemon.py');

  log.info(`启动守护进程: ${scriptPath}`);
  daemonBooted = false;
  buffer = '';

  const currentGen = ++daemonGen;
  daemon = spawn('python', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

  return new Promise<void>((resolve, reject) => {
    readyResolve = resolve;

    daemon!.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.status === 'ready') {
            log.info('守护进程就绪');
            daemonBooted = true;
            if (readyResolve) { readyResolve(); readyResolve = null; }
            continue;
          }
          if (msg.status === 'starting') continue;
        } catch { /* 非 JSON */ }

        if (pendingCmd) {
          const cb = pendingCmd;
          pendingCmd = null;
          cb(line.trim());
        }
      }
    });

    daemon!.stderr!.on('data', (chunk: Buffer) => {
      log.warn(`[browser:stderr] ${chunk.toString('utf-8').trim()}`);
    });

    daemon!.on('exit', (code) => {
      log.info(`退出 gen=${currentGen}, code=${code}`);
      if (currentGen !== daemonGen) {
        log.info(`gen=${currentGen} 退出被忽略，当前 gen=${daemonGen}`);
        return;
      }
      if (!daemonBooted && readyResolve) {
        readyResolve(); readyResolve = null;
      }
      daemon = null;
      daemonBooted = false;
    });

    daemon!.on('error', (err) => {
      log.error(`守护进程错误: ${err.message}`);
      if (readyResolve) { readyResolve(); readyResolve = null; }
    });

    daemon!.on('spawn', () => { /* 等待 ready */ });
  });
}

/** 发送单条命令给 daemon */
function send(cmd: Record<string, any>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ensureBoot = async () => {
      try {
        await boot();
        const json = JSON.stringify(cmd);
        const timeout = setTimeout(() => {
          pendingCmd = null;
          reject(new Error(`browser timeout: ${cmd.action}`));
        }, 35000);

        pendingCmd = (result: string) => {
          clearTimeout(timeout);
          resolve(result);
        };

        daemon!.stdin!.write(json + '\n');
      } catch (e: any) {
        reject(e);
      }
    };
    ensureBoot();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 daemon 返回的截图绝对路径转成工作区相对路径 */
function attachRelPath(parsed: any): void {
  try {
    if (!parsed || typeof parsed.file !== 'string') return;
    const wsDir = workspaceRoot();
    const abs = parsed.file.replace(/\\/g, '/');
    const wsAbs = wsDir.replace(/\\/g, '/');
    if (wsAbs && abs.startsWith(wsAbs)) {
      parsed.relPath = abs.slice(wsAbs.length + 1);
    }
  } catch { /* 保留原始 file 字段 */ }
}

function buildCmd(step: Record<string, any>): Record<string, any> {
  const cmd: Record<string, any> = { action: step.action };
  if (step.url !== undefined) cmd.url = step.url;
  if (step.selector !== undefined) cmd.selector = step.selector;
  if (step.text !== undefined) cmd.text = step.text;
  if (step.key !== undefined) cmd.key = step.key;
  if (step.name !== undefined) cmd.name = step.name;
  if (step.js !== undefined) cmd.js = step.js;
  return cmd;
}

/** 批量执行步骤序列（照搬旧） */
async function runSteps(steps: any[], continueOnError: boolean): Promise<string> {
  const results: any[] = [];
  let fail: { step: number; action: string; message: string } | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const action = step.action as string;
    const repeat = Math.max(1, Math.min(20, Number(step.repeat) || 1));
    // delay_ms 正典 / delayMs 旧名
    const delayMs = Math.max(0, Number(step.delay_ms ?? step.delayMs) || 0);

    for (let r = 0; r < repeat; r++) {
      try {
        const cmd = buildCmd(step);
        const raw = await send(cmd);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { status: 'ok', raw };
        }

        if (parsed && parsed.status === 'error') {
          throw new Error(parsed.message || 'browser action failed: ' + action);
        }

        attachRelPath(parsed);
        results.push({ step: i + 1, action, repeat: r + 1, params: step, result: parsed });

        if (cmd.action === 'close') {
          daemon = null;
          daemonBooted = false;
        }
        if (delayMs > 0) await sleep(delayMs);
      } catch (e: any) {
        const err = { step: i + 1, action, message: e.message };
        if (!continueOnError) {
          fail = err;
          break;
        }
        results.push({ step: i + 1, action, repeat: r + 1, status: 'error', message: e.message });
      }
    }
    if (fail) break;
  }

  return JSON.stringify(
    fail
      ? { status: 'error', failedStep: fail.step, message: fail.message, results }
      : { status: 'ok', count: results.length, results }
  );
}

/** browser 工具（照搬旧） */
export function makeBrowserTool(_config: AgentConfig): Tool {
  return defineTool({
    name: 'browser', label: '浏览器', requires: [CAPABILITY_BASE],
    description: '操作浏览器：open 打开页面、click 点击、type 输入、press 按键、content 提取文本、screenshot 截图、html 取源码、eval 执行 JS、close 关闭。可用 steps 批量执行多个动作。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'], description: '要执行的动作' },
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
              action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'], description: '动作' },
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
    extractLabel: (args) => {
      const action = Array.isArray(args.steps) ? `steps[${args.steps.length}]` : (args.action || '?');
      return `${action}`;
    },
    execute: async (args, _stream) => {
      if (Array.isArray(args.steps) && args.steps.length > 0) {
        // continue_on_error 正典 / continueOnError 旧名
        return runSteps(args.steps, !!(args.continue_on_error ?? args.continueOnError));
      }

      const action = args.action as string;
      try {
        const cmd: Record<string, any> = { action };
        if (args.url) cmd.url = args.url;
        if (args.selector) cmd.selector = args.selector;
        if (args.text) cmd.text = args.text;
        if (args.key) cmd.key = args.key;
        if (args.name) cmd.name = args.name;
        if (args.js) cmd.js = args.js;

        const result = await send(cmd);

        if (action === 'screenshot') {
          try {
            const parsed = JSON.parse(result);
            attachRelPath(parsed);
            return JSON.stringify(parsed);
          } catch { /* 原样返回 */ }
        }

        if (action === 'close') {
          daemon = null;
          daemonBooted = false;
        }

        return result;
      } catch (e: any) {
        return JSON.stringify({ status: 'error', message: e.message });
      }
    },
  });
}

/** 网络/独立工具工厂 */

/** 网络工具族（web_search + browser） */
export function makeWebTools(config: AgentConfig, services: ToolContext): Tool[] {
  return [makeWebSearchTool(config, services), makeBrowserTool(config)];
}
