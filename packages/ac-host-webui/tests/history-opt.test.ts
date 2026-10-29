// cr-768 回归锁：session/history 的 fingerprint 短路（unchanged 轻载荷）与
// view:'lite' 透传（steps 截断）——真 WS 链路（bootHostWeb → rpc 往返）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import { bootHostWeb, type HostWebResult } from '../src/host-web.ts';
import { UserLedger, sessionDir } from 'ac-ledger';

const ROOT = path.join('sandbox', 'test-hist-opt-' + process.pid);
let host: HostWebResult | null = null;
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(async () => {
  if (host !== null) { await host.close(); host = null; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function rpc<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const requestId = 't-' + Math.random().toString(36).slice(2);
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

describe('session/history 读面优化（cr-768）', () => {
  it('fingerprint 短路：首屏响应带指纹 → 同指纹重入 unchanged；追加行后失效回全量', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    host = await bootHostWeb({ dataRoot: ROOT });
    const ws = new WebSocket('ws://127.0.0.1:' + host.port + '/ws');
    await new Promise<void>((res) => ws.once('open', () => res()));
    const conv = 'fp-e2e';
    const ul = new UserLedger(ROOT, conv, ['user']);
    await ul.writeThrough({ agentId: 'alpha', content: '第一稿', uuid: conv, run: 'r1', requestId: 'rq1' });

    const first = await rpc<{ records: unknown[]; total: number; fingerprint?: string }>(ws, 'session/history', { conversationId: conv });
    expect(first.total).toBe(1);
    expect(typeof first.fingerprint).toBe('string');
    const fp = first.fingerprint!;

    // 同指纹首屏重入 → unchanged 轻载荷（跳过全读全投影）
    const again = await rpc<{ unchanged?: boolean; fingerprint?: string; records?: unknown[] }>(ws, 'session/history', { conversationId: conv, fingerprint: fp });
    expect(again.unchanged).toBe(true);
    expect(again.fingerprint).toBe(fp);
    expect(again.records).toBeUndefined();

    // 上翻（offset>0）不参与短路——分页语义需要精确 total
    const paged = await rpc<{ unchanged?: boolean; total: number }>(ws, 'session/history', { conversationId: conv, fingerprint: fp, offset: 1, limit: 1 });
    expect(paged.unchanged).toBeUndefined();
    expect(paged.total).toBe(1);

    // 追加终稿行 → 指纹失效 → 回全量且带新指纹
    await ul.writeThrough({ agentId: 'alpha', content: '第二稿', uuid: conv, run: 'r2', requestId: 'rq2' });
    const after = await rpc<{ unchanged?: boolean; total: number; fingerprint?: string }>(ws, 'session/history', { conversationId: conv, fingerprint: fp });
    expect(after.unchanged).toBeUndefined();
    expect(after.total).toBe(2);
    expect(after.fingerprint).not.toBe(fp);
    ws.close();
  }, 30_000);

  it("view:'lite' 透传：steps 超长字段截断（remote-link 注入参数的全链路终点）", async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', model: 'mock' }), 'utf-8');
    host = await bootHostWeb({ dataRoot: ROOT });
    const ws = new WebSocket('ws://127.0.0.1:' + host.port + '/ws');
    await new Promise<void>((res) => ws.once('open', () => res()));
    const conv = 'lite-e2e';
    const ul = new UserLedger(ROOT, conv, ['user']);
    await ul.writeThrough({ agentId: 'alpha', content: '终稿', uuid: conv, run: 'run-l', requestId: 'rq-l' });
    const jf = path.join(sessionDir(ROOT, 'alpha', conv), 'journal', 'partials.jsonl');
    fs.mkdirSync(path.dirname(jf), { recursive: true });
    const LONG = 'z'.repeat(5 * 1024);
    fs.writeFileSync(jf, [
      JSON.stringify({ type: 'journal-step', run: 'run-l', step: 1, content: '想', reasoning: LONG, toolCalls: [{ id: 'c1', name: 'read', arguments: LONG }], toolResults: [{ ok: true, output: { blob: 'y'.repeat(10 * 1024) } }] }),
      JSON.stringify({ type: 'journal-settled', run: 'run-l', finish: 'ok' }),
    ].join('\n') + '\n', 'utf-8');

    const lite = await rpc<{ records: Array<{ steps?: Array<{ reasoning?: string; toolCalls?: Array<{ arguments: string; resultTruncated?: boolean }> }> }> }>(ws, 'session/history', { conversationId: conv, view: 'lite' });
    const step = lite.records.flatMap((r) => r.steps ?? [])[0]!;
    expect(step.reasoning).toMatch(/^z{2048}…\[/);
    expect(step.toolCalls![0]!.arguments).toMatch(/^z{2048}…\[/);
    expect(step.toolCalls![0]!.resultTruncated).toBe(true);
    // full 视图不受污染
    const full = await rpc<{ records: Array<{ steps?: Array<{ reasoning?: string }> }> }>(ws, 'session/history', { conversationId: conv });
    expect(full.records.flatMap((r) => r.steps ?? [])[0]!.reasoning).toBe(LONG);
    ws.close();
  }, 30_000);
});
