// ============================================================
// e2e-stream.test.ts —— 8.5d ws-bridge 旁带接线级联验收
//
// 真链路：真子进程壳（--mock-provider）← user 桩投递驱动 mock run
// → 壳 llm/delta → B3 旁带帧 → 宿主 tapAgent（StreamTap +
// ShellStreamBridge）→ webServer.broadcast → 真 WS 客户端收到
// llm/delta-batch / llm/delta-end（前端 wire/feed-core 可直接消费的帧形）。
// 帧形断言 = 主线对拍：args[0] = {model, meta} 投影 + meta 路由键（agent/
// conversationId/stepId）。数据根恒 sandbox/（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { socketPathFor } from 'ac-envelope-core';
import { bootHostWeb, type HostWebResult } from 'ac-host-webui';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-stream-e2e-' + process.pid);
const BOOT = fileURLToPath(new URL('../../../apps/shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 真 WS 客户端：连 /ws → 收全部事件帧（过滤 ws/ready 等控制面） */
interface RecvFrame { type: string; data: { args: unknown[] } }
function connectEvents(port: number): Promise<{ ws: WebSocket; frames: RecvFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const frames: RecvFrame[] = [];
    ws.once('open', () => {
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(String(data)) as { type?: string; data?: { args?: unknown } };
          if (m.type !== undefined && m.type !== 'ws/ready' && Array.isArray(m.data?.args)) {
            frames.push({ type: m.type, data: { args: m.data.args } });
          }
        } catch { /* 非 JSON 忽略 */ }
      });
      resolve({ ws, frames });
    });
    ws.once('error', reject);
  });
}

