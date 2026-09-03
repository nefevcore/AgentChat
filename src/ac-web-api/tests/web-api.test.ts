// ============================================================
// ac-web-api：RPC 业务方法面
// 真实起服（port 0）+ 真实域服务（session/group/usage/interaction/
// agents/tools 轻量真实件；conversation 用脚本桩）+ ws 客户端验证
// 参数窄化、ack 映射（busy/parked）、结果形状。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
import { BackupService } from 'ac-backup';
import { PluginRegistryService } from 'ac-plugin-registry';
import { WorkspaceService } from 'ac-workspace';
import { SinglesService } from 'ac-singles';
import { ConvSettingsService } from 'ac-conv-settings';
import { GoalsService } from 'ac-goal';
import { TodosService } from 'ac-todo';
import { AgentPresetsService } from 'ac-agent-presets';
import * as timersRow from 'ac-timer';
import type { TimersService } from 'ac-timer';
import type { ConversationOutcome } from 'ac-conversation';
import {
  buildFrame,
  parseFrame,
  RPC_CALL,
  RPC_RESULT,
  WS_ACK,
  WS_READY,
} from 'ac-ws-protocol';
import * as webApiRow from '../src/index.ts';

/** 会话状态机桩：脚本化 deliver outcome / isBusy（真件需 router+loop 深链，此处只验编排） */
class StubConversationService extends Service {
  nextOutcome: ConversationOutcome = { kind: 'run', result: { finish: 'stop' } as never };
  busy = false;
  delivered: Array<{ agentId: string; message: unknown; options: Record<string, unknown> }> = [];
  aborted: Array<{ agentId: string; conversationId?: string }> = [];
  queueSnapshot: Array<{ id: string; preview: string }> = [];
  queueCalls: Array<{ agentId: string; conversationId: string | undefined; id?: string }> = [];
  nextSteerOutcome: 'steered' | 'requeued' | 'not-found' = 'steered';

  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }

  async deliver(agentId: string, message: unknown, options: Record<string, unknown> = {}): Promise<ConversationOutcome> {
    this.delivered.push({ agentId, message, options });
    return this.nextOutcome;
  }

  abort(agentId: string, conversationId?: string): number {
    this.aborted.push({ agentId, conversationId });
    return 1;
  }

  stats(): { running: never[]; queued: Record<string, never> } {
    return { running: [], queued: {} };
  }

  isBusy(): boolean {
    return this.busy;
  }

  queue(agentId: string, conversationId?: string): Array<{ id: string; preview: string }> {
    this.queueCalls.push({ agentId, conversationId });
    return this.queueSnapshot;
  }

  removeQueued(agentId: string, conversationId: string | undefined, id: string): boolean {
    this.queueCalls.push({ agentId, conversationId, id });
    return true;
  }

  steerQueued(agentId: string, conversationId: string | undefined, id: string): 'steered' | 'requeued' | 'not-found' {
    this.queueCalls.push({ agentId, conversationId, id });
    return this.nextSteerOutcome;
  }
}

interface Harness {
  ctx: Context;
  web: WebServerService;
  conversation: StubConversationService;
  session: SessionService;
  group: GroupService;
  interaction: DurableInteractionService;
  agents: AgentsService;
  config: ConfigService;
  timers: TimersService;
  backup: BackupService;
  llm: LlmService;
  plugins: PluginRegistryService;
  root: string;
  port: number;
}

const harnesses: Array<{ web: WebServerService; ctx: Context }> = [];
const sockets: WebSocket[] = [];

async function boot(): Promise<Harness> {
  const ctx = new Context();
  const root = join(await mkdtemp(join(tmpdir(), 'ac-web-api-')), 'data');
  mkdirSync(root, { recursive: true });
  const web = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  // 官方 cordis-timer：timers 服务的 ctx.timeout/interval 依赖
  await ctx.plugin(VendorTimer as unknown as { apply(ctx: Context): unknown });
  const conversation = new StubConversationService(ctx);
  const tools = new ToolsService(ctx);
  const agents = new AgentsService(ctx);
  const store = new AgentStoreService(ctx, { root });
  const creds = new CredentialsService(ctx, { root });
  const config = new ConfigService(ctx, { root });
  const session = new SessionService(ctx, { root });
  const group = new GroupService(ctx); // 内存态（root 缺省）
  const usage = new UsageService(ctx, { root });
  const interaction = new DurableInteractionService(ctx);
  const llm = new LlmService(ctx);
  const backup = new BackupService(ctx, { root });
  const plugins = new PluginRegistryService(ctx, { root });
  // workspace（M17-E 文件面；构造默认 user + files 目录布局）
  const workspace = new WorkspaceService(ctx, { root, browserDaemon: false });
  void workspace;
  // singles（M18-G 独立会话元数据；可选能力行）
  const singles = new SinglesService(ctx, { root });
  void singles;
  // conv-settings（P6/D4 会话级覆盖；可选能力行）
  const convSettings = new ConvSettingsService(ctx, { root });
  void convSettings;
  // presets（预设 Agent 目录；可选能力行——agents/presets RPC 数据源）
  const presets = new AgentPresetsService(ctx);
  void presets;
  // goal/todo（任务追踪；可选能力行——goal/get·todo/get RPC 数据源）
  const goals = new GoalsService(ctx);
  const todos = new TodosService(ctx);
  void goals;
  void todos;
  // timers 行（静态 inject 依赖 timer/agents/agentStore/conversation/config）
  await ctx.plugin(timersRow, { root, heartbeatMs: 60_000 });
  const timers = ctx.timers;
  void tools;
  void usage;
  void creds;
  void store;
  await ctx.plugin(webApiRow);
  const port = await web.ready();
  harnesses.push({ web, ctx });
  return { ctx, web, conversation, session, group, interaction, agents, config, timers, backup, llm, plugins, root, port };
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

interface RpcResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function rpc(ws: WebSocket, method: string, requestId: string, params?: unknown): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: { toString(): string }) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type !== RPC_RESULT) return;
      if ((frame.data as { requestId?: string }).requestId !== requestId) return;
      ws.off('message', onMessage);
      resolve(frame.data as RpcResult);
    };
    ws.on('message', onMessage);
    ws.on('error', reject);
    ws.send(buildFrame(RPC_CALL, { method, requestId, params }));
  });
}

/** 收集窗口期内的 ws/ack 帧 */
function collectAcks(ws: WebSocket): Array<{ requestId: string; kind: string; info?: Record<string, unknown> }> {
  const acks: Array<{ requestId: string; kind: string; info?: Record<string, unknown> }> = [];
  ws.on('message', (raw) => {
    const frame = parseFrame(raw.toString());
    if (frame?.type === WS_ACK) acks.push(frame.data as { requestId: string; kind: string });
  });
  return acks;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) {
    await h.web.stop();
    await h.ctx.fiber.dispose();
  }
});

