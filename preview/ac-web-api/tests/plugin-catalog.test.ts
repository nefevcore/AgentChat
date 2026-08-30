// ============================================================
// ac-web-api/tests/plugin-catalog.test.ts —— M24 P3：plugin/catalog RPC
//   · 内置清单 = 声明 agentchat.plugin: true 的行包（dev 扫描 ac-*/ 的
//     package.json；纯库/组合根 fail-closed 出局——X2 收敛）
//   · 装配状态列与 cordis registry 交叉（已装配/未装配）
//   · 本地组合并判据（registry ∪ devScan ∪ 会话装载）+ 待审并入徽章态
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 会话状态机桩（同 web-api.test：只验编排不跑深链） */
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

async function boot(): Promise<{ ctx: Context; plugins: PluginRegistryService; root: string; port: number }> {
  const ctx = new Context();
  const root = join(await mkdtemp(join(tmpdir(), 'ac-catalog-')), 'data');
  mkdirSync(root, { recursive: true });
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  // 官方 cordis-timer：timers 服务的 ctx.timeout/interval 依赖（web-api 行 inject）
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
  const plugins = new PluginRegistryService(ctx, { root });
  new WorkspaceService(ctx, { root, browserDaemon: false });
  new SinglesService(ctx, { root });
  new AgentPresetsService(ctx);
  // timers 行（web-api 行 inject 'timers'——静态依赖须先就位）
  await ctx.plugin(timersRow, { root, heartbeatMs: 60_000 });
  // 模块行（runtime.name = 包名——装配交叉断言的锚点；直构服务的
  // runtime 名非包名，cross 只对模块行有意义）
  await ctx.plugin(helloRow);
  await ctx.plugin(webApiRow);
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, plugins, root, port };
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

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<any> {
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
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

interface CatalogResult {
  builtin: Array<{ name: string; version?: string; description?: string; assembled: boolean; fibers: number }>;
  note?: string;
  local: Array<{ name: string; state: string; owner?: string; error?: string }>;
  pending: Array<{ pendingId: string; name: string; owner: string }>;
}

describe('plugin/catalog（M24 P3）', () => {
  it('内置清单 = 声明 agentchat.plugin 的行包；装配状态与 cordis registry 交叉', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'plugin/catalog', 'r1');
    expect(r.ok).toBe(true);
    const cat = r.result as CatalogResult;

    // 与磁盘声明集一致（名不符目录的包不采信——此处全部一致）：
    // 仅收 package.json 声明 agentchat.plugin: true 的行包
    const previewDir = new URL('../../', import.meta.url);
    const declaredNames = readdirSync(previewDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('ac-'))
      .filter((e) => {
        try {
          const pkg = JSON.parse(readFileSync(new URL(`./${e.name}/package.json`, previewDir), 'utf-8'));
          return pkg.name === e.name && pkg.agentchat?.plugin === true;
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .sort();
    expect(cat.builtin.map((b) => b.name)).toEqual(declaredNames);
    expect(declaredNames.length).toBeGreaterThan(50); // 行包主体在场（回归护栏）

    // 已装配交叉：模块行（runtime.name = 包名）→ assembled=true
    const hello = cat.builtin.find((b) => b.name === 'ac-hello');
    expect(hello?.assembled).toBe(true);
    expect(hello?.fibers).toBeGreaterThan(0);
    // 纯库/组合根不再出现（旧版"未装配"假可供性退役）：
    // ac-openai-completions 是纯库、ac-app 是组合根——均未声明，不进目录
    expect(cat.builtin.find((b) => b.name === 'ac-openai-completions')).toBeUndefined();
    expect(cat.builtin.find((b) => b.name === 'ac-app')).toBeUndefined();
  });

  it('本地四态（装载/安装/熔断/待审）+ dev 面：registry ∪ devScan ∪ 会话装载合并', async () => {
    const h = await boot();
    // dev 面：<root>/plugins/<owner>/<name>/manifest.json
    const devDir = join(h.root, 'plugins', 'dev-agent', 'my-weather-tool');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(
      join(devDir, 'manifest.json'),
      JSON.stringify({ name: 'my-weather-tool', version: '1.0.0', entry: 'index.ts' }),
      'utf-8',
    );
    const ws = await connect(h.port);

    const r0 = await rpc(ws, 'plugin/catalog', 'r1');
    const cat0 = r0.result as CatalogResult;
    // dev 面：未装载未安装 → state 'dev'（owner 透出）
    const dev = cat0.local.find((l) => l.name === 'my-weather-tool');
    expect(dev).toMatchObject({ state: 'dev', owner: 'dev-agent' });

    // 安装态（registry）：直接构造已安装记录（经 installFromDir 走真流程过重，
    // 这里用 store 写入 + boot 恢复同款文件域——以 stage+手工 registry 落盘模拟）
    const regDir = join(h.root, 'plugins', 'installed-tool');
    mkdirSync(regDir, { recursive: true });
    writeFileSync(join(regDir, 'manifest.json'), JSON.stringify({ name: 'installed-tool', version: '0.2.0', entry: 'index.ts' }), 'utf-8');
    writeFileSync(join(regDir, 'index.ts'), 'export function apply() {}\n', 'utf-8');
    // 待审暂存：经 stage 真入口（目录作为来源）
    await h.plugins.stage(regDir, 'host');
    const staging = h.plugins.listStaging();
    expect(staging).toHaveLength(1);

    const r1 = await rpc(ws, 'plugin/catalog', 'r2');
    const cat1 = r1.result as CatalogResult;
    const pendingEntry = cat1.pending.find((p) => p.name === 'installed-tool');
    expect(pendingEntry).toBeTruthy();
    expect(pendingEntry?.owner).toBe('host');

    // 装载/安装态：装载后的插件 state='loaded'（installFromDir 免审真流程）
    const outcome = await h.plugins.installFromDir(regDir, 'host');
    expect(outcome.status).toBe('installed');
    const r3 = await rpc(ws, 'plugin/catalog', 'r3');
    const cat3 = r3.result as CatalogResult;
    expect(cat3.local.find((l) => l.name === 'installed-tool')).toMatchObject({ state: 'loaded' });

    // 熔断态：卸载装载 → 写 .load-health disabled 集 → boot 扫描跳过 → skipped
    expect(await h.plugins.unload('installed-tool')).toBe(true);
    const health = { version: 1 as const, failures: {}, disabled: { 'installed-tool': { count: 3, reason: '连续装载失败已熔断', at: '2026-08-30T00:00:00.000Z' } } };
    writeFileSync(join(h.root, 'plugins', '.load-health.json'), JSON.stringify(health), 'utf-8');
    const skipped = await h.plugins.loadInstalled();
    expect(skipped).toEqual([]);
    const r4 = await rpc(ws, 'plugin/catalog', 'r4');
    const cat4 = r4.result as CatalogResult;
    expect(cat4.local.find((l) => l.name === 'installed-tool')?.state).toBe('skipped');
  });
});
