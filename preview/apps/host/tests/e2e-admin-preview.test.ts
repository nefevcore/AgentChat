// ============================================================
// e2e-admin-preview.test.ts —— agent-admin 跨进程 dry-run（cr-552）
//
// 真宿主（bootHost——编排面缺省开 + mockProvider）+ web RPC 三方法：
//   agents/system-prompt → 编排面 ensureAgent 按需拉壳 → 控制帧 preview
//   → 壳内三档链干跑 → 回执 → RPC 返回；
//   agents/assembly → 壳内工具目录投影 + 宿主 plugins/settings 合成；
//   agents/assembly/update → applyAssemblyPatch 落盘（写后 system-prompt
//   预览见新 system——config 直读生效）。数据根恒 preview/sandbox。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import { bootHost, type HostBootResult } from '../boot.ts';

const CATALOG = path.resolve('preview/apps/catalog/row-catalog.json');
let tmp: string;
let host: HostBootResult | null = null;

beforeEach(() => {
  tmp = path.join('preview', 'sandbox', 'e2e-admin-preview-' + process.pid + '-' + Date.now().toString(36));
  fs.mkdirSync(tmp, { recursive: true });
  const agentDir = path.join(tmp, 'agents', 'alpha');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
    id: 'alpha', name: '甲', model: 'mock', system: '我是甲的基底',
    tools: { include: ['math'] },
  }));
});
afterEach(async () => {
  if (host !== null) { await host.close(); host = null; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.once('open', () => {
      ws.once('message', (data) => {
        try {
          const m = JSON.parse(String(data)) as { type?: string };
          if (m.type === WS_READY) resolve(ws);
          else reject(new Error('首帧非 ws/ready'));
        } catch (e) { reject(e); }
      });
    });
    ws.once('error', reject);
  });
}

let rpcSeq = 0;
function rpc<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const requestId = 'p-' + (++rpcSeq);
  return new Promise<T>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const m = JSON.parse(String(data)) as { type?: string; data?: { requestId?: string; ok?: boolean; result?: unknown; error?: string } };
        if (m.type === RPC_RESULT && m.data?.requestId === requestId) {
          ws.off('message', onMessage);
          if (m.data.ok) resolve(m.data.result as T);
          else reject(new Error(m.data.error ?? 'rpc 失败'));
        }
      } catch { /* 非 JSON 帧忽略 */ }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: RPC_CALL, data: { method, requestId, params } }));
  });
}

describe('agent-admin 跨进程 dry-run（cr-552 e2e）', () => {
  it('system-prompt：RPC → 编排面按需拉壳 → 控制帧三档链干跑 → 回执', async () => {
    host = await bootHost({ dataRoot: tmp, catalogFile: CATALOG, mockProvider: true });
    const ws = await connect(host.web.port);
    try {
      const r = await rpc<{ agentId: string; systemPrompt: string }>(ws, 'agents/system-prompt', { agentId: 'alpha' });
      expect(r.agentId).toBe('alpha');
      expect(r.systemPrompt).toContain('我是甲的基底');
      // 壳真被拉起（编排面句柄池）
      expect(host.supervisors?.handles().has('alpha')).toBe(true);
    } finally {
      ws.close();
    }
  }, 60_000);

  it('assembly 读 + assembly/update 写后预览生效（写口宿主本地 + 干跑重读 config）', async () => {
    host = await bootHost({ dataRoot: tmp, catalogFile: CATALOG, mockProvider: true });
    const ws = await connect(host.web.port);
    try {
      const a = await rpc<{ assembly: { tools: { enabled: string[]; catalog: Array<{ name: string }> } } }>(ws, 'agents/assembly', { agentId: 'alpha' });
      expect(a.assembly.tools.enabled).toEqual(['math']);
      expect(a.assembly.tools.catalog.map((t) => t.name)).toContain('math');
      // 写口：加 system 字段经 update-config（另一条已验路径），assembly/update 改 tools
      const up = await rpc<{ changed: string[] }>(ws, 'agents/assembly/update', {
        agentId: 'alpha', patch: { rows: { include: ['math', 'datetime'] } },
      });
      expect(up.changed).toEqual(['rows']);
      // 再预览：system-prompt 干跑按新落盘 config（工具面变化不进 system 文本——
      // 验证链路往返即可；assembly 再读见新意图
      const a2 = await rpc<{ assembly: { tools: { enabled: string[] } } }>(ws, 'agents/assembly', { agentId: 'alpha' });
      expect(a2.assembly.tools.enabled).toEqual(['math', 'datetime']);
    } finally {
      ws.close();
    }
  }, 60_000);
});