describe('ac-web-api conversation 面', () => {
  it('deliver：run outcome 原样返回、无 ack；参数窄化透传', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const acks = collectAcks(ws);
    const r = await rpc(ws, 'conversation/deliver', 'r1', {
      agentId: 'a1',
      message: '你好',
      conversationId: 'c1',
      sender: 'user',
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ kind: 'run', result: { finish: 'stop' } });
    expect(h.conversation.delivered).toEqual([
      { agentId: 'a1', message: '你好', options: { conversationId: 'c1', sender: 'user' } },
    ]);
    expect(acks).toEqual([]);
  });

  it('deliver：attachments 白名单校验透传（多模态一期）；非法项丢弃、超限拒绝', async () => {
    const h = await boot();
    const ws = await connect(h.port);

    // ① 合法引用：kind/ref 透传 + mime/filename/detail 选填保留
    const r1 = await rpc(ws, 'conversation/deliver', 'r1', {
      agentId: 'a1',
      message: '看图',
      attachments: [
        { kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' },
        { kind: 'audio', ref: 'files/user/_tmp/a.mp3' },   // kind 非白名单 → 丢弃
        { kind: 'image', ref: '' },                            // ref 空 → 丢弃
        { kind: 'image', ref: 'https://cdn.example.com/a.jpg', mime: 'image/jpeg' },
        'garbage',                                             // 非对象 → 丢弃
      ],
    });
    expect(r1.ok).toBe(true);
    expect((h.conversation.delivered[0].message as { attachments?: unknown[] }).attachments).toEqual([
      { kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png', detail: 'low' },
      { kind: 'image', ref: 'https://cdn.example.com/a.jpg', mime: 'image/jpeg' },
    ]);

    // ② 字符串消息不带 attachments（零回归）
    await rpc(ws, 'conversation/deliver', 'r2', { agentId: 'a1', message: '纯文本' });
    expect(h.conversation.delivered[1].message).toBe('纯文本');

    // ③ 超限拒绝（>50）
    const many = Array.from({ length: 51 }, (_, i) => ({ kind: 'image', ref: `files/x/${i}.png` }));
    const r3 = await rpc(ws, 'conversation/deliver', 'r3', { agentId: 'a1', message: 'q', attachments: many });
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('50');
  });

  it('deliver：steered/queued → ws/ack busy；timeout → rpc error', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const acks = collectAcks(ws);

    h.conversation.nextOutcome = { kind: 'steered', handle: 'a1' };
    const r1 = await rpc(ws, 'conversation/deliver', 'r1', { agentId: 'a1', message: 'x' });
    expect(r1.result).toEqual({ kind: 'steered', handle: 'a1' });
    expect(acks[0]).toMatchObject({ requestId: 'r1', kind: 'busy', info: { handle: 'a1' } });

    h.conversation.nextOutcome = { kind: 'queued', handle: 'a1' };
    const r2 = await rpc(ws, 'conversation/deliver', 'r2', { agentId: 'a1', message: 'x' });
    expect(r2.result).toEqual({ kind: 'queued', handle: 'a1' });
    expect(acks[1]).toMatchObject({ requestId: 'r2', kind: 'busy', info: { queued: true, handle: 'a1' } });

    h.conversation.nextOutcome = { kind: 'timeout', handle: 'a1' };
    const r3 = await rpc(ws, 'conversation/deliver', 'r3', { agentId: 'a1', message: 'x' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('超时');
  });

  it('deliver：next-run + 忙 → 预发 parked ack', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const acks = collectAcks(ws);
    h.conversation.busy = true;
    const r = await rpc(ws, 'conversation/deliver', 'r1', {
      agentId: 'a1',
      message: 'x',
      placement: 'next-run',
    });
    expect(r.ok).toBe(true);
    expect(acks[0]).toMatchObject({ requestId: 'r1', kind: 'parked' });
  });

  it('deliver：缺 agentId → rpc error；interrupt/stats 转发', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const bad = await rpc(ws, 'conversation/deliver', 'r1', { message: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('agentId');

    const stop = await rpc(ws, 'conversation/interrupt', 'r2', { agentId: 'a1' });
    expect(stop.result).toEqual({ aborted: 1 });
    expect(h.conversation.aborted).toEqual([{ agentId: 'a1', conversationId: undefined }]);

    const stats = await rpc(ws, 'conversation/stats', 'r3');
    expect(stats.result).toEqual({ running: [], queued: {} });
  });

  it('queue 面：queue/queue-remove/queue-steer 转发（会话键与 deliver 同口径）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.conversation.queueSnapshot = [{ id: 'q1', preview: '排队消息' }];

    // 快照：显式 conversationId 透传
    const q = await rpc(ws, 'conversation/queue', 'r1', { agentId: 'a1', conversationId: 'a1~user' });
    expect(q.result).toEqual({ items: [{ id: 'q1', preview: '排队消息' }] });
    expect(h.conversation.queueCalls[0]).toEqual({ agentId: 'a1', conversationId: 'a1~user' });

    // 缺省 conversationId = 直答对桶 pairKey(sender?, agentId)（deliver 同口径）
    await rpc(ws, 'conversation/queue', 'r2', { agentId: 'a1' });
    expect(h.conversation.queueCalls[1]).toEqual({ agentId: 'a1', conversationId: 'a1~user' });

    // 删除
    const del = await rpc(ws, 'conversation/queue-remove', 'r3', { agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
    expect(del.result).toEqual({ removed: true });
    expect(h.conversation.queueCalls[2]).toEqual({ agentId: 'a1', conversationId: 'a1~user', id: 'q1' });

    // 插话（三态透传：steered / requeued / not-found）
    const s1 = await rpc(ws, 'conversation/queue-steer', 'r4', { agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
    expect(s1.result).toEqual({ outcome: 'steered' });
    h.conversation.nextSteerOutcome = 'requeued';
    const s2 = await rpc(ws, 'conversation/queue-steer', 'r5', { agentId: 'a1', conversationId: 'a1~user', id: 'q1' });
    expect(s2.result).toEqual({ outcome: 'requeued' });

    // 缺 id → rpc error（白名单窄化）
    const bad = await rpc(ws, 'conversation/queue-steer', 'r6', { agentId: 'a1', conversationId: 'a1~user' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('id');
  });
});

describe('ac-web-api session / agents 面', () => {
  it('session/history + delete-message（真 SessionService）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await h.session.append('c1', 'c1', { role: 'user', content: '问题' });
    await h.session.append('c1', 'c1', { role: 'assistant', content: '回答' });

    const hist = await rpc(ws, 'session/history', 'r1', { conversationId: 'c1' });
    expect(hist.ok).toBe(true);
    const records = (hist.result as { records: Array<{ role: string; content: string; message_id: string }> }).records;
    expect(records.map((r) => r.content)).toEqual(['问题', '回答']);

    const del = await rpc(ws, 'session/delete-message', 'r2', {
      conversationId: 'c1',
      messageId: records[0].message_id,
    });
    expect(del.result).toEqual({ deleted: true });

    const hist2 = await rpc(ws, 'session/history', 'r3', { conversationId: 'c1' });
    expect((hist2.result as { records: unknown[] }).records.map((r) => (r as { content: string }).content)).toEqual(['回答']);

    const miss = await rpc(ws, 'session/delete-message', 'r4', {
      conversationId: 'c1',
      messageId: 'msg-none',
    });
    expect(miss.result).toEqual({ deleted: false });

    // truncateAfter：删除该消息及其后全部（行内编辑语义）
    await h.session.append('c1', 'c1', { role: 'assistant', content: '后续回答' });
    const full = await rpc(ws, 'session/history', 'r5', { conversationId: 'c1' });
    const recs = (full.result as { records: Array<{ message_id: string; content: string }> }).records;
    const firstId = recs[0].message_id;
    const trunc = await rpc(ws, 'session/truncate', 'r6', { conversationId: 'c1', messageId: firstId });
    expect(trunc.result).toEqual({ removed: 2 });
    const after = await rpc(ws, 'session/history', 'r7', { conversationId: 'c1' });
    expect((after.result as { records: unknown[] }).records).toEqual([]);
  });

  it('session/history 服务端分页（M16）：limit/offset 从尾部往回取', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 7 条消息（m0..m6，时间序）
    for (let i = 0; i < 7; i++) {
      await h.session.append('c1', 'c1', { role: 'user', content: `m${i}` });
    }

    // 全量回读（缺省 limit——向后兼容旧调用方）
    const all = await rpc(ws, 'session/history', 'r0', { conversationId: 'c1' });
    const allRes = all.result as { records: Array<{ content: string }>; total: number; hasMore?: boolean };
    expect(allRes.records.map((r) => r.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(allRes.total).toBe(7);
    expect(allRes.hasMore).toBeUndefined();

    // 第一页：最新 3 条（尾部对齐）
    const p1 = await rpc(ws, 'session/history', 'r1', { conversationId: 'c1', limit: 3, offset: 0 });
    const r1 = p1.result as { records: Array<{ content: string }>; total: number; hasMore: boolean };
    expect(r1.records.map((x) => x.content)).toEqual(['m4', 'm5', 'm6']);
    expect(r1.hasMore).toBe(true);

    // 第二页：offset=3 → m1..m3；hasMore 仍有
    const p2 = await rpc(ws, 'session/history', 'r2', { conversationId: 'c1', limit: 3, offset: 3 });
    const r2 = p2.result as { records: Array<{ content: string }>; hasMore: boolean };
    expect(r2.records.map((x) => x.content)).toEqual(['m1', 'm2', 'm3']);
    expect(r2.hasMore).toBe(true);

    // 末页：offset=6 → 只剩 m0；hasMore=false
    const p3 = await rpc(ws, 'session/history', 'r3', { conversationId: 'c1', limit: 3, offset: 6 });
    const r3 = p3.result as { records: Array<{ content: string }>; hasMore: boolean };
    expect(r3.records.map((x) => x.content)).toEqual(['m0']);
    expect(r3.hasMore).toBe(false);

    // 越界 offset → 空页；非法 limit（负数/非整数）→ 按缺省全量
    const p4 = await rpc(ws, 'session/history', 'r4', { conversationId: 'c1', limit: 3, offset: 100 });
    expect((p4.result as { records: unknown[] }).records).toEqual([]);
    const p5 = await rpc(ws, 'session/history', 'r5', { conversationId: 'c1', limit: -1, offset: 0 });
    expect((p5.result as { records: unknown[] }).records).toHaveLength(7);
  });

  it('agents/list + tool-defs 生效集（真 AgentsService/ToolsService）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'a1', model: 'm', tools: { include: ['t1', 't2'], exclude: ['t2'] } });
    h.agents.register({ id: 'a2', model: 'm' });
    h.ctx.tools.register({ name: 't1', execute: () => ({ ok: true }) });
    h.ctx.tools.register({ name: 't2', execute: () => ({ ok: true }) });

    const list = await rpc(ws, 'agents/list', 'r1');
    // workspace 行构造默认 virtual user —— 与测试注册的两个 Agent 并存
    expect((list.result as { agents: Array<{ id: string }> }).agents.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'user']);

    const defs1 = await rpc(ws, 'agents/tool-defs', 'r2', { agentId: 'a1' });
    expect(defs1.result).toMatchObject({ agentId: 'a1', names: ['t1'] });
    expect((defs1.result as { defs: Array<{ name: string }> }).defs.map((d) => d.name)).toEqual(['t1']);

    const defs2 = await rpc(ws, 'agents/tool-defs', 'r3', { agentId: 'a2' });
    expect(defs2.result).toMatchObject({ agentId: 'a2', names: ['t1', 't2'] });

    const miss = await rpc(ws, 'agents/tool-defs', 'r4', { agentId: 'nope' });
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('unknown agent');
  });
});

describe('ac-web-api group / usage / interaction 面', () => {
  it('group 全套：create（自动 id）/list/join/send/history/rename/delete（真 GroupService）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'gpt', model: 'm' });

    const created = await rpc(ws, 'group/create', 'r1', { name: '测试群', members: ['gpt'] });
    const group = (created.result as { group: { id: string; name: string; members: string[] } }).group;
    expect(group.name).toBe('测试群');
    expect(group.members).toEqual(['gpt']);
    expect(group.id).toMatch(/^g-/);

    const list = await rpc(ws, 'group/list', 'r2');
    expect((list.result as { groups: unknown[] }).groups).toHaveLength(1);

    const renamed = await rpc(ws, 'group/rename', 'r2b', { groupId: group.id, name: '改名群' });
    expect(renamed.result).toEqual({ renamed: true });
    expect(h.group.get(group.id)?.name).toBe('改名群');

    const sent = await rpc(ws, 'group/send', 'r3', { groupId: group.id, from: 'user', content: '大家好' });
    expect((sent.result as { message: { content: string }; triggered: string[] }).message.content).toBe('大家好');
    expect((sent.result as { triggered: string[] }).triggered).toEqual(['gpt']);

    const hist = await rpc(ws, 'group/history', 'r4', { groupId: group.id });
    expect((hist.result as { messages: Array<{ from: string; content: string }> }).messages).toEqual([
      expect.objectContaining({ from: 'user', content: '大家好' }),
    ]);

    const gone = await rpc(ws, 'group/delete', 'r5', { groupId: group.id });
    expect(gone.result).toEqual({ deleted: true });
    expect((await rpc(ws, 'group/list', 'r6')).result).toEqual({ groups: [] });
  });

  it('group/send attachments（M4 群聊图片）：本体行落盘 + hint 信封直达 + historyFor 回放', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'gpt', model: 'm' });
    const created = await rpc(ws, 'group/create', 'r1', { name: '图群', members: ['gpt'] });
    const gid = (created.result as { group: { id: string } }).group.id;

    const atts = [{ kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png' }];
    const sent = await rpc(ws, 'group/send', 'r2', {
      groupId: gid, from: 'user', content: '看图', attachments: atts,
    });
    expect(sent.ok).toBe(true);
    // ① hint 信封（conversation.deliver 桩）：message 为 LlmMessage 且携带附件引用
    expect(h.conversation.delivered[0].message).toMatchObject({
      role: 'user',
      attachments: [{ kind: 'image', ref: 'files/user/_tmp/x.png', filename: 'x.png' }],
    });
    // ② 本体行（group/history = GroupMessageRecord 投影）
    const hist = await rpc(ws, 'group/history', 'r3', { groupId: gid });
    expect((hist.result as { messages: Array<{ attachments?: unknown[] }> }).messages[0].attachments).toEqual(atts);
    // ③ 会话落盘行（session 本体）
    const records = await h.session.records(gid);
    expect(records[0].attachments).toEqual(atts);
    // ④ 成员视角回放（historyFor）：peer 合并行携带附件
    const seeds = await h.group.historyFor(gid, 'gpt');
    expect(seeds.some((m) => Array.isArray((m as { attachments?: unknown[] }).attachments)
      && (m as { attachments: unknown[] }).attachments.length === 1)).toBe(true);
    // ⑤ 非法附件项丢弃（kind 白名单）
    const sent2 = await rpc(ws, 'group/send', 'r4', {
      groupId: gid, from: 'user', content: '再来',
      attachments: [{ kind: 'audio', ref: 'files/a.mp3' }, { kind: 'image', ref: 'files/user/_tmp/y.jpg' }],
    });
    expect(sent2.ok).toBe(true);
    expect(h.conversation.delivered[1].message).toMatchObject({
      attachments: [{ kind: 'image', ref: 'files/user/_tmp/y.jpg' }],
    });
  });

  it('session/archive：archive 未装载 → 明确 rpc error（方法面仍在）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'session/archive', 'r1', { conversationId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('archive');
  });

  it('usage/tokens 六维汇总形状（byPair 端点对 + byDayModel 交叉维含入）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'usage/tokens', 'r1');
    const result = r.result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['byAgent', 'byConversation', 'byDay', 'byDayModel', 'byModel', 'byPair', 'totals']);
    expect(Array.isArray(result.byPair)).toBe(true);
    expect(Array.isArray(result.byDayModel)).toBe(true);
  });

  it('session/tokens：maxContextTokens（archive hook 覆盖）+ 百分比/均值/剩余条数派生', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'a1', model: 'm', settings: { archive: { maxContextTokens: 200_000 } } });
    // 用量流水：覆盖轨 prompt = 100k（usage 服务订阅 loop/after-run）
    h.ctx.emit('loop/after-run', { agent: 'a1', model: 'm', conversationId: 'a1', messages: [] }, {
      steps: [],
      text: '',
      finish: 'stop',
      usage: { prompt: 100_000, completion: 10, promptAccumulated: 100_000, total: 100_010, steps: 1 },
    } as never);
    // 会话消息计数（1 条）
    await h.session.append('a1', 'a1', { role: 'user', content: 'hi' });

    const r = await rpc(ws, 'session/tokens', 'r1', { conversationId: 'a1' });
    const result = r.result as Record<string, number | string>;
    expect(result.maxContextTokens).toBe(200_000);
    expect(result.lastContextPrompt).toBe(100_000);
    expect(result.messageCount).toBe(1);
    expect(result.usagePercent).toBe(50);
    expect(result.avgTokensPerMsg).toBe(100_000);
    expect(result.estimatedMsgsRemaining).toBe(1);
    // status 按占比（M18：绝对阈值在 1M 分母下 6% 就红）：50% = moderate
    expect(result.status).toBe('moderate');

    // 无 archive hook → 缺省分母 1M；零用量 → 0% 不 NaN
    h.agents.register({ id: 'a2', model: 'm' });
    const r2 = await rpc(ws, 'session/tokens', 'r2', { conversationId: 'a2' });
    const res2 = r2.result as Record<string, number>;
    expect(res2.maxContextTokens).toBe(1_000_000);
    expect(res2.usagePercent).toBe(0);
  });

  it('agents/list 过滤预设 + agents/presets 目录（独立会话选用面）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'plain', model: 'm' });

    const list = await rpc(ws, 'agents/list', 'r1');
    const ids = ((list.result as { agents: Array<{ id: string; preset?: boolean }> }).agents).map((a) => a.id);
    expect(ids).toContain('plain');
    expect(ids).toContain('user'); // virtual 仍在名册（会话端点可见）
    expect(ids).not.toContain('__standard__'); // 预设不进名册（src 过滤语义）
    expect(ids).not.toContain('__dsh_minimal__');

    const cat = await rpc(ws, 'agents/presets', 'r2');
    const presets = (cat.result as { presets: Array<{ id: string; name: string; label: string; default: boolean }> }).presets;
    expect(presets.map((p) => p.id)).toEqual(['__standard__', '__dsh_minimal__']);
    expect(presets[0]).toMatchObject({ name: '标准模式', label: '标准模式', default: true });
    expect(presets[1]).toMatchObject({ label: '极简模式', default: false });
  });

  it('interaction/list + reply（真 DurableInteractionService）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const opened = h.interaction.open({
      key: 'c1',
      kind: 'ask_questions',
      payload: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
    });

    const list = await rpc(ws, 'interaction/list', 'r1', { state: 'pending' });
    const ids = (list.result as { interactions: Array<{ id: string }> }).interactions.map((i) => i.id);
    expect(ids).toContain(opened.id);

    const reply = await rpc(ws, 'interaction/reply', 'r2', { id: opened.id, answer: { answers: ['A'] } });
    expect(reply.result).toMatchObject({ status: 'ok' });

    const dup = await rpc(ws, 'interaction/reply', 'r3', { id: opened.id, answer: { answers: ['B'] } });
    expect(dup.result).toMatchObject({ status: 'duplicate' });
  });

  it('未注册方法 → unknown method rpc error', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'no/such', 'r1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown method');
  });
});

