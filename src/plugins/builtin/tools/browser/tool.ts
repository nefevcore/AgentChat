import { Tool } from '@core/types';
import { meta } from './meta';
import { logger } from '@utils/logger';
import { spawn, ChildProcess } from 'child_process';
import { getGlobalConfig } from '@agents/config';
import * as path from 'path';

// ── 模块级单例 ──
let daemon: ChildProcess | null = null;
let readyResolve: (() => void) | null = null;
let pendingCmd: ((v: string) => void) | null = null;
let buffer = '';
let daemonBooted = false;
let daemonGen = 0; // 代数计数器，防止 close 后旧 exit 事件误杀新 daemon

function boot(): Promise<void> {
  if (daemonBooted && daemon && !daemon.killed) return Promise.resolve();

  const config = getGlobalConfig();
  const workspace = (config as any).workspace || 'workspace/default';
  const scriptPath = path.resolve(workspace, 'files/shared/scripts/browser_daemon.py');

  logger.info(`[browser] 启动守护进程: ${scriptPath}`);
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

          // 启动阶段：等 ready
          if (msg.status === 'ready') {
            logger.info('[browser] 守护进程就绪');
            daemonBooted = true;
            if (readyResolve) { readyResolve(); readyResolve = null; }
            continue;
          }
          if (msg.status === 'starting') continue;
        } catch {}

        // 运行时：交给 pendingCmd
        if (pendingCmd) {
          const cb = pendingCmd;
          pendingCmd = null;
          cb(line.trim());
        }
      }
    });

    daemon!.stderr!.on('data', (chunk: Buffer) => {
      logger.warn(`[browser:stderr] ${chunk.toString('utf-8').trim()}`);
    });

    daemon!.on('exit', (code) => {
      logger.info(`[browser] 退出 gen=${currentGen}, code=${code}`);
      if (currentGen !== daemonGen) {
        logger.info(`[browser] gen=${currentGen} 退出被忽略，当前 gen=${daemonGen}`);
        return;
      }
      if (!daemonBooted && readyResolve) {
        readyResolve(); readyResolve = null;
      }
      daemon = null;
      daemonBooted = false;
    });

    daemon!.on('error', (err) => {
      if (!daemonBooted && readyResolve) {
        readyResolve(); readyResolve = null;
      }
      reject(err);
    });
  });
}

function send(action: Record<string, any>): Promise<string> {
  return new Promise((resolve, reject) => {
    // 确保启动
    const ensureBoot = async () => {
      try {
        if (!daemonBooted) await boot();

        const json = JSON.stringify(action);
        const timeout = setTimeout(() => {
          pendingCmd = null;
          reject(new Error(`browser timeout: ${action.action}`));
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

// ── 工具定义 ──

/** 等待指定毫秒（steps 批量模式中 step.delayMs 用） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把 daemon 返回的截图绝对路径转成工作区相对路径（前端 /api/workspace/file 预览用）。
 * workspaceDir 可能是相对路径（'workspace/default'），需 resolve 成绝对再比较。
 */
function attachRelPath(parsed: any): void {
  try {
    if (!parsed || typeof parsed.file !== 'string') return;
    const wsDir = getGlobalConfig().workspaceDir || 'workspace/default';
    const abs = parsed.file.replace(/\\/g, '/');
    const wsAbs = path.resolve(wsDir).replace(/\\/g, '/');
    if (wsAbs && abs.startsWith(wsAbs)) {
      parsed.relPath = abs.slice(wsAbs.length + 1);
    }
  } catch { /* 保留原始 file 字段 */ }
}

/** 从 step 对象构建 daemon 命令（取 action + 各动作参数） */
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

/**
 * 批量执行步骤序列（steps 模式）。
 * 每步可选 repeat（重复次数，默认 1）与 delayMs（执行后等待毫秒）。
 * continueOnError=false 时遇错即停，返回已成功部分。
 */
async function runSteps(
  steps: any[],
  continueOnError: boolean
): Promise<string> {
  const results: any[] = [];
  let fail: { step: number; action: string; message: string } | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const action = step.action as string;
    const repeat = Math.max(1, Math.min(20, Number(step.repeat) || 1)); // 防呆 1-20 次
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

        // daemon 返回 status:error（如元素未找到、超时）也视为该步失败
        if (parsed && parsed.status === 'error') {
          throw new Error(parsed.message || 'browser action failed: ' + action);
        }

        // screenshot：把绝对路径转成工作区相对路径（前端 /api/workspace/file 预览用）
        attachRelPath(parsed);

        results.push({ step: i + 1, action, repeat: r + 1, params: step, result: parsed });

        // close 后 daemon 已退出，重置单例状态
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

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'browser',
      description: `操作真实 Chromium 浏览器。先用 action="open" 导航，再用 "click"/"type"/"press" 交互，"content" 提取文本和链接，"screenshot" 截图，"close" 关闭。
浏览器在调用间保持驻留——打开一次，可多次交互。

两种模式：
1. 单动作：action + 对应参数
2. 批量：steps 数组依次执行多个动作（每个 step 含 action + 参数，可选 repeat 重复次数、delayMs 执行后等待毫秒），适合重复动作/多步操作一次完成；continueOnError=true 遇错继续

Actions:
- open: { url } — 导航到 URL
- click: { selector } — 点击元素
- type: { selector, text } — 输入文本
- press: { key } — 键盘按键（Enter、Tab、Escape）
- content: {} — 提取可见文本（最多 5000 字符）
- screenshot: { name? } — 整页截图
- html: {} — 获取 HTML 长度
- eval: { js } — 执行 JavaScript
- close: {} — 关闭浏览器释放内存

批量示例（打开→输入→回车→提取）：
{"steps":[{"action":"open","url":"https://example.com"},{"action":"type","selector":"#q","text":"hello"},{"action":"press","key":"Enter","delayMs":1500},{"action":"content"}]}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'],
            description: '操作类型（单动作模式；批量模式请用 steps）',
          },
          url: { type: 'string', description: '目标 URL（action=open 时必需）' },
          selector: { type: 'string', description: 'CSS 选择器（action=click/type 时必需）' },
          text: { type: 'string', description: '输入文本（action=type 时必需）' },
          key: { type: 'string', description: '按键名如 Enter/Tab（action=press 时必需）' },
          name: { type: 'string', description: '截图文件名（action=screenshot 时可选）' },
          js: { type: 'string', description: 'JavaScript 代码（action=eval 时必需）' },
          steps: {
            type: 'array',
            description: '批量动作序列：依次执行。每项：{ action, url?, selector?, text?, key?, name?, js?, repeat?, delayMs? }。repeat=重复次数（默认1，最多20）；delayMs=执行后等待毫秒（如等页面加载）',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'],
                  description: '动作类型',
                },
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
          continueOnError: {
            type: 'boolean',
            description: '批量模式：某步失败是否继续执行后续步骤（默认 false 遇错即停）',
          },
        },
      },
    },
  },

  execute: async (args, stream?) => {
    // 批量模式：steps 数组依次执行多个动作（支持 repeat/delayMs/continueOnError）
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

      // screenshot：把绝对路径转成工作区相对路径（前端 /api/workspace/file 预览用）
      if (action === 'screenshot') {
        try {
          const parsed = JSON.parse(result);
          attachRelPath(parsed);
          return JSON.stringify(parsed);
        } catch { /* 非 JSON 或转换失败，返回原样 */ }
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
};
