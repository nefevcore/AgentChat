// ============================================================
// P4 测试：插件域 WS 事件端到端（真实 WebUIServer + ws 客户端）
//
// 覆盖契约 §3.3：
//   · plugin.catalog.changed —— stage 触发
//   · agent.assembly.changed —— PUT /api/plugins/assembly 触发
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { bootstrap } from '../src/bootstrap';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ws-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf-8');
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevCreds === undefined) delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  else process.env.AGENTCHAT_CREDENTIALS_FILE = prevCreds;
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitEvent(ws: WebSocket, type: string, predicate: (data: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 WS 事件 ${type} 超时`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type && predicate(msg.data)) {
        cleanup();
        resolve(msg.data);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    ws.on('message', onMessage);
  });
}

describe('插件域 WS 事件（P4）', () => {
  it('stage → plugin.catalog.changed；PUT assembly → agent.assembly.changed', async () => {
    // 预置 admin（.initialized 会跳过默认引导，这里手工注册，保证 PUT assembly 有目标）
    const adminDir = path.join(tmp, 'agents', 'admin');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'config.json'), JSON.stringify({
      agent_id: 'admin', name: 'Admin', tags: ['admin'], presets: ['agentchat-math'],
    }), 'utf-8');

    const port = await freePort();
    const result = await bootstrap({ enableWebUI: true, webuiPort: port });
    let ws: WebSocket | null = null;
    try {
      ws = await openWs(`ws://127.0.0.1:${port}/ws`);

      // 准备开发插件并触发 stage（无需成功装载；stage 只校验+暂存）
      const devDir = path.join(tmp, 'plugins', 'admin', 'ws-demo');
      fs.mkdirSync(devDir, { recursive: true });
      fs.writeFileSync(path.join(devDir, 'manifest.json'), JSON.stringify({
        name: 'ws-demo', version: '1.0.0', entry: 'index.mjs',
      }), 'utf-8');
      fs.writeFileSync(path.join(devDir, 'index.mjs'), `export const name='ws-demo';\nexport function apply(){}\n`, 'utf-8');

      const stagePromise = waitEvent(ws, 'plugin.catalog.changed', (d) => d?.kind === 'staging');
      await fetch(`http://127.0.0.1:${port}/api/plugins/library/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: devDir, owner: 'admin' }),
      });
      expect(await stagePromise).toMatchObject({ kind: 'staging' });

      const assemblyPromise = waitEvent(ws, 'agent.assembly.changed', (d) => d?.agentId === 'admin');
      await fetch(`http://127.0.0.1:${port}/api/plugins/assembly/admin`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presets: ['agentchat-math'] }),
      });
      expect(await assemblyPromise).toEqual({ agentId: 'admin' });
    } finally {
      ws?.close();
      await result.webui?.stop();
      result.timer?.stopAll();
    }
  });
});
