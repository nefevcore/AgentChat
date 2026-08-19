// ============================================================
// @agentchat/boot/src/headless.ts —— headless 表面 CLI（P2 client）
//
// 用法：
//   agentchat headless --to <agentId> [提示词…]   # 提交一轮 → 流式打印 → 退出
//   agentchat headless --list                     # 列出可用 Agent
//
// 语义：读实例注册表 → 连 owner WS → chat.send → 渲染 chat.* 流事件 →
// chat.end 后退出。不 boot 组合树；无实例/实例死亡 → 明确报错提示
// `agentchat web`。并发多客户端（WebUI + headless）按 steer 语义共存：
// 消息按到达序处理，会话快照按连接隔离（WSHandler 现状行为）。
//
// stdin：提示词缺省且 stdin 非 TTY（管道/重定向）时读全量 stdin。
// 交互（ask_questions）：渲染问题+选项；stdin 为 TTY 时读一行作答。
// ============================================================
import * as readline from 'readline';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  connectInstance, onFrame, requireLiveInstance, sendFrame, type WSFrame,
} from './connect';

/** 渲染出口（可注入；缺省 process.stdout/stderr） */
export interface HeadlessIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface HeadlessOptions {
  /** 目标 Agent（缺省 = 列表模式） */
  to?: string;
  /** 提示词（缺省且 stdin 非 TTY 时读 stdin） */
  content?: string;
  /** workspace（缺省 AGENTCHAT_WORKSPACE / cwd 下 workspace/default） */
  workspaceDir?: string;
  /** 渲染出口（测试注入） */
  io?: HeadlessIO;
  /** WS 工厂（测试注入；缺省 connectInstance） */
  connect?: (port: number) => Promise<WebSocket>;
  /** 无 stdin 交互（测试；强制交互问题不读 stdin） */
  interactive?: boolean;
}

/** 单行截断（工具结果预览等） */
function oneLine(text: unknown, max = 120): string {
  const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** 事件归属过滤：广播面向所有连接，只关心目标 Agent 的流 */
function forTarget(frame: WSFrame, to?: string): boolean {
  if (!to) return true;
  const agentId = frame.data?.agentId ?? frame.data?.agent ?? frame.data?.agent_id;
  return !agentId || agentId === to;
}

/**
 * headless 主流程。返回进程退出码（不直接 process.exit，供测试）。
 */
export async function runHeadless(options: HeadlessOptions = {}): Promise<number> {
  const io: HeadlessIO = options.io ?? {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  };
  const connect = options.connect ?? ((port: number) => connectInstance({ port }));

  // 1. 发现实例（无/死亡 → 错误信息已含指引）
  let record: { pid: number; port: number; profile: string };
  try {
    record = requireLiveInstance(options.workspaceDir);
  } catch (err: any) {
    io.err(`✗ ${err?.message ?? String(err)}\n`);
    return 1;
  }

  // 2. 连接
  let ws: WebSocket;
  try {
    ws = await connect(record.port);
  } catch (err: any) {
    io.err(`✗ 实例在注册表（pid=${record.pid} port=${record.port}）但连接失败: ${err?.message ?? String(err)}\n`);
    return 1;
  }

  // 3a. 列表模式：agent.list → 打印 → 退
  if (!options.to) {
    return await listAgents(ws, io);
  }

  // 3b. 会话模式：取提示词 → chat.send → 流式渲染 → chat.end 退
  let content = options.content;
  if (content === undefined) {
    if (process.stdin.isTTY) {
      io.err('✗ 缺少提示词：agentchat headless --to <agentId> <提示词…>（或经 stdin 管道输入）\n');
      ws.close();
      return 2;
    }
    content = await readAllStdin();
  }

  const requestId = randomUUID();
  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* 已关闭 */
      }
      resolve(code);
    };

    let messageOpen = false; // chat.message.start → update(delta) → end
    let errored = false;

    const stopFrames = onFrame(ws, (frame) => {
      const { type, data } = frame;
      switch (type) {
        // ---- 回执 ----
        case 'chat.send.ack':
          if (data?.deduped) io.err('· 已投递（去重回执）\n');
          else if (data?.busy || data?.queued) io.err(`· ${oneLine(data?.message ?? '对方正在处理，已作为追加指令注入', 100)}\n`);
          break;

        // ---- 会话边界 ----
        case 'chat.start':
          if (forTarget(frame, options.to)) io.err(`▸ 会话开始\n`);
          break;
        case 'chat.end':
          if (!forTarget(frame, options.to)) break;
          io.out('\n');
          io.err('▸ 会话结束\n');
          finish(errored ? 1 : 0);
          break;

        // ---- 步骤/工具（stderr 单行，stdout 留给正文）----
        case 'chat.step.start':
          if (forTarget(frame, options.to)) io.err(`── step ${data?.step ?? ''} ──\n`);
          break;
        case 'chat.thinking.start':
          if (forTarget(frame, options.to)) io.err('··· 思考中\n');
          break;
        case 'chat.toolcall.start': {
          const call = Array.isArray(data?.tool_calls) ? data.tool_calls[0] : null;
          const name = call?.function?.name ?? data?.name ?? '';
          if (name) io.err(`🔧 调用工具 ${name}\n`);
          break;
        }
        case 'chat.tool_execution.start':
          if (data?.name || data?.label) io.err(`⚙ 执行 ${data.label ?? data.name}\n`);
          break;

        // ---- 正文流（stdout 直写 = 流式打印）----
        case 'chat.message.start':
          if (forTarget(frame, options.to)) messageOpen = true;
          break;
        case 'chat.message.update':
          if (messageOpen && forTarget(frame, options.to) && typeof data?.delta === 'string') {
            io.out(data.delta);
          }
          break;
        case 'chat.message.end':
          if (messageOpen) {
            io.out('\n');
            messageOpen = false;
          }
          break;
        case 'chat.message.error':
          if (forTarget(frame, options.to)) {
            errored = true;
            io.err(`✗ 消息错误: ${oneLine(data?.error ?? data?.message ?? frame.data, 200)}\n`);
          }
          break;

        // ---- 持久交互（ask_questions）----
        case 'chat.interaction':
          void handleInteraction(ws, frame, io, options);
          break;

        // ---- 协议错误 ----
        case 'error':
          io.err(`✗ 服务器错误: ${oneLine(data?.message ?? data, 200)}\n`);
          finish(1);
          break;
        default:
          break;
      }
    });

    ws.once('close', () => {
      stopFrames();
      if (!settled) {
        io.err('✗ 连接已断开（实例退出？）\n');
        finish(1);
      }
    });
    ws.once('error', (err) => {
      io.err(`✗ WS 错误: ${(err as Error).message}\n`);
      finish(1);
    });

    sendFrame(ws, 'chat.send', {
      to: options.to,
      content,
      deepThink: false,
      files: [],
      requestId,
    });
  });
}