// ============================================================
// M18-G 独立会话面（singles/*：元数据 CRUD + deliver model 覆盖透传）
// ============================================================

describe('ac-web-api M18-G singles 面', () => {
  it('create/list/update/archive/delete 全链 + 引用校验', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'a1', model: 'mock-1' });

    // 创建（空会话先建，Agent 后补）
    const created = await rpc(ws, 'singles/create', 'r1', {});
    expect(created.ok).toBe(true);
    const sid = (created.result as { single: { id: string; agentId: string } }).single.id;
    expect((created.result as { single: { agentId: string } }).single.agentId).toBe('');

    // update：补 Agent + 模型覆盖
    const updated = await rpc(ws, 'singles/update', 'r2', { id: sid, agentId: 'a1', model: 'mock-1' });
    const single = (updated.result as { single: { agentId: string; model: string } }).single;
    expect(single.agentId).toBe('a1');
    expect(single.model).toBe('mock-1');

    // list 可见
    const list = await rpc(ws, 'singles/list', 'r3');
    expect((list.result as { singles: Array<{ id: string }> }).singles.map((s) => s.id)).toContain(sid);

    // update：清除模型覆盖（model: null）
    const cleared = await rpc(ws, 'singles/update', 'r4', { id: sid, model: null });
    expect((cleared.result as { single: { model?: string } }).single.model).toBeUndefined();

    // 引用校验：不存在 Agent 拒绝
    const bad = await rpc(ws, 'singles/create', 'r5', { agentId: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('不存在');

    // archive（软删）→ list 不再可见
    await rpc(ws, 'singles/archive', 'r6', { id: sid });
    const list2 = await rpc(ws, 'singles/list', 'r7');
    expect((list2.result as { singles: Array<{ id: string }> }).singles.map((s) => s.id)).not.toContain(sid);

    // delete（硬删：元数据 + 消息经 session.clear）
    const deleted = await rpc(ws, 'singles/delete', 'r8', { id: sid });
    expect(deleted.result).toEqual({ deleted: true });
  });

  it('conversation/deliver：model 覆盖参数透传（singles 引用语义）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'conversation/deliver', 'r1', {
      agentId: 'a1',
      message: '你好',
      conversationId: 'sid-1',
      model: 'glm-5.3',
    });
    expect(r.ok).toBe(true);
    expect(h.conversation.delivered[0]?.options).toMatchObject({ conversationId: 'sid-1', model: 'glm-5.3' });
  });
});

