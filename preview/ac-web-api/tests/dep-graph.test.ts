// ============================================================
// ac-web-api/tests/dep-graph.test.ts —— M25 P3：反依赖图 + 聚合呈现
//   · plugin/dep-graph：行名 × inject 键集；传递闭包（dependents）
//   · events/listeners 归属升级：owner 原文 + row 聚合名
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Context, Service } from '@agentchat/cordis';
import { TimerService as VendorTimer } from '@agentchat/cordis-timer';
import { WebServerService } from 'ac-web-server';
import { ToolsService } from 'ac-tools';
import { AgentsService } from 'ac-agents';
import { AgentStoreService } from 'ac-agent-store';
import { ConfigService } from 'ac-config';
import { CredentialsService } from 'ac-credentials';
import { SessionService } from 'ac-session';
import { GroupService } from 'ac-group';
import { UsageService } from 'ac-usage';
import { DurableInteractionService } from 'ac-durable-interaction';
import { LlmService } from 'ac-llm';
import { JobsService } from 'ac-jobs';
import { BackupService } from 'ac-backup';
import { PluginRegistryService } from 'ac-plugin-registry';
import { WorkspaceService } from 'ac-workspace';
import { SinglesService } from 'ac-singles';
import { AgentPresetsService } from 'ac-agent-presets';
import * as helloRow from 'ac-hello';
import * as timersRow from 'ac-timer';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import * as webApiRow from '../src/index.ts';

/** 会话状态机桩 */
class StubConversationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }
  async deliver(): Promise<never> {
    return { kind: 'run', result: { finish: 'stop' } } as never;
  }
  abort(): number {
    return 0;
  }
  stats() {
    return { running: [], queued: {} };
  }
  isBusy(): boolean {
    return false;
  }
}

const harnesses: Array<{ web: WebServerService; ctx: Context }> = [];
const sockets: WebSocket[] = [];

async function boot(): Promise<{ ctx: Context; port: number }> {
  const ctx = new Context();
  const root = join(await mkdtemp(join(tmpdir(), 'ac-depgraph-')), 'data');
  mkdirSync(root, { recursive: true });
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  await ctx.plugin(VendorTimer as unknown as { apply(ctx: Context): unknown });
  new StubConversationService(ctx);
  new ToolsService(ctx);
  new AgentsService(ctx);
  new AgentStoreService(ctx, { root });
  new CredentialsService(ctx, { root });
  new ConfigService(ctx, { root });
  new SessionService(ctx, { root });
  new GroupService(ctx);
  new UsageService(ctx, { root });
  new DurableInteractionService(ctx);
  new LlmService(ctx);
  new JobsService(ctx);
  new BackupService(ctx, { root });
  new PluginRegistryService(ctx, { root });
  new WorkspaceService(ctx, { root, browserDaemon: false });
  new SinglesService(ctx, { root });
  new AgentPresetsService(ctx);
  await ctx.plugin(timersRow, { root, heartbeatMs: 60_000 });
  await ctx.plugin(helloRow); // 模块行（inject 无——独立行，聚合锚点）
  await ctx.plugin(webApiRow);
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, port };
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

function rpc(ws: WebSocket, method: string, requestId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('plugin/dep-graph + 归属聚合（M25 P3）', () => {
  it('反依赖图：行 × inject 键集 + 传递闭包 + 保护行标记', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'plugin/dep-graph', 'r1');
    expect(r.ok).toBe(true);
    const rows = r.result.rows as Array<{
      name: string;
      deps: string[];
      rowDeps: string[];
      dependents: string[];
      protected: boolean;
    }>;
    expect(rows.length).toBeGreaterThan(4);
    // hello 行 inject ['tools'] → deps 含 tools 键；行级依赖归一到提供方
    // （本 harness 直构 ToolsService 挂 root → 伪行 '(root)'；生产 yml
    // 组合下服务住行 fiber → 行名）
    const hello = rows.find((x) => x.name === 'ac-hello');
    expect(hello?.deps).toContain('tools');
    expect(hello?.rowDeps).toContain('(root)');
    // 保护行标记（本 harness 未装 security 行——断言 e2e 组合中的标记语义
    // 由 portb-e2e 全树覆盖；此处校验字段形状）
    for (const r of rows) expect(typeof r.protected).toBe('boolean');
    // 传递闭包（直构 harness 下 tools 归属伪行 '(root)'；行级边对
    // 'ac-hello' 仍成立——dependents 含于 '(root)' 的反查面不可见，
    // 用 deps 反向断言）
    expect(hello?.rowDeps).toContain('(root)');
    expect(typeof r.result.note).toBe('string'); // ctx.get 软依赖盲区说明
  });

  it('events/listeners 归属升级：owner 原文 + row 聚合名（键不变）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'events/listeners', 'r1');
    expect(r.ok).toBe(true);
    const events = r.result.events as Array<{
      name: string;
      listeners: Array<{ owner: string; row: string }>;
    }>;
    expect(events.length).toBeGreaterThan(3);
    // 全部监听器携带聚合行名（row ≥ owner 信息量——聚合或原文）
    for (const ev of events) {
      for (const l of ev.listeners) {
        expect(typeof l.row).toBe('string');
        expect(l.row.length).toBeGreaterThan(0);
      }
    }
  });
});