/** agent.list → 打印 → 退出码 */
async function listAgents(ws: WebSocket, io: HeadlessIO): Promise<number> {
  return await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      io.err('✗ 等待 agent.list.response 超时\n');
      try { ws.close(); } catch { /* noop */ }
      resolve(1);
    }, 5000);
    const stop = onFrame(ws, (frame) => {
      if (frame.type !== 'agent.list.response') return;
      clearTimeout(timer);
      stop();
      const agents: Array<{ id?: string; name?: string; virtual?: boolean }> = frame.data?.agents ?? [];
      if (agents.length === 0) io.out('（无 Agent）\n');
      for (const a of agents) {
        io.out(`${a.virtual ? '·' : '●'} ${a.id ?? '?'}${a.name ? ` — ${a.name}` : ''}\n`);
      }
      try { ws.close(); } catch { /* noop */ }
      resolve(0);
    });
    sendFrame(ws, 'agent.list');
    ws.once('close', () => {
      clearTimeout(timer);
      resolve(0); // close 前已 resolve 的场景由 settled 语义兜底（重复 resolve 无害）
    });
  });
}

/** 渲染交互问题；TTY 时读一行作答（非 TTY 提示需到 WebUI 回答） */
async function handleInteraction(ws: WebSocket, frame: WSFrame, io: HeadlessIO, options: HeadlessOptions): Promise<void> {
  const d = frame.data ?? {};
  const id = d.interaction_id as string | undefined;
  if (!id) return;
  io.out(`\n❓ ${oneLine(d.question ?? '（未提供问题）', 200)}\n`);
  const opts: string[] = Array.isArray(d.options) ? d.options.map(String) : [];
  opts.forEach((o, i) => io.out(`   ${i + 1}. ${oneLine(o, 120)}\n`));
  if (d.allow_custom) io.out('   （可自定义输入）\n');

  const interactive = options.interactive ?? !!process.stdin.isTTY;
  if (!interactive) {
    io.err('· 非交互终端：请到 WebUI 回答该问题（回答后本会话继续）\n');
    return;
  }
  const answer = await new Promise<string | null>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('答案（序号或文本）: ', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
  if (answer === null) return;
  const idx = Number(answer);
  const choice = opts.length > 0 && Number.isInteger(idx) && idx >= 1 && idx <= opts.length
    ? opts[idx - 1]
    : answer;
  sendFrame(ws, 'chat.interact.respond', { interaction_id: id, choice });
  io.err(`· 已回答: ${oneLine(choice, 100)}\n`);
}

/** 读全量 stdin（管道/重定向场景） */
function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.resume();
  });
}

// ============================================================
// CLI 入口（bin/agentchat.js headless → 本文件；repo 经 tsx，发布经 dist）
// ============================================================
function parseArgs(argv: string[]): { to?: string; list: boolean; prompt: string[] } {
  let to: string | undefined;
  let list = false;
  const prompt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--to' || arg === '--agent') {
      to = argv[++i];
      if (!to) {
        console.error('error: --to 需要一个 Agent ID');
        process.exit(2);
      }
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: agentchat headless [--to <agentId> <提示词…>] [--list]');
      process.exit(0);
    } else {
      prompt.push(arg);
    }
  }
  return { to, list, prompt };
}

async function main(): Promise<void> {
  const { to, prompt } = parseArgs(process.argv.slice(2));
  const code = await runHeadless({
    to,
    content: prompt.length > 0 ? prompt.join(' ') : undefined,
  });
  process.exit(code);
}

// 直接作为入口运行时（tsx 源码路径 / dist 打包路径）
if (process.argv[1] && (process.argv[1].endsWith('headless.ts') || process.argv[1].endsWith('headless.mjs'))) {
  void main();
}
