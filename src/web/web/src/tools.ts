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
import type { SearchParams, SearchProvider, SearchProviderFactory, ProviderConfig } from './web-search/types';

const log = createLogger('[web:tools]');

const PROVIDER_REGISTRY: Record<string, SearchProviderFactory> = {
  tavily: createTavilyProvider,
  serpapi: createSerpApiProvider,
  brave: createBraveProvider,
  duckduckgo: createDuckDuckGoProvider,
};

const DEFAULT_PROVIDER = 'tavily';

/** 从 WebSearchConfig 解析 API Key（config → 凭据存储 → 环境变量；照搬旧） */
function resolveApiKey(cfg: Record<string, any>, providerId: string): string {
  const cfgMap: Record<string, string> = {
    tavily: cfg.tavilyApiKey ?? '',
    serpapi: cfg.serpapiApiKey ?? '',
    brave: cfg.braveApiKey ?? '',
    duckduckgo: '',
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
  };
  const envVar = envMap[providerId];
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  return '';
}

/** 构建 provider 运行时配置 */
function buildProviderConfig(cfg: Record<string, any>, providerId: string): ProviderConfig {
  return { apiKey: resolveApiKey(cfg, providerId) };
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
    description: '实时网络搜索，获取最新/外部信息（新闻、文档、事实核查、价格、天气等）。返回结构化结果列表（标题/链接/摘要），可请求 AI 摘要（include_answer=true）。需要管理员在全局设置中配置搜索 Provider 与 API Key。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '结果条数（默认 5）' },
        search_depth: { type: 'string', enum: ['basic', 'advanced'], description: '搜索深度（默认 advanced）' },
        topic: { type: 'string', enum: ['general', 'news', 'finance'], description: '主题（默认 general）' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'], description: '时间范围' },
        include_domains: { type: 'array', items: { type: 'string' }, description: '仅搜索这些域名' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: '排除这些域名' },
        include_answer: { type: 'boolean', description: '是否包含 AI 摘要（默认 false）' },
        include_raw_content: { type: 'boolean', description: '是否包含原始内容（默认 false）' },
      },
      required: ['query'],
    },
    extractLabel: (args) => `搜索 ${String(args.query || '').slice(0, 40)}`,
    execute: async (args, stream) => {
      try {
        // 命名空间配置 + searchProviders 池（L5 注入）
        const ns = getNamespaceConfig(config, NS_TOOL_WEB_SEARCH) as Record<string, any>;
        const wsCfg: Record<string, any> = {
          provider: ns.provider || DEFAULT_PROVIDER,
          tavilyApiKey: ns.tavilyApiKey,
          serpapiApiKey: ns.serpapiApiKey,
          braveApiKey: ns.braveApiKey,
          defaultResults: 5,
          defaultDepth: 'advanced',
          defaultTopic: 'general',
          rawContentMaxLen: 2000,
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
    const delayMs = Math.max(0, Number(step.delayMs) || 0);

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
    description: '操作真实 Chromium 浏览器。先用 action="open" 导航，再用 "click"/"type"/"press" 交互，"content" 提取文本和链接，"screenshot" 截图，"close" 关闭。浏览器在调用间保持驻留——打开一次，可多次交互。\n\n两种模式：1. 单动作：action + 对应参数；2. 批量：steps 数组依次执行多个动作（每个 step 含 action + 参数，可选 repeat 重复次数、delayMs 执行后等待毫秒），适合重复动作/多步操作一次完成；continueOnError=true 遇错继续\n\nActions: open{url}/click{selector}/type{selector,text}/press{key}/content{}/screenshot{name?}/html{}/eval{js}/close{}',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'], description: '操作类型（单动作模式；批量模式请用 steps）' },
        url: { type: 'string', description: '目标 URL（action=open 时必需）' },
        selector: { type: 'string', description: 'CSS 选择器（action=click/type 时必需）' },
        text: { type: 'string', description: '输入文本（action=type 时必需）' },
        key: { type: 'string', description: '按键名如 Enter/Tab（action=press 时必需）' },
        name: { type: 'string', description: '截图文件名（action=screenshot 时可选）' },
        js: { type: 'string', description: 'JavaScript 代码（action=eval 时必需）' },
        steps: {
          type: 'array',
          description: '批量动作序列：依次执行。每项：{ action, url?, selector?, text?, key?, name?, js?, repeat?, delayMs? }。repeat=重复次数（默认1，最多20）；delayMs=执行后等待毫秒',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'], description: '动作类型' },
              url: { type: 'string', description: '目标 URL（open 时）' },
              selector: { type: 'string', description: 'CSS 选择器（click/type 时）' },
              text: { type: 'string', description: '输入文本（type 时）' },
              key: { type: 'string', description: '按键名（press 时）' },
              name: { type: 'string', description: '截图文件名（screenshot 时）' },
              js: { type: 'string', description: 'JavaScript 代码（eval 时）' },
              repeat: { type: 'number', description: '重复次数，默认 1，最多 20' },
              delayMs: { type: 'number', description: '执行后等待毫秒数，默认 0' },
            },
            required: ['action'],
          },
        },
        continueOnError: { type: 'boolean', description: '批量模式：某步失败是否继续执行后续步骤（默认 false 遇错即停）' },
      },
    },
    extractLabel: (args) => {
      const action = Array.isArray(args.steps) ? `steps[${args.steps.length}]` : (args.action || '?');
      return `${action}`;
    },
    execute: async (args, _stream) => {
      if (Array.isArray(args.steps) && args.steps.length > 0) {
        return runSteps(args.steps, !!args.continueOnError);
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
