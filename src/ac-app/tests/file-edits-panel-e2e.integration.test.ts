// ============================================================
// ac-app/tests/file-edits-panel-e2e.integration.test.ts —— 文件编辑面板
// 直播链端到端（本次缺陷排查）：真实后端树（ws-bridge/web-server/
// file-snapshots/fs-tools/session）+ scripted provider 模型直调 edit。
//
// 验收：存量文件被编辑 → tool/after-execute 帧携带 conversationId
// 广播到 WS 客户端（面板刷新链的触发前提）+ 快照落盘（list RPC 可见）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { bootTree, type BootedTree } from '../src/index';
import type { Context } from '@agentchat/cordis';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';

function scriptedRow(editPath: string) {
  let counter = 0;
  return {
    name: 'mock-edit-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted-edit',
        () => ({
          stream: async function* () {
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', toolCalls: [{ index: 0, id: 'ce1', name: 'edit' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ file_path: editPath, old_string: 'line1', new_string: 'LINE1' }) }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '编辑完成' };
              yield { delta: '', finish: 'stop', usage: { prompt: 2, completion: 3 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
}

const booted: BootedTree[] = [];
const sockets: WebSocket[] = [];
const tmps: string[] = [];

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      if (parseFrame(raw.toString())?.type === WS_READY) resolve(ws);
    });
  });
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data as { ok: boolean; result?: any; error?: string });
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('文件编辑面板直播链（真实后端树）', () => {
  it('模型直调 edit 存量文件：after-execute 帧广播 + 快照落盘 + list RPC 可见', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-fe2e-'));
    tmps.push(root);
    // 存量文件（会话开始前已存在）
    const projDir = join(root, 'proj', 'src');
    await mkdir(projDir, { recursive: true });
    const filePath = join(projDir, 'a.ts');
    await writeFile(filePath, 'line1\nline2\n', 'utf-8');
    const tree = await bootTree({
      session: { root },
      singles: { root },
      group: { root },
      conversation: { root },
      usage: { root },
      workspace: { root },
    });
    const fiber = tree.ctx.plugin(scriptedRow(filePath) as any);
    await fiber;
    tree.fibers.set('mock-llm', fiber);
    booted.push(tree);
    const port = await tree.ctx.webServer.ready();
    const ws = await connect(port);
    // 建档（含 fs 工具面）
    const created = await rpc(ws, 'agents/create', 'r0', {
      config: { id: 'helper', model: 'mock-1', tags: ['infra', 'fs', 'full-access'], tools: { include: ['edit', 'read'] } },
    });
    expect(created.ok).toBe(true);
    // 帧监听先于投递注册（run 极快，监听晚了会漏帧）
    const frames: Array<{ type: string; data: any }> = [];
    ws.on('message', (raw) => {
      const f = parseFrame(raw.toString());
      if (f) frames.push({ type: f.type, data: f.data });
    });
    // 投递触发 run（pair helper~user）
    const send = await rpc(ws, 'conversation/deliver', 'r1', { agentId: 'helper', message: '编辑一下' });
    expect(send.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    const afterExec = frames.filter((f) => f.type === 'tool/after-execute');
    expect(afterExec.length).toBeGreaterThan(0);
    const editFrame = afterExec.find((f) => f.data?.args?.[0]?.name === 'edit');
    expect(editFrame).toBeTruthy();
    expect(editFrame!.data.args[0].conversationId).toBe('helper~user'); // 帧携带会话键
    // 快照落盘验证：fileSnapshots/list RPC
    const snap = await rpc(ws, 'fileSnapshots/list', 'r2', { conversationId: 'helper~user' });
    expect(snap.ok).toBe(true);
    expect(snap.result?.snapshots?.length).toBeGreaterThan(0);
    expect(snap.result.snapshots[0].absPath.split('\\').join('/')).toContain('proj/src/a.ts');
    expect(snap.result.snapshots[0].content).toBe('line1\nline2\n'); // 首见磁盘内容
  }, 30000);
});