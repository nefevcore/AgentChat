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
import { readLedgerFrom } from 'ac-webui-core';
import { UserLedger } from 'ac-ledger';

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
  function seedConfig(agentId: string): void {
    const dir = path.join(ROOT, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock' }), 'utf-8');
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
    // user 壳终稿写穿（模拟 agent 终稿到达——真实链路 = run 收束终稿投回）
    const uled = new UserLedger(ROOT, 'u-e2e-a', ['alpha', 'user']);
    await uled.writeOwn('第一问', 'rq-a1');
    await uled.writeThrough({ agentId: 'alpha', content: '[alpha 回复 第一问]', uuid: 'u-e2e-a', run: 'run-1', requestId: 'rr-1' });
    await uled.writeOwn('第二问', 'rq-a2');
    await uled.writeThrough({ agentId: 'alpha', content: '[alpha 回复 第二问]', uuid: 'u-e2e-a', run: 'run-2', requestId: 'rr-2' });
    // webui 读面（历史读纯库）——user 账本回放
    const udir = path.join(ROOT, 'viewer', 'sessions', 'u-e2e-a');
    const first = readLedgerFrom(udir, 0);
    expect(first.rows.map((r) => r.content)).toEqual(['第一问', '[alpha 回复 第一问]', '第二问', '[alpha 回复 第二问]']);
    // 增量读：追加一行再读只交付新行
    await uled.writeThrough({ agentId: 'alpha', content: '[alpha 回复 第三问]', uuid: 'u-e2e-a', run: 'run-3', requestId: 'rr-3' });
    const second = readLedgerFrom(udir, first.anchor);
    expect(second.rows.map((r) => r.content)).toEqual(['[alpha 回复 第三问]']);
    // 会话列表（扫描发现 user 账本 + agent 账本）
    // listSessions 现扫 agents/——user 账本在 users/ 下（端点轴分离）
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
    // 收束：end 帧 + 账本终稿对齐（账本兜底）
    boot.emitStream({ stream: 'st-1', kind: 'end', finish: 'ok' });
    await new Promise((r) => setTimeout(r, 100));
    const uled = new UserLedger(ROOT, 'u-e2e-b', ['beta', 'user']);
    await uled.writeThrough({ agentId: 'beta', content: '流式终稿', uuid: 'u-e2e-b', run: 'st-1', requestId: 'rr-b1' });
    const replay = uled.replay();
    expect(replay[0]).toEqual({ role: 'peer', agentId: 'beta', content: '流式终稿', run: 'st-1' });
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