// ============================================================
// P6/D4 会话设置面（conv-settings/*：会话级模型覆盖 + deliver 合并）
// ============================================================

describe('ac-web-api conv-settings 面', () => {
  it('get/set：name@model 引用存取；null = 清除', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const conv = 'user~a1';
    const empty = await rpc(ws, 'conv-settings/get', 'r1', { conversationId: conv });
    expect(empty.result).toMatchObject({ conversationId: conv, settings: {} });

    const set = await rpc(ws, 'conv-settings/set', 'r2', {
      conversationId: conv,
      patch: { model: 'deepseek@deepseek-v4-pro' },
    });
    expect(set.ok).toBe(true);
    expect(set.result).toMatchObject({ conversationId: conv, settings: { model: 'deepseek@deepseek-v4-pro' } });

    const back = await rpc(ws, 'conv-settings/get', 'r3', { conversationId: conv });
    expect(back.result).toMatchObject({ settings: { model: 'deepseek@deepseek-v4-pro' } });

    const cleared = await rpc(ws, 'conv-settings/set', 'r4', { conversationId: conv, patch: { model: null } });
    expect(cleared.result).toMatchObject({ settings: {} });
  });

  it('deliver 合并点：入参缺省 → conv-settings 存储补投；显式入参优先；singles 会话跳过', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'a1', model: 'mock-1' });
    const conv = 'user~a1';
    h.ctx.convSettings.set(conv, { model: 'glm@glm-5.3' });

    // ① 入参缺省 → 存储补投
    await rpc(ws, 'conversation/deliver', 'r1', { agentId: 'a1', message: 'q', conversationId: conv });
    expect(h.conversation.delivered[0]?.options).toMatchObject({ model: 'glm@glm-5.3' });

    // ② 显式入参优先（临时换模不回写）
    await rpc(ws, 'conversation/deliver', 'r2', { agentId: 'a1', message: 'q', conversationId: conv, model: 'm-tmp' });
    expect(h.conversation.delivered[1]?.options).toMatchObject({ model: 'm-tmp' });
    expect(h.ctx.convSettings.get(conv).model).toBe('glm@glm-5.3'); // 存储未被覆盖

    // ③ singles 会话（sid 在 singles 注册）：即便误写了 conv-settings 也不生效
    const single = h.ctx.get('singles') as unknown as { create(input?: { agentId?: string }): { id: string } };
    const sid = single.create({ agentId: 'a1' }).id;
    h.ctx.convSettings.set(sid, { model: 'stale@x' });
    await rpc(ws, 'conversation/deliver', 'r3', { agentId: 'a1', message: 'q', conversationId: sid });
    expect(h.conversation.delivered[2]?.options).not.toHaveProperty('model');
  });
});

// ============================================================
// M17-A 补齐面
// ============================================================

