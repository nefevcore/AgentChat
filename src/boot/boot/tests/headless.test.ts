// ============================================================
// P2 测试：headless 表面（connect.ts + headless.ts）
//
// 迷你 WS 服务模拟 owner（同 /ws 帧协议：{ type, data }），
// runHeadless 注入 io/connect 做进程内 e2e（含错误路径）。
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { runHeadless } from '../src/headless';
import { requireLiveInstance, runtimeFilePath } from '../src/connect';
import { acquireRuntime, releaseRuntime, runtimeFilePath as runtimePathOf } from '@agentchat/toolkit';

/** 伪造 owner 运行时标识（活 = 本进程获取；死 = 直接写死 pid 记录） */
function fakeOwner(dir: string, port: number, opts: { dead?: boolean } = {}): void {
  if (opts.dead) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(runtimePathOf(dir), JSON.stringify({
      pid: 999_999_999, startedAt: '', kind: 'web-app', port,
      profile: 'web-app', workspaceDir: dir, nodeVersion: '',
    }), 'utf8');
    return;
  }
  acquireRuntime(dir, { kind: 'web-app', port, profile: 'web-app', workspaceDir: dir });
}

let tmp: string;
let server: WebSocketServer | null = null;
let serverPort = 0;

/** 收集型 io */
function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: {
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/** 起迷你 owner WS 服务；handler 收到帧时回调（返回伪响应序列的剧本由用例闭包持有） */
function startMiniOwner(onFrame: (frame: any, reply: (type: string, data?: any) => void, ws: WsSocket) => void): Promise<void> {
  return new Promise((resolve) => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      serverPort = (server!.address() as { port: number }).port;
      server!.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString());
          const reply = (type: string, data?: any) => ws.send(JSON.stringify({ type, data }));
          onFrame(frame, reply, ws);
        });
      });
      resolve();
    });
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-headless-'));
});

afterEach(() => {
  releaseRuntime(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  server?.close();
  server = null;
});

describe('requireLiveInstance（发现与校验）', () => {
  it('无注册表 → 报错并提示 agentchat web', () => {
    expect(() => requireLiveInstance(tmp)).toThrow(/没有运行中的 AgentChat 实例.*agentchat web/s);
  });

  it('残留（死 pid）→ 报错残留并提示 agentchat web', () => {
    fakeOwner(tmp, 4831, { dead: true });
    expect(() => requireLiveInstance(tmp)).toThrow(/残留.*agentchat web/s);
  });

  it('活实例 → 返回记录', () => {
    fakeOwner(tmp, 4831);
    expect(requireLiveInstance(tmp).port).toBe(4831);
  });
});

describe('runHeadless（迷你 owner e2e）', () => {
  it('一轮会话：chat.send → 流式渲染 → chat.end 退出 0', async () => {
    await startMiniOwner((frame, reply) => {
      if (frame.type === 'chat.send') {
        const to = frame.data.to;
        reply('chat.send.ack', { to });
        reply('chat.start', { agentId: to });
        reply('chat.thinking.start', { agentId: to });
        reply('chat.message.start', { agentId: to });
        reply('chat.message.update', { agentId: to, delta: '你好' });
        reply('chat.message.update', { agentId: to, delta: '，世界' });
        reply('chat.message.end', { agentId: to });
        reply('chat.end', { agentId: to });
      }
    });
    fakeOwner(tmp, serverPort);

    const cap = captureIo();
    const code = await runHeadless({
      workspaceDir: tmp, to: 'alpha', content: '打个招呼', io: cap.io,
    });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('你好，世界');
    // 非目标 Agent 的流被过滤（并发客户端广播隔离）
    expect(cap.err.join('')).toContain('会话开始');
  });

  it('事件归属过滤：他人 agentId 的消息流不渲染', async () => {
    await startMiniOwner((frame, reply) => {
      if (frame.type === 'chat.send') {
        reply('chat.message.start', { agentId: 'beta' });
        reply('chat.message.update', { agentId: 'beta', delta: '别人的会话' });
        reply('chat.message.end', { agentId: 'beta' });
        reply('chat.end', { agentId: frame.data.to });
      }
    });
    fakeOwner(tmp, serverPort);

    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, to: 'alpha', content: 'x', io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).not.toContain('别人的会话');
  });

  it('列表模式：agent.list → 打印清单 → 退出 0', async () => {
    await startMiniOwner((frame, reply) => {
      if (frame.type === 'agent.list') {
        reply('agent.list.response', { agents: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'user', name: '用户', virtual: true },
        ] });
      }
    });
    fakeOwner(tmp, serverPort);

    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, io: cap.io });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('● alpha — Alpha');
    expect(text).toContain('· user — 用户');
  });

  it('无注册表 → 退出 1 并提示 agentchat web', async () => {
    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, to: 'alpha', content: 'x', io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('agentchat web');
  });

  it('注册表指向死端口（进程活着但 WS 不在）→ 退出 1 连接失败', async () => {
    const port = await freePort(); // 释放后无人监听
    fakeOwner(tmp, port);
    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, to: 'alpha', content: 'x', io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('连接失败');
  });

  it('服务器 error 帧 → 退出 1', async () => {
    await startMiniOwner((frame, reply) => {
      if (frame.type === 'chat.send') reply('error', { message: 'agent 不存在' });
    });
    fakeOwner(tmp, serverPort);
    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, to: 'ghost', content: 'x', io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('agent 不存在');
  });

  it('连接中途断开（未收 chat.end）→ 退出 1', async () => {
    await startMiniOwner((frame, _reply, ws) => {
      if (frame.type === 'chat.send') ws.close();
    });
    fakeOwner(tmp, serverPort);
    const cap = captureIo();
    const code = await runHeadless({ workspaceDir: tmp, to: 'alpha', content: 'x', io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('连接已断开');
  });
});

describe('注册表与 workspace 解析', () => {
  it('runtimeFilePath 落在 workspace 内', () => {
    expect(runtimeFilePath(tmp)).toBe(path.join(tmp, '.runtime'));
  });
});
