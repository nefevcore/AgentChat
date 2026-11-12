// ============================================================
// M7.5 级联验收：webui 三拆 + 通道 端到端（真子进程壳 + 宿主半边）
//
// ① 历史读：真壳多轮会话 → user 账本终稿投影 → webui 读面回放对齐；
// ② 流式：run 进行中 delta 帧经宿主 tap 到达 + run 收束账本对齐
//   （壳死即丢语义——tap 断连不重连）；
// ③ 通道：假插件目录 manifest → boot graph 注入 → 静态路由可取资产。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEnvelope } from 'ac-envelope-core';
import { tapShellStream } from 'ac-post-office';
import { bootShell } from '../../shell/boot.ts';
import { LedgerWriter, sessionDir, projectUserReplay } from 'ac-ledger';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-webui-e2e-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});



describe('M7.5 webui 三拆 + 通道 端到端', () => {
  // v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
  function seedConfig(agentId: string): void {
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    writeAgentConfig(ROOT, { id: agentId, model: 'mock' });
  }

  it('① 历史读：真壳会话 → user 账本终稿投影 → webui 读面回放对齐', async () => {
    seedConfig('alpha');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'alpha', catalogFile: CATALOG }, { emit: () => {} });
    // user 壳（宿主内薄桩）经 ipc 直投两轮 + 终稿写穿 user 账本
    const net = await import('node:net');
    const client = net.connect(boot.transportHint);
    await new Promise<void>((res) => client.once('connect', res));
    const { encodeFrame, FrameDecoder } = await import('ac-envelope-core');
    const decoder = new FrameDecoder();
    client.on('data', (c: Buffer) => { for (const _f of decoder.push(c)) void _f; });
    const send = async (text: string, rq: string) => {
      client.write(encodeFrame(makeEnvelope({ uuid: 'u-e2e-a', requestId: rq, sender: 'user', to: 'alpha', payload: { text } })));
      await new Promise((r) => setTimeout(r, 80));
    };
    await send('第一问', 'rq-a1');
    await send('第二问', 'rq-a2');
    client.destroy();
    // 账本落地（cr-973：viewer 物化退役——入站 user 行 + agent 自著终稿行
    // 都落 agent 域）。入站行壳侧已落（上方 ipc 直投，同键重落被投影去重）；
    // 终稿行时间戳取壳侧两问之间/其后（投影按 ts 排序——先问后答的事实序）
    const ts = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
    const midTs = (a: string, b: string): string => new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString();
    const { readLedger } = await import('ac-ledger');
    const landed = readLedger(sessionDir(ROOT, 'alpha', 'u-e2e-a')).rows;
    const t1 = landed.find((r) => r.requestId === 'rq-a1')?.timestamp ?? ts(1_000);
    const t2 = landed.find((r) => r.requestId === 'rq-a2')?.timestamp ?? ts(3_000);
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', 'u-e2e-a'), { participants: ['alpha', 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '第一问', agent_id: 'user', requestId: 'rq-a1', uuid: 'u-e2e-a', timestamp: t1 });
    await w.deliver({ role: 'agent', content: '[alpha 回复 第一问]', agent_id: 'alpha', requestId: 'rr-1', uuid: 'u-e2e-a', run: 'run-1', timestamp: midTs(t1, t2) });
    await w.deliver({ role: 'agent', content: '第二问', agent_id: 'user', requestId: 'rq-a2', uuid: 'u-e2e-a', timestamp: t2 });
    await w.deliver({ role: 'agent', content: '[alpha 回复 第二问]', agent_id: 'alpha', requestId: 'rr-2', uuid: 'u-e2e-a', run: 'run-2', timestamp: ts(4_000) });
    // webui 读面——终稿层读时投影（projectUserReplay，cr-973 唯一读面）
    const replayOf = (): string[] => projectUserReplay(ROOT, 'u-e2e-a').map((r) => r.content);
    expect(replayOf()).toEqual(['第一问', '[alpha 回复 第一问]', '第二问', '[alpha 回复 第二问]']);
    await w.deliver({ role: 'agent', content: '[alpha 回复 第三问]', agent_id: 'alpha', requestId: 'rr-3', uuid: 'u-e2e-a', run: 'run-3', timestamp: ts(5_000) });
    expect(replayOf()).toEqual(['第一问', '[alpha 回复 第一问]', '第二问', '[alpha 回复 第二问]', '[alpha 回复 第三问]']);
    await boot.close();
  }, 30_000);

  it('② 流式：run 旁带帧经真 ipc 连接到达 tap + 壳死即丢', async () => {
    seedConfig('beta');
    const boot = await bootShell({ dataRoot: ROOT, agentId: 'beta', catalogFile: CATALOG }, { emit: () => {} });
    // 宿主 tap 订阅旁带（真 ipc 连接——与投递信封同监听地址）
    const frames: Array<{ stream: string; kind: string; text?: string; finish?: string }> = [];
    const tap = await tapShellStream(boot.transportHint, (f) => frames.push(f as { stream: string; kind: string }));
    await new Promise((r) => setTimeout(r, 50)); // tap 就位
    // run 模拟（M5 e2e 同构：步进发射——emitStream = shell-loop observer 接线面）
    const ok1 = boot.emitStream({ stream: 'st-1', kind: 'delta', text: '思考' });
    const ok2 = boot.emitStream({ stream: 'st-1', kind: 'delta', text: '…终稿前' });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    // 收束：end 帧 + 账本终稿对齐（账本兜底；cr-973 终稿行落 agent 域，
    // 回放走读时投影）
    boot.emitStream({ stream: 'st-1', kind: 'end', finish: 'ok' });
    await new Promise((r) => setTimeout(r, 100));
    const bw = new LedgerWriter(sessionDir(ROOT, 'beta', 'u-e2e-b'), { participants: ['beta', 'user'], kind: 'user' });
    await bw.deliver({ role: 'agent', content: '流式终稿', agent_id: 'beta', uuid: 'u-e2e-b', run: 'st-1', requestId: 'rr-b1' });
    const replay = projectUserReplay(ROOT, 'u-e2e-b');
    // toEqual 全等：timestamp（cr-716）/ requestId（cr-739）/ seq（B1 行级
    // seq 持久化）是 replay 行合法字段，期望补齐
    expect(replay[0]).toEqual({
      role: 'peer', agentId: 'beta', content: '流式终稿', run: 'st-1',
      requestId: 'rr-b1',
      seq: replay[0].seq,
      timestamp: replay[0].timestamp,
    });
    expect(typeof replay[0].timestamp).toBe('string');
    // 壳死即丢：关 ipc → emitStream 返回 false（无订阅连接 = 丢弃）
    tap.close();
    await boot.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(boot.emitStream({ stream: 'st-1', kind: 'delta', text: '死后' })).toBe(false);
    // 帧序断言：delta×2 + end（同 stream id）
    expect(frames.filter((f) => f.kind === 'delta').map((f) => f.text)).toEqual(['思考', '…终稿前']);
    expect(frames.filter((f) => f.kind === 'end')).toEqual([{ stream: 'st-1', kind: 'end', finish: 'ok' }]);
  }, 30_000);

  it('③ 通道：假插件 manifest → boot graph 注入 → 静态路由取资产', async () => {
    const pluginsDir = path.join(ROOT, 'plugins');
    fs.mkdirSync(path.join(pluginsDir, 'demo', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'demo', 'manifest.json'), JSON.stringify({
      name: 'demo', version: '1.0.0', entry: 'ui/index.js', platform: 'web',
      seats: [{ seat: 'dock' }],
    }));
    fs.writeFileSync(path.join(pluginsDir, 'demo', 'ui', 'index.js'), 'export default { mount() {} }');
    const { assembleBootGraph, resolveUiAsset } = await import('ac-webui-core');
    const { graph, warnings } = assembleBootGraph(pluginsDir);
    expect(warnings).toEqual([]);
    expect(graph).toHaveLength(1);
    expect(graph[0].name).toBe('demo');
    // 静态路由可取资产（宿主 webui 半边语义——文件字节直读）
    const asset = resolveUiAsset(pluginsDir, 'demo', 'ui/index.js');
    expect(asset).not.toBeNull();
    expect(fs.readFileSync(asset!.file, 'utf-8')).toContain('mount');
  }, 30_000);
});