describe('ac-web-api M17-A timer / backup / jobs 面', () => {
  it('timer/save + entries + trigger（per-Agent 经 agent-store 持久化）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.agents.register({ id: 'a1', model: 'mock' });
    const entry = { id: 'e1', enabled: true, mode: 'time', time: '09:00', hint: '早上好' };
    const saved = await rpc(ws, 'timer/save', 'r1', { agentId: 'a1', entries: [entry] });
    expect(saved.result).toEqual({ saved: true, owner: 'a1' });

    const list = await rpc(ws, 'timer/entries', 'r2', { agentId: 'a1' });
    expect(list.result).toEqual({ owner: 'a1', entries: [entry] });

    const all = await rpc(ws, 'timer/list', 'r3');
    expect((all.result as { entries: Array<{ owner: string }> }).entries.map((e) => e.owner)).toContain('a1');

    // triggerNow → 机制直投（sender:event）；stub 会话记录投递
    const trig = await rpc(ws, 'timer/trigger', 'r4', { agentId: 'a1', entryId: 'e1' });
    expect(trig.result).toEqual({ triggered: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.conversation.delivered.some((d) => d.message === '早上好')).toBe(true);
  });

  it('timer/save：非法条目形状 → rpc error（防脏配置落盘）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const bad = await rpc(ws, 'timer/save', 'r1', { agentId: 'a1', entries: [{ id: 'e1', mode: 'bad-mode', hint: 'x' }] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('mode');
  });

  it('backup/run（真 BackupService，force 直跑；载荷内嵌 backups 列表）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const run = await rpc(ws, 'backup/run', 'r1');
    expect(run.ok).toBe(true);
    const result = run.result as { backup: { skipped?: boolean; file?: string; backups?: unknown[] } };
    expect(result.backup.skipped).not.toBe(true);
    expect((result.backup.backups ?? []).length).toBeGreaterThan(0);
  });
});

