// ============================================================
// M7 WebUI 服务面端到端：bootTree（含 web-api/ws-bridge/web-server）
// + scripted provider + 真实 WS 客户端 —— RPC 投递 → 流式事件帧 →
// 历史回放全链路（浏览器适配层消费的帧契约在此锁定）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { bootTree, type BootedTree } from '../src/index';
import type { Context } from '@agentchat/cordis';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';

function scriptedRow() {
  let counter = 0;
  return {
    name: 'mock-scripted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* (input: any) {
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', reasoning: '先想想' };
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"preview"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '工具结果已处理' };
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

async function boot() {
  // 隔离数据根（行 id 键）：会话/群/待投/用量不落仓库 data 目录
  const root = await mkdtemp(join(tmpdir(), 'ac-webui-e2e-'));
  tmps.push(root);
  const tree = await bootTree({
    session: { root },
    group: { root },
    conversation: { root },
    usage: { root },
  });
  const fiber = tree.ctx.plugin(scriptedRow() as any);
  await fiber;
  tree.fibers.set('mock-llm', fiber);
  booted.push(tree);
  return tree;
}

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
  for (const dir of tmps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('M7 WebUI 服务面端到端', () => {
  it('RPC 投递 → 全链路流式事件帧 → 历史回放', async () => {
    const tree = await boot();
    const port = await tree.ctx.webServer.ready();
    const ws = await connect(port);

    // 建档（管理面 RPC）→ 注册表热生效
    const created = await rpc(ws, 'agents/create', 'r0', {
      config: { id: 'helper', model: 'mock-1', tools: { include: ['hello'] } },
    });
    expect(created.ok).toBe(true);

    const frames: Array<{ type: string; data: any }> = [];
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push({ type: frame.type, data: frame.data });
    });

    // 投递（requestId 幂等直通）→ run 完成
    const delivered = await rpc(ws, 'conversation/deliver', 'send-1', {
      agentId: 'helper',
      message: '请用工具打个招呼',
    });
    expect(delivered.ok).toBe(true);
    expect(delivered.result).toMatchObject({ kind: 'run' });

    // 事件帧面（浏览器适配层消费的契约）：
    const types = frames.map((f) => f.type);
    expect(types).toContain('loop/run-started');
    expect(types).toContain('loop/step-started');
    expect(types).toContain('llm/delta'); // reasoning + delta + toolCalls 分流源
    expect(types).toContain('tool/after-execute'); // 工具终值
    expect(types).toContain('loop/after-step'); // 步终值（含 toolCalls/toolResults）
    expect(types).toContain('loop/after-run'); // 边界广播
    expect(types).toContain('router/message-received');
    expect(types).toContain('router/reply-completed');

    // after-step 载荷：调用侧（toolCalls；工具终值走 tool/after-execute）
    const afterStep = frames.find((f) => f.type === 'loop/after-step')!;
    const step = (afterStep.data.args as any[])[1];
    expect(step.toolCalls[0]).toMatchObject({ id: 'c1', name: 'hello' });
    const toolDone = frames.find((f) => f.type === 'tool/after-execute')!;
    const toolResult = (toolDone.data.args as any[])[1];
    expect(toolResult).toMatchObject({ ok: true, output: 'hello: preview' });

    // 历史回放（对话级入账；M19 直答对桶 helper~user）
    const hist = await rpc(ws, 'session/history', 'h1', { conversationId: 'helper~user' });
    const records = (hist.result as { records: Array<{ role: string; content: string }> }).records;
    expect(records.map((r) => r.content)).toEqual(['请用工具打个招呼', '工具结果已处理']);

    // 幂等去重：同 method+requestId 重发 → ws/ack deduped（协议约定去重路径
    // 只回 ack 不回 result——不重复执行）
    const ws2 = await connect(port);
    const dedupAck = new Promise<boolean>((resolve) => {
      ws2.on('message', (raw) => {
        const frame = parseFrame(raw.toString());
        if (frame?.type === 'ws/ack' && (frame.data as { kind?: string }).kind === 'deduped') {
          resolve(true);
        }
      });
    });
    ws2.send(buildFrame(RPC_CALL, {
      method: 'conversation/deliver',
      requestId: 'send-1',
      params: { agentId: 'helper', message: '请用工具打个招呼' },
    }));
    expect(await dedupAck).toBe(true);
  });
});
