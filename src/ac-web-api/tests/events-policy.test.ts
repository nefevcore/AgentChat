// ============================================================
// ac-web-api/tests/events-policy.test.ts —— cr-392：events/policy-list
//   live 语义锁定（旧实现 isDisabled 自证恒真——停用集键查停用集必命中）
//   · live = 停用键的 (owner,event) 当前确有在链可停条目（执行链交叉）
//   · stale 键（注册不存在）与已吞/清扫条目（等重载）→ 不在 live
//   · events/policy-set 行未装载 → fail-loud（薄编排行模式锁定）
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
import { RestartService } from 'ac-restart';
import { PluginRegistryService } from 'ac-plugin-registry';
import { WorkspaceService } from 'ac-workspace';
import { SinglesService } from 'ac-singles';
import { AgentPresetsService } from 'ac-agent-presets';
import * as builtinRow from 'ac-agent-presets-builtin';
import * as timersRow from 'ac-timer';
import * as policyRow from 'ac-event-policy';
import { buildFrame, parseFrame, RPC_CALL, RPC_RESULT, WS_READY } from 'ac-ws-protocol';
import * as webApiRow from '../src/index.ts';

/** 会话状态机桩（同 dep-graph.test.ts 立场——web-api 行 inject 'conversation'） */
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

/** 测试事件目录声明（治理面词汇——声明合并进 Events） */
declare module '@agentchat/cordis' {
  interface Events {
    'demo/policy-probe'(): void;
  }
}

const harnesses: Array<{ web: WebServerService; ctx: Context }> = [];
const sockets: WebSocket[] = [];

/** 治理面 harness：base 组合 + 策略行（挂载与否由参数定——两用例共用） */
async function boot(withPolicy: boolean): Promise<{ ctx: Context; port: number }> {
  const ctx = new Context();
  const root = join(await mkdtemp(join(tmpdir(), 'ac-evpolicy-')), 'data');
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
  new RestartService(ctx);
  new PluginRegistryService(ctx, { root });
  new WorkspaceService(ctx, { root });
  new SinglesService(ctx, { root });
  new AgentPresetsService(ctx);
  await ctx.plugin(builtinRow as unknown as { apply(ctx: Context): unknown });
  await ctx.plugin(timersRow, { root, heartbeatMs: 60_000 }); // web-api 行 inject 'timers'
  await ctx.plugin(webApiRow);
  if (withPolicy) await ctx.plugin(policyRow);
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      if (parseFrame(raw.toString())?.type === WS_READY) resolve(ws);
    });
  });
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }): void => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params: params ?? {} }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('events/policy 治理面（cr-392）', () => {
  it('live 交叉语义：在链条目 → live；sweep 后与 stale 键 → 不在 live', async () => {
    const { ctx, port } = await boot(true);
    // probe 监听器先于策略行注册（逃逸在链——boot 期注册时序的真实形态）
    const probe = await ctx.plugin({
      name: 'probe-row',
      apply(c: Context) {
        c.on('demo/policy-probe', () => undefined, { description: 'policy probe' });
      },
    } as { name: string; apply(c: Context): void });
    await ctx.config.set('events.disabled', ['probe-row::demo/policy-probe']);
    const ws = await connect(port);
    // ① 停用键 × 条目在链（注册逃逸，sweep 前）→ live 含
    let r = await rpc(ws, 'events/policy-list', 'r1');
    expect(r.ok).toBe(true);
    expect(r.result.disabled).toEqual(['probe-row::demo/policy-probe']);
    expect(r.result.live).toEqual(['probe-row::demo/policy-probe']);
    // ② sweep 后条目离链 → live 空（disabled 仍在——等重载/重启生效）
    ctx.eventPolicy.sweep();
    r = await rpc(ws, 'events/policy-list', 'r2');
    expect(r.result.live).toEqual([]);
    expect(r.result.disabled).toEqual(['probe-row::demo/policy-probe']);
    // ③ stale 键（owner 无注册）→ 不在 live（disabled 与 live 分离的断言锚）
    await ctx.config.set('events.disabled', ['probe-row::demo/policy-probe', 'ghost-row::demo/policy-probe']);
    r = await rpc(ws, 'events/policy-list', 'r3');
    expect(r.result.disabled).toHaveLength(2);
    expect(r.result.live).toEqual([]);
    // ④ 新注册被吞（不进链）→ 仍不在 live
    const again = await ctx.plugin({
      name: 'probe-row',
      apply(c: Context) {
        c.on('demo/policy-probe', () => undefined);
      },
    } as { name: string; apply(c: Context): void });
    r = await rpc(ws, 'events/policy-list', 'r4');
    expect(r.result.live).toEqual([]);
    await probe.dispose();
    await again.dispose();
  });

  it('行未装载 → policy-list/policy-set fail-loud（薄编排行模式）', async () => {
    const { port } = await boot(false);
    const ws = await connect(port);
    const r1 = await rpc(ws, 'events/policy-list', 'r1');
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/eventPolicy 服务未装载/);
    const r2 = await rpc(ws, 'events/policy-set', 'r2', { key: 'x-row::demo/policy-probe', disabled: true });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/eventPolicy 服务未装载/);
  });
});