describe('ac-web-api M17-A config / llm / plugin / system 面', () => {
  it('config/set 池 api_key 侧信道：真实值提取进凭据库、config 剥离、get 回填掩码', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 掩码值：不触凭据库、不落 config（保持不变语义）
    await rpc(ws, 'config/set', 'r1', { key: 'llmProviders', value: { openai: { api_key: '••••••••', base_url: 'https://x' } } });
    let get = await rpc(ws, 'config/get', 'r2');
    let openai = (((get.result as { config: Record<string, unknown> }).config.llmProviders as Record<string, Record<string, unknown>>).openai);
    expect(openai.base_url).toBe('https://x');
    expect(openai.api_key).toBe(''); // 未设置 → 空串掩码回填（config/get 回填）
    expect(h.ctx.credentials.getGlobal('pool:openai')).toBe('');

    // 真实值：提取进凭据库，config.json 不落 key，get 回填掩码
    await rpc(ws, 'config/set', 'r3', { key: 'llmProviders', value: { openai: { api_key: 'sk-real', base_url: 'https://x' } } });
    get = await rpc(ws, 'config/get', 'r4');
    openai = ((get.result as { config: Record<string, unknown> }).config.llmProviders as Record<string, Record<string, unknown>>).openai;
    expect(openai.api_key).toBe('••••••••'); // 已设置 → 掩码
    expect(h.ctx.credentials.getGlobal('pool:openai')).toBe('sk-real');
    // 盘上 config 无 key（凭据侧信道，永不落 config.json）
    const onDisk = JSON.parse(readFileSync(join(h.root, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(((onDisk.llmProviders as Record<string, Record<string, unknown>>).openai).api_key).toBeUndefined();

    // 空串 = 删除凭据
    await rpc(ws, 'config/set', 'r5', { key: 'llmProviders', value: { openai: { api_key: '', base_url: 'https://x' } } });
    expect(h.ctx.credentials.getGlobal('pool:openai')).toBe('');
    get = await rpc(ws, 'config/get', 'r6');
    openai = ((get.result as { config: Record<string, unknown> }).config.llmProviders as Record<string, Record<string, unknown>>).openai;
    expect(openai.api_key).toBe('');
  });

  it('config/save 池 api_key 侧信道：提取/掩码不动/删除三态 + searchpool 前缀', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 新值（save 路径）
    await rpc(ws, 'config/save', 'r1', { config: { llmProviders: { glm: { api_key: 'sk-g', model: 'glm-5.3' } }, searchProviders: { tavily: { api_key: 'sk-t' } } } });
    expect(h.ctx.credentials.getGlobal('pool:glm')).toBe('sk-g');
    expect(h.ctx.credentials.getGlobal('searchpool:tavily')).toBe('sk-t');
    let get = await rpc(ws, 'config/get', 'r2');
    const cfg = (get.result as { config: Record<string, unknown> }).config;
    expect((cfg.llmProviders as Record<string, Record<string, unknown>>).glm.api_key).toBe('••••••••');
    expect((cfg.searchProviders as Record<string, Record<string, unknown>>).tavily.api_key).toBe('••••••••');

    // 掩码回传 = 保持不变（凭据库未动）
    await rpc(ws, 'config/save', 'r3', { config: { llmProviders: { glm: { api_key: '••••••••', model: 'glm-5.3' } } } });
    expect(h.ctx.credentials.getGlobal('pool:glm')).toBe('sk-g');

    // 空串 = 删除
    await rpc(ws, 'config/save', 'r4', { config: { llmProviders: { glm: { api_key: '', model: 'glm-5.3' } } } });
    expect(h.ctx.credentials.getGlobal('pool:glm')).toBe('');
  });

  it('config/set：白名单外键 fail-closed', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const bad = await rpc(ws, 'config/set', 'r1', { key: 'sessions', value: {} });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('白名单');
    const del = await rpc(ws, 'config/delete', 'r2', { key: 'sessions' });
    expect(del.ok).toBe(false);
  });

  it('config/delete：删键生效', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    await rpc(ws, 'config/set', 'r1', { key: 'tool.web_search', value: { provider: 'tavily' } });
    await rpc(ws, 'config/delete', 'r2', { key: 'tool.web_search' });
    const get = await rpc(ws, 'config/get', 'r3');
    expect((get.result as { config: Record<string, unknown> }).config['tool.web_search']).toBeUndefined();
  });

  it('config/save：白名单域 replace 语义（缺键删除、白名单外键不动）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 白名单外键（app 内部键模拟）先落地
    h.config.set('sessions', { keep: 3 });
    await rpc(ws, 'config/set', 'r1', { key: 'llmProviders', value: { openai: { base_url: 'https://x' } } });
    await rpc(ws, 'config/set', 'r2', { key: 'timer.tasks', value: [{ id: 't1', enabled: true, mode: 'time', time: '09:00', hint: '晨报' }] });

    // 全量保存：llmProviders 替换、timer.tasks 删除、sessions（白名单外）不动
    await rpc(ws, 'config/save', 'r3', { config: { llmProviders: { glm: { base_url: 'https://y' } } } });
    const get = await rpc(ws, 'config/get', 'r4');
    const cfg = (get.result as { config: Record<string, unknown> }).config;
    // config/get 现回填池条目 api_key 掩码（'' = 未设置）——其余字段原样
    expect(cfg.llmProviders).toEqual({ glm: { base_url: 'https://y', api_key: '' } });
    expect(cfg['timer.tasks']).toBeUndefined();
    expect(cfg.sessions).toEqual({ keep: 3 });

    const bad = await rpc(ws, 'config/save', 'r5', { config: 'not-an-object' });
    expect(bad.ok).toBe(false);
  });

  it('llm/providers：注册表名单 + 诊断快照', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.llm.register('mock', () => ({ stream: async function* () {} }), { models: ['mock-1', 'mock-2'] });
    const r = await rpc(ws, 'llm/providers', 'r1');
    const result = r.result as { providers: string[]; stats: Array<{ name: string; models: string[] }> };
    expect(result.providers).toContain('mock');
    expect(result.stats.find((s) => s.name === 'mock')?.models).toEqual(['mock-1', 'mock-2']);
  });

  it('llm/models：/models 代理（pool:<名> 凭据附加）+ 发现缓存回写 config', async () => {    const h = await boot();
    const ws = await connect(h.port);
    // 凭据：全局 pool:mockprov → RPC 应作为 api_key 附加
    h.ctx.credentials.setGlobal('pool:mockprov', 'sk-pool');
    let seenKey: string | undefined = '|unset|';
    h.llm.register(
      'mockprov',
      () => ({
        stream: async function* () {},
        listModels: async (p: { api_key?: string }) => {
          seenKey = p.api_key;
          return ['m-b', 'm-a'];
        },
      }),
      { models: [], baseUrl: 'https://x.example/v1' },
    );
    const r = await rpc(ws, 'llm/models', 'r1', { name: 'mockprov' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ name: 'mockprov', models: ['m-a', 'm-b'], modelMeta: {} });
    expect(seenKey).toBe('sk-pool');
    // 缓存回写：config.llmProviders.mockprov.models（字典序落盘）
    const pool = h.config.get<Record<string, { models?: string[] }>>('llmProviders');
    expect(pool?.mockprov?.models).toEqual(['m-a', 'm-b']);

    // 未知 provider → rpc error（可诊断）
    const bad = await rpc(ws, 'llm/models', 'r2', { name: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('nope');
  });

  it('llm/models 刷新：已有 vision/hidden 标志随同名模型保留（探测结果不因刷新丢失）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.llm.register(
      'mockprov',
      () => ({
        stream: async function* () {},
        listModels: async () => ['m-a', 'm-b', 'm-c'],
      }),
      { models: [] },
    );
    // 既有缓存：m-a 带探测 vision、m-b 带隐藏位
    h.config.set('llmProviders', {
      mockprov: { base_url: 'https://x.example/v1', models: [{ model: 'm-a', vision: true }, { model: 'm-b', hidden: true }, 'm-z'] },
    });
    const r = await rpc(ws, 'llm/models', 'r1', { name: 'mockprov', refresh: true });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({
      models: ['m-a', 'm-b', 'm-c'],
      modelMeta: { 'm-a': { vision: true }, 'm-b': { hidden: true } },
    });
    // 写回合并：m-a/m-b 标志保留、m-z（已下架）移除、m-c（新增）裸名
    const pool = h.config.get<Record<string, { models?: unknown[] }>>('llmProviders');
    expect(pool?.mockprov?.models).toEqual([{ model: 'm-a', vision: true }, { model: 'm-b', hidden: true }, 'm-c']);
  });

  it('llm/probe-vision：三态判定 + 注册/免注册双路径 + 参数校验', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 全局 fetch 桩：按请求体 model 返回不同状态（v=200, t=400, u=401）
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const status = body.model === 'v-1' ? 200 : body.model === 't-1' ? 400 : 401;
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    try {
      // 免注册路径（base_url + api_key）
      const r1 = await rpc(ws, 'llm/probe-vision', 'r1', {
        base_url: 'https://x.example/v1', api_key: 'sk', models: ['v-1', 't-1', 'u-1'],
      });
      expect(r1.ok).toBe(true);
      expect(r1.result).toEqual({ results: { 'v-1': true, 't-1': false, 'u-1': null } });

      // 注册路径（provider + pool:<名> 凭据附加）
      h.ctx.credentials.setGlobal('pool:mockprov', 'sk-pool');
      let seenKey: string | undefined;
      h.llm.register(
        'mockprov',
        () => ({
          stream: async function* () {},
          probeVision: async (model: string, p: { api_key?: string }) => {
            seenKey = p.api_key;
            return model === 'v-1' ? true : undefined;
          },
        }),
        { models: [] },
      );
      const r2 = await rpc(ws, 'llm/probe-vision', 'r2', { provider: 'mockprov', models: ['v-1', 't-1'] });
      expect(r2.ok).toBe(true);
      expect(r2.result).toEqual({ results: { 'v-1': true, 't-1': null } });
      expect(seenKey).toBe('sk-pool');

      // 参数校验：缺 models / 双路径皆缺 / 非 http(s)
      const bad1 = await rpc(ws, 'llm/probe-vision', 'r3', { base_url: 'https://x/v1' });
      expect(bad1.ok).toBe(false);
      expect(bad1.error).toContain('models');
      const bad2 = await rpc(ws, 'llm/probe-vision', 'r4', { models: ['m'] });
      expect(bad2.ok).toBe(false);
      const bad3 = await rpc(ws, 'llm/probe-vision', 'r5', { base_url: 'ftp://x', models: ['m'] });
      expect(bad3.ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('llm/probe-models：免注册探测（base_url+api_key 直调 /models，不写缓存）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 全局 fetch 桩：探测走临时 OpenAICompletions（无注册依赖）
    const captured: { url?: unknown; init?: any } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const r = await rpc(ws, 'llm/probe-models', 'r1', { base_url: 'https://x.example/v1', api_key: 'sk-probe' });
      expect(r.ok).toBe(true);
      expect(r.result).toEqual({ models: ['m-a', 'm-b'] }); // 归一：字典序
      expect(captured.url).toBe('https://x.example/v1/models');
      expect(captured.init.headers.authorization).toBe('Bearer sk-probe');
      // 不写缓存：config 池键未被触碰
      expect(h.config.get<Record<string, unknown>>('llmProviders')).toBeUndefined();
      // 非 http(s) → 拒绝
      const bad = await rpc(ws, 'llm/probe-models', 'r2', { base_url: 'ftp://x', api_key: 'k' });
      expect(bad.ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('llm/pool-credential：写/删连接凭据（pool:<名>；空串=删）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const set = await rpc(ws, 'llm/pool-credential', 'r1', { name: 'myds', value: 'sk-1' });
    expect(set.result).toEqual({ set: true, name: 'myds' });
    expect(h.ctx.credentials.getGlobal('pool:myds')).toBe('sk-1');
    const del = await rpc(ws, 'llm/pool-credential', 'r2', { name: 'myds', value: '' });
    expect(del.ok).toBe(true);
    expect(h.ctx.credentials.getGlobal('pool:myds')).toBe('');
    // 不安全名 → 拒绝
    const bad = await rpc(ws, 'llm/pool-credential', 'r3', { name: 'a/b', value: 'x' });
    expect(bad.ok).toBe(false);
  });

  it('plugin/stage + staging-list + staging-files + reject（真 PluginRegistryService）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 极简插件目录（manifest + 入口；stage 只做文件域暂存不装载）
    const dir = join(h.root, 'fake-plugin');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'fake-plugin', version: '1.0.0', entry: 'index.ts' }));
    writeFileSync(join(dir, 'index.ts'), "export const name = 'fake-plugin';\nexport function apply() {}\n");

    const stage = await rpc(ws, 'plugin/stage', 'r1', { dir });
    expect(stage.ok).toBe(true);
    const id = (stage.result as { staging: { id: string } }).staging.id;
    expect(id).toBeTruthy();

    const list = await rpc(ws, 'plugin/staging-list', 'r2');
    expect((list.result as { staging: Array<{ id: string }> }).staging.map((s) => s.id)).toContain(id);

    const files = await rpc(ws, 'plugin/staging-files', 'r3', { id });
    expect((files.result as { files: Array<{ path?: string; rel?: string }> }).files.length).toBeGreaterThan(0);

    const rejected = await rpc(ws, 'plugin/reject', 'r4', { id });
    expect(rejected.ok).toBe(true);
    const list2 = await rpc(ws, 'plugin/staging-list', 'r5');
    expect((list2.result as { staging: unknown[] }).staging).toEqual([]);
  });

  it('plugin/permissions：词汇表形状', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'plugin/permissions', 'r1');
    const result = r.result as Record<string, unknown>;
    expect(result.contractsVersion).toBe('1.0.0');
    expect(result.permissions).toEqual(['fs', 'network', 'process', 'shell', 'ui']);
    expect(result.defaultGrants).toEqual(['fs', 'network']);
  });

  it('plugin/rows：cordis 装配行清单（M18——扩展面板的内置能力数据源；2026-08-28 附包元数据）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'plugin/rows', 'r1');
    const rows = (r.result as {
      rows: Array<{ name: string; fibers: number; active: boolean; origin: 'package' | 'internal'; description?: string; version?: string }>;
    }).rows;
    // 本测试经 ctx.plugin 装载的行须在册（直构 Service 不经 registry）
    const names = rows.map((x) => x.name);
    expect(names).toContain('ac-web-api');
    expect(rows.every((x) => x.name && x.active === true && x.fibers >= 1)).toBe(true);
    // 按名排序
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
    // 2026-08-28 反馈 #2：package 行带 package.json 的 description/version（前端
    // 扩展面板数据源——不再是全量无描述）；解析不到包的行标 internal
    const webApi = rows.find((x) => x.name === 'ac-web-api')!;
    expect(webApi.origin).toBe('package');
    expect(webApi.description).toBeTruthy();
    expect(webApi.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const x of rows) {
      if (x.origin === 'internal') {
        expect(x.description).toBeUndefined(); // 内部行不硬造描述
      } else {
        expect(x.description).toBeTruthy(); // package 行必带包描述
      }
    }
  });

  it('plugin/rows origin:dynamic（M23 F11：判据 = registry.json 安装态 ∪ listLoaded 会话态；同名动态优先于包元数据）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 进程内挂一个动态行（fiber 名 = 插件名）+ 捏造安装态记录（判据面 ①）
    const fiber = h.ctx.plugin({
      name: 'agent-made-tool',
      apply() { /* 任意贡献 */ },
    } as never, {} as never);
    await fiber;
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(h.root, 'plugins'), { recursive: true });
    writeFileSync(
      join(h.root, 'plugins', 'registry.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'agent-made-tool': {
            manifest: { name: 'agent-made-tool', version: '1.0.0', entry: 'index.ts' },
            dir: 'agent-made-tool',
            owner: 'helper',
            permissions: ['fs'],
            hash: 'x',
            installedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const r = await rpc(ws, 'plugin/rows', 'r1');
    const rows = (r.result as {
      rows: Array<{ name: string; origin: string; owner?: string }>;
    }).rows;
    const dyn = rows.find((x) => x.name === 'agent-made-tool');
    expect(dyn?.origin).toBe('dynamic');
    expect(dyn?.owner).toBe('helper'); // owner 徽章数据源（安装态 owner）
    await fiber.dispose();
  });

  it('plugin/extension-catalog：静态目录 ∩ registry（行装载 → 条目可见；M22 D4）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 基线：harness 直构服务不经 registry——目录条目仅 harness 实际装载的
    // 行可见（2026-08-30 C6 目录扩容后 ac-timer 有条目且本 harness 装载
    // 了 timersRow → ['timers']；其余条目行未装载 → 不可见）
    const base = await rpc(ws, 'plugin/extension-catalog', 'r1');
    expect((base.result as { extensions: Array<{ name: string }> }).extensions.map((e) => e.name)).toEqual(['timers']);

    // 装载真实扩展行（ac-datetime：inject ['agents'] 已满足）→ 条目出现
    const datetimeRow = await import('ac-datetime');
    const fiber = h.ctx.plugin(datetimeRow as unknown as { apply(ctx: Context): unknown });
    await fiber;
    const r = await rpc(ws, 'plugin/extension-catalog', 'r2');
    const extensions = (r.result as { extensions: Array<{ name: string; row: string; targets: string[] }> }).extensions;
    expect(extensions.map((e) => e.name)).toEqual(['datetime', 'timers']);
    expect(extensions[0].row).toBe('ac-datetime');
    expect(extensions[0].targets).toEqual(['loop/before-run']);
    await fiber.dispose();
  });

  it('plugin/dev-scan + plugin/loaded.failed（M22 D6/D7：owner 布局扫描 + 数据根透出 + 失败记因）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // dev 布局：<root>/plugins/<agentId>/<name>/manifest.json
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(h.root, 'plugins', 'helper', 'demo-tool'), { recursive: true });
    writeFileSync(
      join(h.root, 'plugins', 'helper', 'demo-tool', 'manifest.json'),
      JSON.stringify({ name: 'demo-tool', version: '0.1.0', entry: 'index.ts', description: '演示' }),
    );

    const scan = await rpc(ws, 'plugin/dev-scan', 'r1');
    const scanR = scan.result as { root: string; dev: Array<{ name: string; owner: string; dir: string }> };
    expect(scanR.root).toBe(h.root);
    expect(scanR.dev).toEqual([
      { name: 'demo-tool', version: '0.1.0', description: '演示', owner: 'helper', dir: join(h.root, 'plugins', 'helper', 'demo-tool') },
    ]);

    // 装载失败（入口缺失）→ plugin/loaded 附 failed[]（内存态运行诊断）
    const bad = await rpc(ws, 'plugin/load', 'r2', { dir: join(h.root, 'plugins', 'helper', 'demo-tool'), sessionOnly: true });
    expect(bad.ok).toBe(true); // 装载管道把 rejected 作为正常 outcome 返回
    const loaded = await rpc(ws, 'plugin/loaded', 'r3');
    const loadedR = loaded.result as { loaded: unknown[]; failed: Array<{ name: string; error: string }>; skipped?: unknown[]; safeMode?: boolean };
    expect(loadedR.loaded).toEqual([]);
    expect(loadedR.failed).toEqual([{ name: 'demo-tool', error: expect.stringContaining('入口不存在') }]);
    // M23 P5：skipped[]（熔断透出）+ safeMode（UI 横幅数据源）恒在
    expect(Array.isArray(loadedR.skipped)).toBe(true);
    expect(loadedR.safeMode).toBe(false);
  });

  // 行偏好 patch-list/patch-set 测试已随 RPC 注册迁往
  // ac-plugin-registry/tests/patch-rpc.test.ts（2026-08-30：急救通道
  // 住在级联闭包外的 plugin-registry 行）

  it('events/listeners（M23 P4）：_settings 有序读出 + prepend 标记 + 归属 fiber 名；动态装载后顺序变化可见', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const chainOf = async (reqId: string) => {
      const r = await rpc(ws, 'events/listeners', reqId);
      const events = (r.result as { events: Array<{ name: string; listeners: Array<{ owner: string; prepend: boolean; global: boolean }> }> }).events;
      return { events, chain: events.find((e) => e.name === 'loop/before-run') };
    };
    // 基线（harness 可能已有业务监听器）
    const base = await chainOf('r0');
    const baseCount = base.chain?.listeners.length ?? 0;

    // 依次挂两个监听器（后挂的在尾）+ 一个 prepend（在首）
    const disposeA = h.ctx.on('loop/before-run', (async () => ({ finish: 'stop' })) as never);
    const disposeB = h.ctx.on('loop/before-run', (async () => ({ finish: 'stop' })) as never);
    const disposeC = h.ctx.on('loop/before-run', (async () => ({ finish: 'stop' })) as never, true);
    const { events, chain } = await chainOf('r1');
    expect(chain).toBeDefined();
    expect(chain!.listeners).toHaveLength(baseCount + 3);
    // 数组序 = waterfall 执行序：prepend 在首
    expect(chain!.listeners[0].prepend).toBe(true);
    // 归属 = 裸 fiber 名（测试根 fiber 匿名 → (anonymous) 如实呈现）
    expect(chain!.listeners.every((l) => typeof l.owner === 'string')).toBe(true);
    // internal/* 不进清单（G2：不承诺全景）
    expect(events.every((e) => !e.name.startsWith('internal/'))).toBe(true);
    // 动态装载后顺序变化：dispose 首个 prepend → 清单长度变化且首位不再是 prepend
    disposeC();
    const after = await chainOf('r2');
    expect(after.chain!.listeners).toHaveLength(baseCount + 2);
    expect(after.chain!.listeners[0].prepend).toBe(false);
    disposeA();
    disposeB();
  });

  it('system/version：读根包版本', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'system/version', 'r1');
    const result = r.result as { current: string; name: string };
    expect(result.current).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof result.name).toBe('string');
  });

  it('workspace/browse-dirs：快捷根 + 目录清单（只列目录，M18 白名单弹窗）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    // 空 path → 快捷根（含数据根）
    const roots = await rpc(ws, 'workspace/browse-dirs', 'r1', {});
    const rootList = (roots.result as { roots?: Array<{ name: string; path: string }> }).roots ?? [];
    expect(rootList.some((x) => x.path === h.root)).toBe(true);
    // 指定 path → 子目录清单（h.root 下建两个目录 + 一个文件）
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(h.root, 'dir-a'));
    mkdirSync(join(h.root, 'dir-b'));
    writeFileSync(join(h.root, 'noise.txt'), 'x');
    const sub = await rpc(ws, 'workspace/browse-dirs', 'r2', { path: h.root });
    const res = sub.result as { path: string; parent?: string; dirs: Array<{ name: string; path: string }> };
    const names = res.dirs.map((d) => d.name);
    expect(names).toContain('dir-a');
    expect(names).toContain('dir-b');
    expect(names).not.toContain('noise.txt'); // 文件不列
    expect(res.dirs.every((d) => !d.name.includes('.'))).toBe(true);
    expect(typeof res.parent).toBe('string');
    // 相对路径 → error 字段（不抛错）
    const bad = await rpc(ws, 'workspace/browse-dirs', 'r3', { path: 'relative/x' });
    expect((bad.result as { error?: string }).error).toContain('绝对路径');
    // files:true → 附带常规文件清单（配置弹窗文件路径选择，如 persona file）
    const withFiles = await rpc(ws, 'workspace/browse-dirs', 'r4', { path: h.root, files: true });
    const fres = withFiles.result as { dirs: Array<{ name: string }>; files?: Array<{ name: string; path: string }> };
    expect(fres.dirs.map((d) => d.name)).toContain('dir-a');
    expect((fres.files ?? []).map((f2) => f2.name)).toContain('noise.txt');
    expect((fres.files ?? []).every((f2) => f2.path.startsWith(h.root))).toBe(true);
  });

  it('system/restart：非 Supervisor 模式 fail-closed（不真重启）', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    const r = await rpc(ws, 'system/restart', 'r1', { reason: '测试' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Supervisor');
  });
});

