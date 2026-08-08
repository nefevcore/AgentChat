// ============================================================
// src/server WebUIServer 集成测试（L5）
//
// bootstrap 装配（enableWebUI:false，避免动态 import 服务器）→ 直接构造
// WebUIServer（port 0 = 随机端口）→ 验证 REST API + WebSocket 往返。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/app/index';
import { WebUIServer } from '../src/server/index';
import type { BootstrapResult } from '../src/app/index';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-test-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf-8');
  // 预置 user 虚拟 + agentA
  fs.mkdirSync(path.join(tmp, 'agents', 'user'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', 'user', 'config.json'), JSON.stringify({ agent_id: 'user', name: '用户', virtual: true }), 'utf-8');
  fs.mkdirSync(path.join(tmp, 'agents', 'agentA'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', 'agentA', 'config.json'), JSON.stringify({
    agent_id: 'agentA', name: 'Agent A',
    llm: { provider: 'deepseek', model: 'x', api_key: 'sk-test' },
    plugins: [{ name: 'builtin', tools: ['read'] }],
  }), 'utf-8');
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevCreds === undefined) delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  else process.env.AGENTCHAT_CREDENTIALS_FILE = prevCreds;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 等待 WS 收到指定类型的消息 */
function waitWSMessage(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS 消息超时: ${type}`)), 5000);
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(String((e as MessageEvent).data));
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch { /* ignore */ }
    });
  });
}

describe('WebUIServer（REST + WS）', () => {
  it('REST API + WebSocket 往返', async () => {
    const app: BootstrapResult = await bootstrap({ enableWebUI: false });
    let server: WebUIServer | null = null;
    try {
      server = new WebUIServer({
        historyService: app.historyService,
        agentService: app.agentService,
        groupService: app.groupService,
        serviceRegistry: app.serviceRegistry,
        dataDir: tmp,
        port: 0,
        serveStatic: false,
      });
      const port = await server.start();

      // ---- REST：agents 列表 + version ----
      const agentsResp = await fetch(`http://localhost:${port}/api/agents`).then((r) => r.json());
      const ids = agentsResp.agents.map((a: any) => a.id).sort();
      expect(ids).toEqual(['agentA', 'user']);

      const versionResp = await fetch(`http://localhost:${port}/api/version`).then((r) => r.json());
      expect(versionResp.current).toBeTruthy();

      // ---- REST：历史（无数据 → 空数组）----
      const histResp = await fetch(`http://localhost:${port}/api/history?from=user&to=agentA`).then((r) => r.json());
      expect(Array.isArray(histResp.messages)).toBe(true);
      expect(histResp.messages).toEqual([]);

      // ---- WS：agent.list 往返 ----
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
      });
      const listPromise = waitWSMessage(ws, 'agent.list.response');
      ws.send(JSON.stringify({ type: 'agent.list', data: {} }));
      const listResp = await listPromise;
      expect(listResp.data.agents.length).toBe(2);

      // ---- WS：RPC 分支（agent.listBasic）----
      const rpcPromise = waitWSMessage(ws, 'rpc.response');
      ws.send(JSON.stringify({ type: 'rpc', data: { method: 'agent.listBasic', params: undefined, id: 1 } }));
      const rpcResp = await rpcPromise;
      // buildRPCSuccess 返回 { type:'rpc.response', id, result } —— result 在顶层
      expect(rpcResp.id).toBe(1);
      expect(rpcResp.result.length).toBe(2);

      ws.close();
      await server.stop();
      server = null;
    } finally {
      app.timer?.stopAll();
    }
  });

  it('SPA fallback：生产模式托管 index.html（未构建时降级提示）', async () => {
    const app: BootstrapResult = await bootstrap({ enableWebUI: false });
    let server: WebUIServer | null = null;
    try {
      server = new WebUIServer({
        historyService: app.historyService,
        serviceRegistry: app.serviceRegistry,
        dataDir: tmp,
        port: 0,
        serveStatic: true, // 模拟生产：即便 dist 缺失也验证降级
        staticDir: path.join(tmp, 'nonexistent-dist'),
      });
      const port = await server.start();
      const resp = await fetch(`http://localhost:${port}/`);
      expect(resp.status).toBe(200);
      const body = await resp.text();
      // dist 缺失 → SPA fallback 返回降级提示
      expect(body).toMatch(/frontend not built|<!doctype html>/i);
      await server.stop();
      server = null;
    } finally {
      app.timer?.stopAll();
    }
  });
});
