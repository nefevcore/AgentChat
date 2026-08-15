// ============================================================
// 块 B 验收：每个 /api/* 由插件行注册；WebUI 只 mount route registry
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-routes-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf-8');
  const adminDir = path.join(tmp, 'agents', 'admin');
  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, 'config.json'), JSON.stringify({
    agent_id: 'admin', name: 'Admin', tags: ['admin'], presets: ['agentchat-math'],
  }), 'utf-8');
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

describe('HTTP 路由注册插件化（块 B）', () => {
  it('域插件行注册的 /api/* 全部可访问；SPA 带 CSP；未注册 UI 插件名 404', async () => {
    const port = await freePort();
    const result = await bootstrap({ enableWebUI: true, webuiPort: port });
    const base = `http://127.0.0.1:${port}`;
    try {
      // agents/history/groups —— server L4 服务插件行
      expect((await fetch(`${base}/api/agents`)).status).toBe(200);
      expect(((await (await fetch(`${base}/api/agents`)).json()) as any).agents.some((a: any) => a.id === 'admin')).toBe(true);
      expect((await fetch(`${base}/api/groups`)).status).toBe(200);
      expect((await fetch(`${base}/api/history?from=admin&to=user`)).status).toBe(200);

      // plugins —— 插件域路由行（inject pluginManager）
      expect((await fetch(`${base}/api/plugins/catalog`)).status).toBe(200);
      expect((await fetch(`${base}/api/plugins/permissions`)).status).toBe(200);

      // ui —— webui 插件行
      expect((await fetch(`${base}/api/ui/extensions`)).status).toBe(200);
      expect(((await (await fetch(`${base}/api/ui/slots`)).json()) as any).slots.some((s: any) => s.id === 'global-style')).toBe(true);
      expect((await fetch(`${base}/ui-plugin/not-registered/index.js`)).status).toBe(404);

      // 传输层通用路由 —— server http-routes 插件行
      expect((await fetch(`${base}/api/config`)).status).toBe(200);
      expect((await fetch(`${base}/api/version`)).status).toBe(200);
      expect((await fetch(`${base}/api/workspace/tree`)).status).toBe(200);
      expect((await fetch(`${base}/api/backup`)).status).toBe(200);
      expect((await fetch(`${base}/api/usage/tokens`)).status).toBe(200);
      expect((await fetch(`${base}/api/sessions/admin/tokens`)).status).toBe(200);

      // SPA fallback + P5.5 CSP
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain("script-src 'self'");
    } finally {
      await result.webui?.stop();
      result.timer?.stopAll();
    }
  });
});