describe('ac-web-api M17-E 文件与工作区 HTTP 面', () => {
  it('upload + tree/file + workspaces CRUD + avatar 全链（真 WorkspaceService）', async () => {
    const h = await boot();
    const base = `http://127.0.0.1:${h.port}`;

    // multipart 上传（agentId 定向 files/a1/_tmp/）
    const form = new FormData();
    form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'note.txt');
    form.append('agentId', 'a1');
    const up = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    expect(up.status).toBe(200);
    const upJson = (await up.json()) as { path: string; storedName: string };
    expect(upJson.path).toContain('files/a1/_tmp/');
    expect(upJson.storedName).toContain('.txt');

    // 目录树（含 a1 桶）
    const tree = (await (await fetch(`${base}/api/workspace/tree`)).json()) as { children: Array<{ name: string; type: string }> };
    expect(tree.children.some((c) => c.name === 'a1' && c.type === 'dir')).toBe(true);

    // 文件内容（文本直读；files/ 前缀上传形直通——双形态兼容）
    const f = await fetch(`${base}/api/workspace/file?path=${encodeURIComponent(upJson.path)}`);
    const fJson = (await f.json()) as { content: string; base64: boolean };
    expect(fJson.content).toBe('hello world');
    expect(fJson.base64).toBe(false);

    // raw 字节直链（缩略图 <img> 用的端点）：上传返回 path 直通 → 200 + MIME
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const imgForm = new FormData();
    imgForm.append('file', new Blob([pngBytes], { type: 'image/png' }), 'dot.png');
    imgForm.append('agentId', 'a1');
    const imgUp = (await (await fetch(`${base}/api/upload`, { method: 'POST', body: imgForm })).json()) as { path: string };
    const raw = await fetch(`${base}/api/workspace/raw?path=${encodeURIComponent(imgUp.path)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await raw.arrayBuffer()).equals(pngBytes)).toBe(true);
    // 旧双重前缀形态（防御回归）：files/files/... → 404
    const dbl = await fetch(`${base}/api/workspace/raw?path=${encodeURIComponent('files/' + imgUp.path)}`);
    expect(dbl.status).toBe(404);

    // 重复上传同内容 → 内容寻址幂等（同 path、磁盘单文件）
    const dupForm = new FormData();
    dupForm.append('file', new Blob([pngBytes], { type: 'image/png' }), 'again.png');
    dupForm.append('agentId', 'a1');
    const dup = (await (await fetch(`${base}/api/upload`, { method: 'POST', body: dupForm })).json()) as { path: string };
    expect(dup.path).toBe(imgUp.path);
    const tmpDir = join(h.root, 'files', 'a1', '_tmp');
    const pngs = readdirSync(tmpDir).filter((n) => n.endsWith('.png'));
    expect(pngs).toHaveLength(1);

    // 越界路径拒绝（400）
    const bad = await fetch(`${base}/api/workspace/tree?path=${encodeURIComponent('../../etc')}`);
    expect(bad.status).toBe(400);

    // workspaces CRUD
    const w = (await (
      await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: h.root, name: '临时工作区' }),
      })
    ).json()) as { workspace: { id: string; name: string } };
    expect(w.workspace.id).toBeTruthy();
    const wl = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: Array<{ id: string }> };
    expect(wl.workspaces.length).toBe(1);
    const wdel = (await (await fetch(`${base}/api/workspaces/${w.workspace.id}`, { method: 'DELETE' })).json()) as { deleted: boolean };
    expect(wdel.deleted).toBe(true);

    // 头像：上传 → 静态读取 → 删除 → 404
    const avForm = new FormData();
    avForm.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'avatar.png');
    const av = await fetch(`${base}/api/agents/a1/avatar`, { method: 'POST', body: avForm });
    expect(av.status).toBe(200);
    const avGet = await fetch(`${base}/api/agents/a1/avatar`);
    expect(avGet.status).toBe(200);
    expect(avGet.headers.get('content-type')).toContain('image/png');
    const avDel = (await (await fetch(`${base}/api/agents/a1/avatar`, { method: 'DELETE' })).json()) as { deleted: boolean };
    expect(avDel.deleted).toBe(true);
    expect((await fetch(`${base}/api/agents/a1/avatar`)).status).toBe(404);
  });
});

describe('ac-web-api goal/todo 读面（任务追踪 dock 数据源）', () => {
  it('goal/get · todo/get：桶快照与清单返回；桶隔离；参数缺失拒绝', async () => {
    const h = await boot();
    const ws = await connect(h.port);
    h.ctx.goals.create('a1', 'a1~user', '搭好监控面板', '先选型');
    h.ctx.todos.write('a1', 'a1~user', [
      { content: '写实现', status: 'in_progress' },
      { content: '补测试' },
    ]);

    const g = await rpc(ws, 'goal/get', 'g1', { agentId: 'a1', conversationId: 'a1~user' });
    expect(g.ok).toBe(true);
    const goal = (g.result as { goal: { current?: { objective: string; status: string; note?: string } } }).goal;
    expect(goal.current).toMatchObject({ objective: '搭好监控面板', status: 'active', note: '先选型' });

    const t = await rpc(ws, 'todo/get', 't1', { agentId: 'a1', conversationId: 'a1~user' });
    expect(t.ok).toBe(true);
    const todos = (t.result as { todos: Array<{ content: string; status: string }> }).todos;
    expect(todos).toEqual([
      { content: '写实现', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ]);

    // 桶隔离：他桶（自会话）空清单、无目标
    const other = await rpc(ws, 'todo/get', 't2', { agentId: 'a1', conversationId: 'a1~a1' });
    expect((other.result as { todos: unknown[] }).todos).toEqual([]);
    const otherGoal = await rpc(ws, 'goal/get', 'g2', { agentId: 'a1', conversationId: 'a1~a1' });
    expect((otherGoal.result as { goal: { current?: unknown } }).goal.current).toBeUndefined();

    // 参数缺失 → 失败
    const bad = await rpc(ws, 'goal/get', 'g3', { conversationId: 'a1~user' });
    expect(bad.ok).toBe(false);
    const badTodo = await rpc(ws, 'todo/get', 't3', {});
    expect(badTodo.ok).toBe(false);
  });
});
