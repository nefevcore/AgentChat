// ============================================================
// P3 e2e：独立会话 HTTP 路由 + WS 投递端到端（真实 bootstrap 树）
//
//   · /api/singles CRUD（service-plugin 行注册）
//   · chat.send data.session → router session_id → 持久化落
//     sessions/single~<sid>/messages.jsonl（与 pair 目录隔离）
//   · history.request data.session → queryDialog 读回
//   · 模型覆盖透传：sessionModel 进入 llmOverride（虚拟桩 LLM 记录）
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LLMService, ChatStream } from '@agentchat/llm';
import type { LLMProvider, LLMConfig } from '@agentchat/llm';
import { bootstrap } from '../src/bootstrap';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;
let prevFactory: ((config: LLMConfig) => LLMProvider) | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'singles-e2e-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  prevFactory = LLMService.factory;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf8');
  const adminDir = path.join(tmp, 'agents', 'admin');
  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, 'config.json'), JSON.stringify({
    agent_id: 'admin', name: 'Admin', tags: ['admin'],
    // 对齐真实 agent 的 preset 形态（agent-session 提供 load-history/save-session 钩子）
    presets: ['agentchat-math', 'agentchat-agent-session'],
    hooks: { runStart: ['agent-session.load-history'], runEnd: ['agent-session.save-session'] },
  }), 'utf8');
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevCreds === undefined) delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  else process.env.AGENTCHAT_CREDENTIALS_FILE = prevCreds;
  LLMService.factory = prevFactory;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** mock LLM：固定回复 + factory 记录收到的 config（断言模型覆盖透传） */
function makeMockLLM(seenConfigs: LLMConfig[]): LLMProvider {
  return {
    model: 'mock-model',
    async chat() { return { content: '好的，收到。', toolCalls: [], finishReason: 'stop' } as never; },
    stream(req) {
      const cs = new ChatStream();
      void (async () => {
        cs.push({ type: 'message_start', partial: { content: '', reasoning: '' } });
        cs.push({ type: 'message_update', delta: '好的，收到。', partial: { content: '好的，收到。', reasoning: '' } });
        cs.push({ type: 'message_end', partial: { content: '好的，收到。', reasoning: '' } });
        cs.done({ content: '好的，收到。', toolCalls: [], finishReason: 'stop' } as never);
      })();
      return cs;
    },
    toProviderMessages: (msgs) => msgs as never,
    fromProviderMessages: (msgs) => msgs as never,
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

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 8000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitEvent(ws: WebSocket, type: string, predicate: (data: any) => boolean = () => true, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 ${type} 超时`)); }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type && predicate(msg.data)) { cleanup(); resolve(msg.data); }
    };
    function cleanup() { clearTimeout(timer); ws.off('message', onMessage); }
    ws.on('message', onMessage);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('独立会话 e2e（HTTP + WS + router）', () => {
  it('/api/singles CRUD + chat.send(session) 投递到 single~<sid> + history 读回', async () => {
    // mock LLM：记录 factory 收到的 config（模型覆盖透传断言）
    const seenConfigs: LLMConfig[] = [];
    LLMService.factory = (config) => { seenConfigs.push(config); return makeMockLLM(seenConfigs); };

    const port = await freePort();
    const result = await bootstrap({ enableWebUI: true, webuiPort: port });
    const base = `http://127.0.0.1:${port}`;
    let ws: WebSocket | null = null;
    try {
      // ---- HTTP CRUD ----
      const bad = await fetch(`${base}/api/singles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ghost' }),
      });
      expect(bad.status).toBe(400);

      const created = await (await fetch(`${base}/api/singles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'admin', title: '单会话一', model: { provider: 'stub', model: 'stub-model' } }),
      })).json() as any;
      expect(created.session.id).toMatch(/^[0-9a-f-]{36}$/);
      const sid = created.session.id as string;

      const list = await (await fetch(`${base}/api/singles`)).json() as any;
      expect(list.singles).toHaveLength(1);
      expect(list.singles[0].title).toBe('单会话一');

      // ---- WS 投递（session 维度）----
      ws = await openWs(`ws://127.0.0.1:${port}/ws`);
      const chatEnd = waitEvent(ws, 'chat.end', (d: any) => d.agentId === 'admin' || d.agent === 'admin');
      ws.send(JSON.stringify({
        type: 'chat.send',
        data: { to: 'admin', content: '独立会话第一句', deepThink: false, files: [], session: sid },
      }));
      await chatEnd;

      // run 收尾落盘（runEnd save-session）
      const msgFile = path.join(tmp, 'sessions', `single~${sid}`, 'messages.jsonl');
      let persisted = false;
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(msgFile) && fs.readFileSync(msgFile, 'utf8').includes('独立会话第一句')) {
          persisted = true;
          break;
        }
        await sleep(500);
      }
      expect(persisted).toBe(true);
      // 与 pair 会话目录隔离：sessions/ 下无 chat~admin~user 的本条消息
      const pairFile = path.join(tmp, 'sessions', 'chat~admin~user', 'messages.jsonl');
      expect(fs.existsSync(pairFile) && fs.readFileSync(pairFile, 'utf8').includes('独立会话第一句')).toBe(false);

      // 模型覆盖透传：session.model 到达 LLM factory（llmOverride 链路）
      expect(seenConfigs.some((c) => (c as any)?.model === 'stub-model')).toBe(true);

      // ---- history.request(session) 读回 ----
      const gotHistory = waitEvent(ws, 'history.response', (d: any) => d.messages?.some((m: any) => m.content === '独立会话第一句'));
      ws.send(JSON.stringify({ type: 'history.request', data: { from: 'user', to: 'admin', limit: 20, offset: 0, session: sid } }));
      const hist = await gotHistory;
      expect(hist.messages.some((m: any) => m.content === '独立会话第一句')).toBe(true);

      // ---- 归档后拒绝再发 ----
      const archived = await (await fetch(`${base}/api/singles/${sid}`, { method: 'DELETE' })).json() as any;
      expect(archived.session.status).toBe('archived');
      ws.send(JSON.stringify({
        type: 'chat.send',
        data: { to: 'admin', content: '再发一句', deepThink: false, files: [], session: sid },
      }));
      const errFrame = await waitEvent(ws, 'error', (d: any) => String(d.message ?? '').includes('已归档'));
      expect(errFrame.message).toContain('已归档');
    } finally {
      ws?.close();
      await result.webui?.stop();
      result.timer?.stopAll();
    }
  }, 90000);
});
