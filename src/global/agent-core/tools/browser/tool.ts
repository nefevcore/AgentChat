import { Tool } from '@core/types';
import { meta } from './meta';
import { logger } from '@utils/logger';
import { spawn, ChildProcess } from 'child_process';
import { getGlobalConfig } from '@core/config';
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

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'browser',
      description: `操作真实 Chromium 浏览器。先用 action="open" 导航，再用 "click"/"type"/"press" 交互，"content" 提取文本和链接，"screenshot" 截图，"close" 关闭。
浏览器在调用间保持驻留——打开一次，可多次交互。

Actions:
- open: { url } — 导航到 URL
- click: { selector } — 点击元素
- type: { selector, text } — 输入文本
- press: { key } — 键盘按键（Enter、Tab、Escape）
- content: {} — 提取可见文本（最多 5000 字符）
- screenshot: { name? } — 整页截图
- html: {} — 获取 HTML 长度
- eval: { js } — 执行 JavaScript
- close: {} — 关闭浏览器释放内存`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'click', 'type', 'press', 'content', 'screenshot', 'html', 'eval', 'close'],
            description: '操作类型',
          },
          url: { type: 'string', description: '目标 URL（action=open 时必需）' },
          selector: { type: 'string', description: 'CSS 选择器（action=click/type 时必需）' },
          text: { type: 'string', description: '输入文本（action=type 时必需）' },
          key: { type: 'string', description: '按键名如 Enter/Tab（action=press 时必需）' },
          name: { type: 'string', description: '截图文件名（action=screenshot 时可选）' },
          js: { type: 'string', description: 'JavaScript 代码（action=eval 时必需）' },
        },
        required: ['action'],
      },
    },
  },

  execute: async (args, stream?) => {
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