/** 等待帧断言面（轮询直到谓词命中或超时） */
async function waitFor(frames: RecvFrame[], predicate: (f: RecvFrame) => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (frames.some(predicate)) return;
    if (Date.now() > deadline) throw new Error('等待流式帧超时：' + JSON.stringify(frames.map((f) => f.type)));
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('8.5d ws-bridge 旁带接线（壳 → 宿主 → webui 流式全链）', () => {
  it('真壳 mock run 流式全链：tapAgent → broadcast → WS 客户端收前端帧形', async () => {
    // v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    writeAgentConfig(ROOT, { id: 'alpha', model: 'mock' });

    // 宿主 web 面（邮局 + user 桩 + webServer + broadcast 面）
    const host: HostWebResult = await bootHostWeb({ dataRoot: ROOT });
    const { ws, frames } = await connectEvents(host.port);
    try {
      // 真子进程壳（mock provider——llm 流式事件照常发射）
      const child = spawn(process.execPath, ['--experimental-strip-types', BOOT,
        '--data-root', path.resolve(ROOT), '--agent-id', 'alpha', '--catalog', CATALOG,
        '--mock-provider', '1', '--post-office', socketPathFor(path.resolve(ROOT), 'post-office')],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (c: Buffer) => { process.stderr.write('[shell:' + 'alpha] ' + c.toString()); });
      spawned.push(child);
      const lines: string[] = [];
      child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
      const deadline = Date.now() + 15_000;
      while (!lines.some((l) => l.startsWith('boot.ready'))) {
        if (Date.now() > deadline) throw new Error('boot.ready 超时：' + lines.join(' | '));
        await new Promise((r) => setTimeout(r, 50));
      }
      const hint = lines.find((l) => l.startsWith('boot.ready'))!.split('\t')[2];
      // 宿主接旁带流（adopt 后 tap——B3 语义）
      await host.tapAgent('alpha', hint);
      // 可达登记（邮局直投面）
      host.po.reach.markReachable('alpha', hint);

      // user 发言驱动 mock run（R-1 签发 + 投递）
      const { uuid } = await host.user.send('alpha', '流式全链');
      expect(typeof uuid).toBe('string');

      // 等流式帧：delta-batch（含 mock 回声增量）+ delta-end（finish ok）
      await waitFor(frames, (f) => f.type === 'llm/delta-batch');
      await waitFor(frames, (f) => f.type === 'llm/delta-end');
      // cr-976 B 案投影帧族：事件落盘通知 → 投影转发（步终值 + run 收束）
      // ——run/settled 到达 = run-end 已 durable（E-2 修复实证：收敛信号有发射方）
      await waitFor(frames, (f) => f.type === 'step/journaled');
      await waitFor(frames, (f) => f.type === 'run/settled');
      const journaled = frames.find((f) => f.type === 'step/journaled')!;
      const jArgs = journaled.data.args[0] as { agent?: string; conversationId?: string; run?: string; rows?: unknown[] };
      expect(jArgs.agent).toBe('alpha');
      expect(jArgs.conversationId).toBe(uuid);
      expect(Array.isArray(jArgs.rows)).toBe(true);
      const settledFrame = frames.find((f) => f.type === 'run/settled')!;
      const sArgs = settledFrame.data.args[0] as { agent?: string; conversationId?: string; finish?: string };
      expect(sArgs.agent).toBe('alpha');
      expect(sArgs.conversationId).toBe(uuid);
      expect(sArgs.finish).toBe('stop');
      // 帧形对拍（前端 feed-core 可路由性）：args = [input(投影), chunk, meta]
      const batch = frames.find((f) => f.type === 'llm/delta-batch')!;
      const deltas = (batch.data.args[0] as { deltas: unknown[][] }).deltas;
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      const [input, chunk] = deltas[0] as [{ meta?: Record<string, string> }, { delta?: string }];
      // input 投影：wireLlmInput 只留 model+meta（主线同源）；model 缺席时
      // JSON 序列化剥键——前端消费面 = meta 路由键，model 键非必需
      // meta 路由键：agent/conversationId/stepId 全套（前端按键寻址会话与步载体）
      expect(input.meta?.agent).toBe('alpha');
      expect(input.meta?.conversationId).toBe(uuid);
      expect(typeof input.meta?.stepId).toBe('string');
      expect(chunk.delta).toContain('[mock 回复');
      // end 帧：args = [input, meta]（meta 双位——前端同源兜底）
      const end = frames.find((f) => f.type === 'llm/delta-end')!;
      const [endInput] = end.data.args as [{ meta?: Record<string, string> }];
      expect(endInput.meta?.agent).toBe('alpha');
      expect(endInput.meta?.conversationId).toBe(uuid);

      // cr-976 B 案（P3-1 验收 #4——E-2 修复实证半边）：run/settled 帧由
      // run-end 行 durable 落盘驱动（与重拉权威同一因果链），帧携带 seq
      // 与日志行一致；旧帧族（loop/after-run / session/run-settled）零出现
      // ——收敛信号单事实。
      await waitFor(frames, (f) => f.type === 'run/settled');
      const settled = frames.filter((f) => f.type === 'run/settled');
      expect(settled).toHaveLength(1);
      const sp = settled[0]!.data.args[0] as { agent?: string; conversationId?: string; run?: string; seq?: number; finish?: string; text?: string };
      expect(sp).toMatchObject({ agent: 'alpha', conversationId: uuid, finish: 'stop' });
      expect(typeof sp.seq).toBe('number');
      expect(sp.text).toContain('[mock 回复');
      // 帧锚 seq ≡ 日志 run-end 行 seq（durable 因果实证：帧 = 事实的视图）
      const logFile = path.join(ROOT, 'agents', 'alpha', 'sessions', uuid, 'messages.jsonl');
      const logRows = fs.readFileSync(logFile, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      const runEnd = logRows.find((r) => r.type === 'run-end');
      expect(runEnd).toBeDefined();
      expect(runEnd!.seq).toBe(sp.seq);
      // 旧帧族缺席（D3-3 一步切换——直播帧不再是第二事实源）
      expect(frames.some((f) => f.type === 'loop/after-run')).toBe(false);
      expect(frames.some((f) => f.type === 'session/run-settled')).toBe(false);
      // step/journaled 投影帧在场（帧序 ≡ 事件行序的全链体现）
      expect(frames.some((f) => f.type === 'step/journaled')).toBe(true);
    } finally {
      ws.close();
      await host.close();
    }
  }, 45_000);

  it('桥接收束：close 清在途批不丢帧（untapAgent / host.close 共用面）', async () => {
    const framesSink: Array<{ type: string; data: { args: unknown[] } }> = [];
    const host: HostWebResult = await bootHostWeb({ dataRoot: ROOT, });
    try {
      // 直接构造桥接注入面（不走真壳——untap 语义单元验）
      const { ShellStreamBridge } = await import('ac-post-office');
      const bridge = new ShellStreamBridge({
        send: (f) => framesSink.push(f),
      });
      bridge.ingest({ stream: 's1', kind: 'delta', text: 'x', meta: { agent: 'a', stepId: 's1' } });
      bridge.close();
      expect(framesSink.some((f) => f.type === 'llm/delta-batch')).toBe(true);
    } finally {
      await host.close();
    }
  }, 30_000);
});