// ============================================================
// M8.2 conversation 服务面验收：信封入站 → ledger 落账 →
// ConversationMachine 决策 → ctx.agentLoop 全量真身 → settle。
// 编排：真 cordis 树（tools/llm/mock-provider/agent-loop/ledger/
// conversation）× 信封直投——验收 boot 收信面同一链路。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import type { LoopRunCall, LoopRunResult } from 'ac-agent-loop';
import { makeLedgerRow, readLedger, readJournal } from 'ac-ledger';
import * as durableInteractionRow from 'ac-durable-interaction';
import { makeConversationRow, replyTargetOf, type ConversationService } from 'ac-shell-conversation';
import { makeEnvelope, type Envelope } from 'ac-envelope-core';

const ROOT = path.join('preview', 'sandbox', 'test-conv-svc-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock-1', ...extra }), 'utf-8');
}

/** 真树 boot：tools → llm → mock provider → loop → ledger → conversation。
 *  chatModels（可选）= 捕获 provider 实收的 model（cr-565 覆盖生效断言面）；
 *  gate（可选）= 慢 mock 闸门（首流挂起直到放行——busy 窗口用，cr-575）。 */
async function bootTree(agentId: string, chatModels?: string[], gate?: Promise<void>, providerError?: Error, chatTools?: string[][], chatMessages?: Array<Array<{ role: string; content: string }>>): Promise<{ ctx: Context; fibers: Fiber[]; conv: ConversationService }> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<unknown> = [toolsRow, llmRow, loopRow];
  for (const row of rows) {
    const fiber = ctx.plugin(row as never, undefined as never);
    fibers.push(fiber);
  }
  const mockFiber = ctx.plugin({
    name: 'mock-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register('mock', () => ({
        stream: async function* (input: { model?: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function?: { name?: string } }> }) {
          if (gate !== undefined) await gate;
          if (providerError !== undefined) throw providerError;
          chatModels?.push(input.model ?? '');
          chatTools?.push((input.tools ?? []).map((t) => t.function?.name ?? ''));
          chatMessages?.push(input.messages.map((m) => ({ role: m.role, content: m.content })));
          const last = input.messages.filter((m) => m.role === 'user').at(-1);
          yield { delta: '[回复 ' + (last?.content ?? '') + ']' };
          yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
        },
      }), { models: ['mock-1'] });
    },
  });
  fibers.push(mockFiber);
  const ledgerFiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId }));
  fibers.push(ledgerFiber);
  // durable-interaction 行（cr-636 恢复面测试——壳行集第四批同款零改动导入；
  // apply(ctx, options) 惯例——options 第二参直达行 options）
  const diFiber = ctx.plugin(durableInteractionRow as never, { root: path.join(ROOT, 'agents', agentId) } as never);
  fibers.push(diFiber);
  const convFiber = ctx.plugin(makeConversationRow({
    dataRoot: ROOT, agentId,
    // cr-590：行 id → 工具名展开词汇（boot 装配期目录投影——测试注入样例）
    rowTools: { 'fs-tools': ['read', 'write', 'edit'], 'shell-tools': ['pwsh'] },
  }));
  fibers.push(convFiber);
  for (const fiber of fibers) await fiber;
  // 键 'conversation' 类型被主线行占用——软取后经 unknown 断言到 preview 实现
  return { ctx, fibers, conv: ctx.get('conversation', false) as unknown as ConversationService };
}

async function dispose(fibers: Fiber[]): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
}

function msg(uuid: string, requestId: string, text: string, sender = 'user'): Envelope {
  return makeEnvelope({ uuid, requestId, sender, to: 'alpha', payload: { text } });
}

const UUID = 'u-conv-1';

describe('M8.2 conversation 服务面（信封 → 全量 loop → settle）', () => {
  it('user 直发多轮：每轮 run 真身收束 + 终稿入账 + 历史延续', async () => {
    seedAgent('alpha');
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      const s1 = await conv.receiveEnvelope(msg(UUID, 'r1', '第一问'), { fresh: true });
      expect(s1).toBe('settled');
      const s2 = await conv.receiveEnvelope(msg(UUID, 'r2', '第二问'), { fresh: true });
      expect(s2).toBe('settled');
      // 账本：header + 4 行（2 入站 + 2 终稿），终稿 mock 回声
      const { header, rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(header?.participants).toEqual(['alpha', 'user']);
      expect(rows.map((r) => r.content)).toEqual(['第一问', '[回复 第一问]', '第二问', '[回复 第二问]']);
      expect(rows[1]).toMatchObject({ agent_id: 'alpha', run: 'run-r1' });
      // journal：步记录在（settlement 台账）
      // 第二轮历史延续：mock 回声带最后一问 → 隐含多轮上下文装配
      void ctx;
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-639：当前消息重复投喂回归锁——deliverRow 已落 user 行，historyFor
  // 复读即含当前消息；再 append 同文本会让模型每轮收到双份当前消息
  //（01a16af1 活体 probe 实锤「probe4 出现两次」）。
  it('上下文单源 = 账本：当前消息在模型输入中恰好一份', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    try {
      await conv.receiveEnvelope(msg(UUID, 'dup-1', '第一问'), { fresh: true });
      await conv.receiveEnvelope(msg(UUID, 'dup-2', '第二问'), { fresh: true });
      expect(chatMessages.length).toBe(2);
      // 每轮：当前消息恰好一份
      expect(chatMessages[0].filter((m) => m.role === 'user' && m.content === '第一问')).toHaveLength(1);
      expect(chatMessages[1].filter((m) => m.role === 'user' && m.content === '第二问')).toHaveLength(1);
      // 第二轮完整历史 = 第一问 + 终稿 + 第二问（3 行，无重复）
      expect(chatMessages[1].map((m) => m.content)).toEqual(['第一问', '[回复 第一问]', '第二问']);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-565：模型菜单选择 → deliver 合并点 → 信封 model → 本壳 run 装配。
  // 配置模型故意指向未注册模型：不覆盖时 provider 链不达，覆盖后必须走通。
  it('信封 model 覆盖生效：name@model 拆 provider/model，裸名不带 provider', async () => {
    seedAgent('alpha', { model: 'cfg-model-not-registered' });
    const chatModels: string[] = [];
    const { fibers, conv } = await bootTree('alpha', chatModels);
    try {
      // ① 无覆盖：配置模型无注册 provider → provider 从未被调用
      await conv.receiveEnvelope(msg(UUID, 'r-cfg', '无覆盖一问'), { fresh: true }).catch(() => 'failed');
      expect(chatModels).toEqual([]);
      // ② 'mock@mock-1' 覆盖：provider = mock，模型名 = 右段
      const overridden = makeEnvelope({
        uuid: UUID, requestId: 'r-ov', sender: 'user', to: 'alpha',
        payload: { text: '带覆盖一问' }, model: 'mock@mock-1',
      });
      expect(await conv.receiveEnvelope(overridden, { fresh: true })).toBe('settled');
      expect(chatModels).toEqual(['mock-1']);
      // ③ 裸模型名覆盖：不带 provider（llm 注册面按模型名路由）
      const bare = makeEnvelope({
        uuid: UUID, requestId: 'r-bare', sender: 'user', to: 'alpha',
        payload: { text: '裸名一问' }, model: 'mock-1',
      });
      expect(await conv.receiveEnvelope(bare, { fresh: true })).toBe('settled');
      expect(chatModels).toEqual(['mock-1', 'mock-1']);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('同 requestId 重发 = deduped（幂等短路不重复落账不重跑）', async () => {
    seedAgent('alpha');
    const { fibers, conv } = await bootTree('alpha');
    try {
      await conv.receiveEnvelope(msg(UUID, 'r1', '问'), { fresh: true });
      const dup = await conv.receiveEnvelope(msg(UUID, 'r1', '问（重发）'), { fresh: false });
      expect(dup).toBe('deduped');
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows).toHaveLength(2); // 重发未增行
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('receipt kind = ledger-only（不激活 run，A4）', async () => {
    seedAgent('alpha');
    const { fibers, conv } = await bootTree('alpha');
    try {
      const receipt = makeEnvelope({
        uuid: UUID, requestId: 'rc-1', sender: 'host', to: 'alpha',
        kind: 'receipt', payload: { ok: true },
      });
      const out = await conv.receiveEnvelope(receipt, { fresh: true });
      expect(out).toBe('ledger-only');
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows).toHaveLength(1); // 落账一行，无终稿
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('deliver 方言叶（collab-tools 消费面）：outcome run 形状 + isBusy', async () => {
    seedAgent('alpha');
    const { fibers, conv } = await bootTree('alpha');
    try {
      expect(conv.isBusy()).toBe(false);
      const outcome = await conv.deliver('alpha', '你好', { sender: 'beta', source: 'agent' });
      expect(outcome.kind).toBe('run');
      if (outcome.kind === 'run') expect(outcome.result.text).toBe('[回复 你好]');
      expect(conv.isBusy()).toBe(false);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('busy 收口不变式（cr-549）：config 缺席 throw 不泄漏 busy——门清 + 异常如实上抛', async () => {
    // plan 占门后 config 重读 throw：busy 必须随异常路径清理（finally 收口），
    // 否则 idle 探针恒忙 + reviewRun 自旋永挂。验收：receiveEnvelope rejects +
    // isBusy() 回 false。
    const { fibers, conv } = await bootTree('ghost'); // ghost 无 config.json
    try {
      await expect(conv.receiveEnvelope(msg('u-ghost', 'g1', '问'), { fresh: true }))
        .rejects.toThrow('agent 配置缺席：ghost');
      expect(conv.isBusy()).toBe(false); // 门已清——无泄漏
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('busy 时入站 = steer 注入活跃 run（串行化门 + 主线 loop steer）', async () => {
    seedAgent('alpha');
    const { fibers, conv } = await bootTree('alpha');
    try {
      // 第一轮挂起（慢 mock——流不结束则 run 不收束）：用未决 promise 占住 machine
      // 直接验证 machine 语义面：busy 时第二封信封 = steer
      const first = conv.receiveEnvelope(msg(UUID, 's1', '慢问题'), { fresh: true });
      // 同 tick 内投第二封（run 未收束——busy）
      const second = conv.receiveEnvelope(msg(UUID, 's2', '插话'), { fresh: true });
      await Promise.all([first, second]);
      // 两封都处理完（第二封 busy 时段注入或排队——无死锁无丢信）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-575 队列产品面：busy + lane next-turn → 排队（QueueDock 数据面）；
  // queue 快照 / steerQueued 注入（journal-inject 落账）/ removeQueued 删除
  // cr-579：queue-changed 权威快照事件（入队/steer 出队/删除各发射点）
  it('队列产品面：busy + next-turn 入队 → 快照 → steer 注入 / 删除 → 放行收束', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const queueEvents: Array<[string, string, Array<{ id: string }>]> = [];
    ctx.on('conversation/queue-changed', (agentId, conversationId, handle, items) => {
      queueEvents.push([conversationId, handle, items]);
    });
    try {
      const first = conv.receiveEnvelope(msg(UUID, 'q1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80)); // 占门 + runStarted 补登
      expect(conv.isBusy()).toBe(true);
      // busy + next-turn → 排队（不驱动 run）
      const queuedIn = makeEnvelope({ uuid: UUID, requestId: 'q2', sender: 'user', to: 'alpha', payload: { text: '排队消息A', lane: 'next-turn' } });
      expect(await conv.receiveEnvelope(queuedIn, { fresh: true })).toBe('queued');
      // cr-579：入队点发射权威快照（主线四参序——handle = uuid~agent）
      expect(queueEvents.at(-1)).toEqual([UUID, UUID + '~alpha', [{ id: 'q2', preview: '排队消息A', sender: 'user', source: 'user', queuedAt: expect.any(Number) }]]);
      const items = conv.queue(UUID);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: 'q2', preview: '排队消息A', sender: 'user', source: 'user', conversationId: UUID });
      // steer：注入活跃 run → steered（journal-inject 落账 + 队列清空）
      await expect(conv.steerQueued('q2')).resolves.toBe('steered');
      expect(conv.queue(UUID)).toHaveLength(0);
      // cr-579：steer 出队点发射（空队列快照）
      expect(queueEvents.at(-1)).toEqual([UUID, UUID + '~alpha', []]);
      // 再排一条验证删除（含 not-found / 重复删 false）
      const queuedIn2 = makeEnvelope({ uuid: UUID, requestId: 'q3', sender: 'user', to: 'alpha', payload: { text: '排队消息B', lane: 'next-turn' } });
      await conv.receiveEnvelope(queuedIn2, { fresh: true });
      expect(conv.removeQueued('q3')).toBe(true);
      expect(queueEvents.at(-1)![2]).toEqual([]); // 删除点发射（空快照）
      expect(conv.removeQueued('q3')).toBe(false);
      await expect(conv.steerQueued('ghost')).resolves.toBe('not-found');
      // 放行：首 run 收束，队列已空 → 空闲
      release();
      await first;
      expect(conv.isBusy()).toBe(false);
      // 账本：入站两行（慢问题 + 排队消息A）+ 终稿一行；steer 注入归 journal
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows.filter((r) => r.requestId === 'q2')).toHaveLength(1);
      const journal = readJournal(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(journal).toContainEqual(expect.objectContaining({ type: 'journal-inject', run: 'run-q1', content: '排队消息A' }));
    } finally {
      release();
      await dispose(fibers);
    }
  }, 15_000);

  // cr-591（run-error 泛化）：每用户 run 收束 → conversation/run-settled
  // 事件（boot 旁带发射的数据源——前端收束三件套唯一驱动）；reviewRun 机制 run 不发。
  it('run 收束发 conversation/run-settled（失败带 message；reviewRun 不发）', async () => {
    seedAgent('alpha');
    const events: Array<{ conversationId: string; runId: string; finish: string; text: string; message?: string; sender: string; source: string }> = [];
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, undefined, new Error('连接超时'));
    try {
      ctx.on('conversation/run-settled', (p) => events.push(p));
      const out = await conv.receiveEnvelope(msg(UUID, 'f1', '必败一问'), { fresh: true });
      expect(out).toBe('settled'); // run 收束（finish=error）——失败如实入账
      expect(events).toEqual([{
        conversationId: UUID,
        runId: 'run-f1',
        finish: 'error',
        text: '',
        message: expect.stringContaining('连接超时'),
        sender: 'user',
        source: 'user',
      }]);
      // 机制 run（reviewRun）：同样失败但不发——机制 run 不面向用户
      const before = events.length;
      const review = await conv.reviewRun(UUID, '整理提示', { runId: 'review-1' });
      expect(review.finish).toBe('error');
      expect(events.length).toBe(before);
      // 终稿行如实落账（空文本 + finish error——账本仍是权威收束记录）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows.at(-1)).toMatchObject({ requestId: 'reply-f1', run: 'run-f1' });
    } finally {
      await dispose(fibers);
    }

    // 成功收束同发（干净树）：text = 终稿——前端终稿入列面
    const okEvents: Array<{ finish: string; text: string; message?: string }> = [];
    const ok = await bootTree('alpha');
    try {
      ok.ctx.on('conversation/run-settled', (p) => okEvents.push(p));
      await ok.conv.receiveEnvelope(msg(UUID, 'f2', '成功一问'), { fresh: true });
      const settled = okEvents.find((e) => e.finish === 'ok');
      expect(settled).toMatchObject({ text: '[回复 成功一问]' });
      expect('message' in settled!).toBe(false); // 成功收束无失败文案
    } finally {
      await dispose(ok.fibers);
    }
  }, 30_000);
});

describe('agent-admin 预览面（cr-552 跨进程 dry-run 壳内半边）', () => {
  it('previewSystemPrompt：装配链真实生效（persona 注入 system）+ 干跑无副作用', async () => {
    seedAgent('alpha', { system: '基底' });
    const { fibers, conv } = await bootTree('alpha');
    try {
      // 无组装器时 = config.system 原样直过（装配链空转 = 载体不变）
      const system = await conv.previewSystemPrompt();
      expect(system).toBe('基底'); // 无组装器时 = config.system 原样
      // 干跑无副作用：不落账、不占门、无 run
      expect(conv.isBusy()).toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'agents', 'alpha', 'sessions'))).toBe(false);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('previewSystemPrompt：装配链真实生效（before-run 组装器变异载体）', async () => {
    seedAgent('alpha', { system: '基底' });
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      // 主线 persona 行同构的组装器插件：waterfall 事件经 on('loop/before-run') 订阅
      const asmFiber = ctx.plugin({
        name: 'test-assembler',
        apply(c: Context) {
          c.on('loop/before-run', (call: LoopRunCall, next: () => Promise<LoopRunResult>) => {
            call.request.system = (call.request.system ?? '') + '\n[persona 块]';
            return next();
          });
        },
      } as never, undefined as never);
      fibers.push(asmFiber);
      await asmFiber;
      const system = await conv.previewSystemPrompt();
      expect(system).toBe('基底\n[persona 块]');
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('assemblyToolsView：注册目录 + 行集投影生效集', async () => {
    seedAgent('alpha', { tools: { include: ['math'] } });
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      // 注册一个工具定义（目录数据源——工具行只提供注册面）
      ctx.tools.register({
        name: 'math',
        description: '计算',
        parameters: { type: 'object', properties: { expression: { type: 'string' } } },
        async execute() { return { ok: true }; },
      });
      const view = conv.assemblyToolsView();
      expect(view.enabled).toEqual(['math']);
      expect(view.tools.map((t) => t.name)).toContain('math');
    } finally {
      await dispose(fibers);
    }
  }, 15_000);
});

describe('工具面（cr-582：tools/list 目录 owner + agents/tool-defs 估算面）', () => {
  /** 注册两个工具（常规面 read + mode 面 run_code）+ 可选 convSettings 桩 */
  async function seedTools(ctx: Context, fibers: Fiber[], convSettings?: new (c: Context) => object): Promise<void> {
    const toolFiber = ctx.plugin({
      name: 'test-tool-row',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({ name: 'read', description: '读文件', parameters: { type: 'object' }, async execute() { return { ok: true }; } });
        c.tools.register({ name: 'run_code', description: '跑代码', parameters: { type: 'object' }, injection: 'mode', async execute() { return { ok: true }; } });
      },
    } as never, undefined as never);
    fibers.push(toolFiber);
    await toolFiber;
    if (convSettings !== undefined) {
      const csFiber = ctx.plugin(convSettings as never, undefined as never);
      fibers.push(csFiber);
      await csFiber;
    }
  }

  it('toolsCatalog：owner = 注册方行名（UI 按来源行分组锚点）；toolDefs 缺省 = 常规面（mode 工具不入）', async () => {
    seedAgent('alpha');
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      await seedTools(ctx, fibers);
      expect(conv.toolsCatalog().map((t) => ({ name: t.name, owner: t.owner }))).toEqual([
        { name: 'read', owner: 'test-tool-row' },
        { name: 'run_code', owner: 'test-tool-row' },
      ]);
      expect(conv.toolDefs()).toEqual({
        names: ['read'],
        defs: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
      });
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('toolDefs 模式收窄：tc-programmatic 合成 mode 面；会话覆盖 tc-none 压空（估算与主线同口径）', async () => {
    seedAgent('beta', { tags: ['tc-programmatic'] });
    const { ctx, fibers, conv } = await bootTree('beta');
    try {
      // 会话覆盖桩：c9 → tc-none（主线 convSettings.get 同形）
      await seedTools(ctx, fibers, class extends Service {
        constructor(c: Context) { super(c, 'convSettings'); }
        get(id: string): { toolMode?: 'tc-none' } { return id === 'c9' ? { toolMode: 'tc-none' } : {}; }
      });
      // tc-programmatic（agent tags）→ mode 工具集合成（不经常规面过滤）
      expect(conv.toolDefs('other').names).toEqual(['run_code']);
      // 会话覆盖优先：tc-none → 空面
      expect(conv.toolDefs('c9').names).toEqual([]);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-590：config.tools 词形 = 行 id（cutover/模板/补迁单源）——toolFaceOf
  // 经 rowTools 投影展开为工具名；未展开词形（工具名直用）原样透传。
  it('行 id 展开：tools=[fs-tools] → 面=[read]（∩注册面）；assemblyToolsView.enabled 同源', async () => {
    seedAgent('gamma', { tools: ['fs-tools', 'math'] });
    const { ctx, fibers, conv } = await bootTree('gamma');
    try {
      await seedTools(ctx, fibers);
      // 'fs-tools' 展开 read/write/edit，'math' 词形原样（未注册 → toolDefs visible ∩ 剔除；
      // enabled = 意图清单——工具名词形透传合法）
      expect(conv.toolDefs().names).toEqual(['read']);
      expect(conv.assemblyToolsView().enabled).toEqual(['read', 'write', 'edit', 'math']);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-593：run 面与估算面同口径（此前 driveRun 不收窄——tc-programmatic 会话
  // 估算报 mode 集而真 run 拿全量面，Agent 自省「生效集 1 个工具」的根源）。
  it('run 面模式收窄：真实 run 的 LLM tools 与 toolDefs 同口径（tc-programmatic → mode 集）', async () => {
    seedAgent('prog', { tags: ['tc-programmatic'], tools: ['fs-tools'] });
    const chatTools: string[][] = [];
    const { ctx, fibers, conv } = await bootTree('prog', undefined, undefined, undefined, chatTools);
    try {
      await seedTools(ctx, fibers);
      expect(await conv.receiveEnvelope(msg('u-prog', 'rq1', '问'), { fresh: true })).toBe('settled');
      // 真实 run：LLM 面 = mode 工具集（run_code）——非全量/非白名单常规面
      expect(chatTools[0]).toEqual(['run_code']);
      // 估算面同口径
      expect(conv.toolDefs('u-prog').names).toEqual(['run_code']);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('run 面缺省（base 档）：LLM 面 = 展开后 ∩ 可见面（mode 工具不入）', async () => {
    seedAgent('plain', { tools: ['fs-tools', 'run-code'] });
    const chatTools: string[][] = [];
    const { ctx, fibers, conv } = await bootTree('plain', undefined, undefined, undefined, chatTools);
    try {
      await seedTools(ctx, fibers);
      expect(await conv.receiveEnvelope(msg('u-plain', 'rq2', '问'), { fresh: true })).toBe('settled');
      // 白名单展开（fs-tools → read/write/edit）∩ 注册面（seed 只注册 read）
      expect(chatTools[0]).toEqual(['read']);
      expect(conv.toolDefs('u-plain').names).toEqual(['read']);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-627：busy 期跨会话投递（steer 寻址不匹配落空）→ 转投队列 →
  // 当前 run 收束点链跑消费（按随行会话键取信，run 随信会话走）。
  it('steer 落空（活跃 run 属其他会话）→ 转投队列 + 收束链跑跨会话消费', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    try {
      // 会话 A 的慢 run 占门（首流挂起）
      const first = conv.receiveEnvelope(msg('conv-a', 'a1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(conv.isBusy()).toBe(true);
      // 会话 B 的 next-step 消息（late-reply / 机制唤醒常态形态）：
      // busy → plan=steer；steer 按 runAddress 寻址（conv-b~alpha ≠ 活跃
      // conv-a~alpha）→ 落空。此前只 return——消息静默丢失（run 永不拉起）。
      const cross = await conv.receiveEnvelope(msg('conv-b', 'b1', '跨会话信'), { fresh: true });
      expect(cross).toBe('queued'); // 转投队列（不再静默丢）
      expect(conv.queue('conv-b')).toHaveLength(1);
      // 放行：会话 A 收束 → 链跑按随行会话键消费 conv-b 的信
      release();
      await first;
      // 链跑的 conv-b run 是异步续跑——等它收束入账
      for (let i = 0; i < 100 && conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(conv.isBusy()).toBe(false);
      // conv-b 账本：入站行 + 终稿行（run 真的跑过——跨会话链跑闭环）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-b'));
      expect(rows.map((x) => x.content)).toEqual(['跨会话信', '[回复 跨会话信]']);
      expect(rows[1]).toMatchObject({ agent_id: 'alpha', run: 'run-b1' });
    } finally {
      release();
      await dispose(fibers);
    }
  }, 20_000);

// —— cr-629 安全重启面 + boot 恢复面 ——
describe('安全重启（restart_shell 面）与 boot 恢复面', () => {
  // cr-658 自然收束语义：不中断、不回队——run 恰好消费一次，重启通知
  // 携会话键（新壳 marker 注入「已重启」续跑轮的依据）。
  it('requestRestart：busy → 只挂起不中断 → run 自然收束 → restart-ready 携会话键 + 无回队', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const events: Array<string | undefined> = [];
    ctx.on('conversation/restart-ready', (p: { conversationId?: string }) => { events.push(p.conversationId); });
    try {
      const first = conv.receiveEnvelope(msg('conv-r', 'rr1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(conv.isBusy()).toBe(true);
      expect(conv.requestRestart()).toBe(true); // busy → 挂起（不中断）
      expect(conv.isBusy()).toBe(true); // run 仍在途
      release();
      await first;
      expect(events).toEqual(['conv-r']); // 通知携会话键
      // 不回队：inbox 已清（消息自然消费）、队列空
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-r', 'inbox');
      expect(fs.readdirSync(inboxDir)).toEqual([]);
      expect(conv.queue('conv-r')).toEqual([]);
      expect(conv.isBusy()).toBe(false);
      // 终稿照常入账（run 自然收束，非 interrupted）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-r'));
      expect(rows.map((x) => x.content)).toEqual(['慢问题', '[回复 慢问题]']);
    } finally {
      release();
      await dispose(fibers);
    }
  }, 20_000);

  // cr-650 的回队面已随 cr-658 退役：恢复面 run 内 restart_shell 同样自然
  // 收束——消息被本轮消费，「消费即清」照常清行（无回队信可保留）。
  it('恢复面 run 内 restart_shell：自然收束即消费——inbox 清行照常（cr-650 回队面退役）', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const events: Array<string | undefined> = [];
    ctx.on('conversation/restart-ready', (p: { conversationId?: string }) => { events.push(p.conversationId); });
    try {
      // 跨代 pending 形态：inbox 先有信 → 恢复面（recovered=true）起 run
      const ledger = ctx.get('ledger', false) as unknown as { inboxStore(uuid: string, env: unknown): void };
      ledger.inboxStore('conv-q', makeEnvelope({
        uuid: 'conv-q', requestId: 'qq1', sender: 'user', to: 'alpha', payload: { text: '恢复面问题' },
      }));
      const recovery = conv.recoverPendingInbox();
      for (let i = 0; i < 100 && !conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(conv.isBusy()).toBe(true);
      expect(conv.requestRestart()).toBe(true);
      release();
      await recovery;
      expect(events).toEqual(['conv-q']);
      // 消息已自然消费：清行照常（不再有回队面）
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-q', 'inbox');
      expect(fs.readdirSync(inboxDir)).toEqual([]);
    } finally {
      release();
      await dispose(fibers);
    }
  }, 20_000);

  // cr-639 at-least-once 在途标记：run 起步入 inbox durable、收束即清——
  // 壳被硬杀（无 restart 回队面）时在途信随盘保留，下代恢复面重投续跑
  //（run 7vmy 形态：interrupted/硬死窗口消息整轮蒸发）。
  it('硬死在途信不蒸发：run 起步有标记 → 跨代 recoverPendingInbox 重投续跑', async () => {
    seedAgent('alpha');
    // 第一代：gate 挂住 provider——run 在途时「硬杀」（直接 dispose，不
    // requestRestart、不 settle），模拟外部杀进程/崩溃
    {
      // 永不放行的闸门：run 悬挂在 provider 首流上（硬杀形态的时序等价物）
      const gate = new Promise<void>(() => {});
      const { fibers, conv } = await bootTree('alpha', undefined, gate);
      try {
        void conv.receiveEnvelope(msg('conv-k', 'kk1', '硬死在途信'), { fresh: true }).catch(() => 'killed');
        for (let i = 0; i < 100 && !conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(conv.isBusy()).toBe(true);
      } finally {
        // 闸门不放（硬杀形态）：run 悬挂在 provider 流上，dispose 即进程死
        await dispose(fibers);
      }
      // 盘面：在途标记在（inbox durable）
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-k', 'inbox');
      expect(fs.readdirSync(inboxDir)).toContain('kk1.json');
    }
    // 第二代：恢复面重投 → run 真跑 → 终稿入账 + 标记清
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      const n = await conv2.recoverPendingInbox();
      expect(n).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 100 && conv2.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-k'));
      expect(rows.some((r) => r.agent_id === 'alpha' && r.content === '[回复 硬死在途信]')).toBe(true);
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-k', 'inbox');
      expect(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []).toEqual([]);
    } finally {
      await dispose(f2);
    }
  }, 20_000);

  it('recoverPendingInbox：跨代重投续跑——不重复落账 + run 真跑 + inbox 清空', async () => {
    seedAgent('alpha');
    // 第一代：跑完一轮后直接落一封待消费信（plan=queue 落 inbox durable 的
    // 跨代等价物——省去 gate 时序竞态）
    {
      const { ctx, fibers, conv } = await bootTree('alpha');
      try {
        await conv.receiveEnvelope(msg('conv-p', 'p1', '第一代问题'), { fresh: true });
        const pending = makeEnvelope({ uuid: 'conv-p', requestId: 'p2', sender: 'user', to: 'alpha', payload: { text: '排队信' } });
        const ledger = ctx.get('ledger', false) as unknown as { inboxStore(uuid: string, env: unknown): void };
        ledger.inboxStore('conv-p', pending);
        // 对照封 p3：行已落（首投代 deliverRow 已达的常态形态）——重投须短路
        const settled = makeEnvelope({ uuid: 'conv-p', requestId: 'p3', sender: 'user', to: 'alpha', payload: { text: '已落行的排队信' } });
        await (ctx.get('ledger', false) as unknown as { deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean> }).deliverRow('conv-p', ['alpha', 'user'], 'user', { role: 'agent', content: '已落行的排队信', agent_id: 'user', requestId: 'p3', uuid: 'conv-p' });
        ledger.inboxStore('conv-p', settled);
      } finally {
        await dispose(fibers);
      }
    }
    // 第二代（新服务实例 = 跨重启）：恢复面重投 → run 真跑 + 无重复入站行
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      const n = await conv2.recoverPendingInbox();
      expect(n).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 100 && conv2.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-p'));
      // cr-639 恢复面补行门：行缺席（首投代未落/直投 inbox 形态）→ 补写恰一份
      //（在场则短路——上下文单源 = 账本，run 靠这行拿到当前消息）
      expect(rows.filter((r) => r.content === '排队信')).toHaveLength(1);
      // 对照封：行在场 → 重投短路，不双写
      expect(rows.filter((r) => r.content === '已落行的排队信')).toHaveLength(1);
      // run 真跑：终稿行在场（mock 回声带原信文本）
      expect(rows.some((r) => r.agent_id === 'alpha' && r.content === '[回复 排队信]')).toBe(true);
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-p', 'inbox');
      expect(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []).toEqual([]);
    } finally {
      await dispose(f2);
    }
  }, 20_000);
  // cr-666（leftovers C2）：crash 窗口「只落账未执行」的入站信——无 run 轨迹、
  // 不在队列/收件箱 → reconcileUndelivered 确定性补投；有轨迹/在途则不动。
  it('reconcileUndelivered：末段无 run 轨迹的入站行补投；有终稿/在途不动', async () => {
    seedAgent('alpha');
    // 第一代：一轮正常收束（对照会话 conv-d，末行终稿）+ 一封只落账未执行
    // 的信（conv-e：deliverRow 已达、plan/queue/inbox 未落——crash 窗口等价物）
    {
      const { ctx, fibers, conv } = await bootTree('alpha');
      try {
        await conv.receiveEnvelope(msg('conv-d', 'd1', '正常问题'), { fresh: true });
        const ledger = ctx.get('ledger', false) as unknown as { deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean> };
        await ledger.deliverRow('conv-e', ['alpha', 'user'], 'user', { role: 'agent', content: '对账补投信', agent_id: 'user', requestId: 'e1', uuid: 'conv-e' });
      } finally {
        await dispose(fibers);
      }
    }
    // 第二代：对账 → conv-e 补投起 run；conv-d 末行终稿 → 不动
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      const n = await conv2.reconcileUndelivered();
      expect(n).toBe(1);
      for (let i = 0; i < 100 && conv2.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      const rowsE = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-e')).rows;
      // 补投幂等：入站行不双写 + run 真跑（终稿在场）
      expect(rowsE.filter((r) => r.content === '对账补投信')).toHaveLength(1);
      expect(rowsE.some((r) => r.agent_id === 'alpha' && r.content === '[回复 对账补投信]')).toBe(true);
      // 再跑一次对账：末行已是终稿 → 零补投（收敛不动集）
      expect(await conv2.reconcileUndelivered()).toBe(0);
    } finally {
      await dispose(f2);
    }
  }, 20_000);
  // cr-667（A1）：中断 run 原地续跑——不再从 step 0 重做：前缀（含未提交调用
  // 合成「结果未知」）进模型 messages、同 runId 收束恰一次、resume 标注。
  it('recoverPendingInbox 续跑分支：中断 run 前缀重建 + 同 runId 收束 + context-injected(resume)', async () => {
    seedAgent('alpha');
    // 预置崩溃现场（gen1 等价物）：入站行 + 中断 run 步行（已提交步 + 未提交
    // pwsh 调用步）+ inbox 在途标记，无 settled
    {
      const { Context } = await import('@agentchat/cordis');
      const { makeLedgerRow } = await import('ac-ledger');
      const lctx = new Context();
      const lf = lctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'alpha' }));
      await lf;
      try {
        const ledger = lctx.ledger as unknown as {
          deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean>;
          journalStep(uuid: string, run: string, step: unknown): Promise<void>;
          inboxStore(uuid: string, env: unknown): void;
        };
        await ledger.deliverRow('conv-f', ['alpha', 'user'], 'user', { role: 'agent', content: '原任务', agent_id: 'user', requestId: 'f1', uuid: 'conv-f' });
        await ledger.journalStep('conv-f', 'run-f1', { index: 0, text: '已完成的分析', toolCalls: [], toolResults: [] });
        await ledger.journalStep('conv-f', 'run-f1', { index: 1, text: '建目录', toolCalls: [{ id: 'c9', name: 'pwsh', arguments: '{}' }], toolResults: [] });
        ledger.inboxStore('conv-f', makeEnvelope({ uuid: 'conv-f', requestId: 'f1', sender: 'user', to: 'alpha', payload: { text: '原任务' } }));
      } finally {
        await lf.dispose();
      }
    }
    // 第二代：恢复面 → 续跑分支（provider 输入捕获）
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    const injections: Array<{ source?: string }> = [];
    ctx.on('session/context-injected', (_cid: string, _agent: string | undefined, meta: { source?: string } | undefined) => {
      if (meta !== undefined) injections.push({ source: meta.source });
    });
    try {
      await conv.recoverPendingInbox();
      for (let i = 0; i < 100 && conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(chatMessages).toHaveLength(1);
      const msgs = chatMessages[0]!;
      // 前缀重建：已提交步 + 未提交调用（合成「结果未知」）都进 messages
      expect(msgs.some((m) => m.role === 'assistant' && m.content === '已完成的分析')).toBe(true);
      expect(msgs.some((m) => m.role === 'assistant' && m.content === '建目录')).toBe(true);
      expect(msgs.some((m) => m.role === 'tool' && m.content.includes('未确认'))).toBe(true);
      // 当前消息恰一份（history 复读 + 前缀无双计）
      expect(msgs.filter((m) => m.role === 'user' && m.content === '原任务')).toHaveLength(1);
      // 同 runId 收束恰一次 + resume 标注
      const rows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-f')).rows;
      expect(rows.filter((r) => r.agent_id === 'alpha' && r.run === 'run-f1')).toHaveLength(1);
      const journal = readJournal(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-f'));
      expect(journal.filter((l) => l.type === 'journal-settled' && l.run === 'run-f1')).toHaveLength(1);
      expect(injections.some((i) => i.source === 'resume')).toBe(true);
      const inboxDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-f', 'inbox');
      expect(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []).toEqual([]);
    } finally {
      await dispose(fibers);
    }
  }, 20_000);

  // cr-636：answered ask_questions 交互跨壳重放——作答时发起 run 已死且壳已
  // 代（dur-mvjk1ook 形态：答案落盘正确、无人消费），新壳 boot 恢复面重投。
  it('replayAnsweredInteractions：跨代重放——run 真跑 + close consumed + 幂等', async () => {
    seedAgent('alpha');
    // 第一代：真行树开一个 ask_questions 交互并作答（模拟 run 死后作答——
    // 不走 execute，直接 open+reply 落盘）
    {
      const { fibers } = await bootTree('alpha');
      try {
        const di = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        di.open({
          id: 'dur-test-1', key: 'conv-a', kind: 'ask_questions',
          payload: { questions: [{ question: '选哪条路径？', options: ['A', 'B'] }] },
          owner: 'alpha',
        });
        di.reply('dur-test-1', { answers: ['A'] });
        di.dispose();
      } finally {
        await dispose(fibers);
      }
    }
    // 第二代（新服务实例 = 跨壳换代）：恢复面重放 → 开新 run（mock 回声消费答案）
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      const n = await conv2.replayAnsweredInteractions();
      expect(n).toBe(1);
      for (let i = 0; i < 100 && conv2.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(conv2.isBusy()).toBe(false);
      // run 真跑：答案通知行入账 + mock 终稿行跟随（late-reply 重放闭环）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-a'));
      const noticeRow = rows.find((r) => r.content.includes('dur-test-1'));
      expect(noticeRow).toBeDefined();
      expect(rows.some((r) => r.agent_id === 'alpha' && r.run === 'run-late-reply-dur-test-1')).toBe(true);
      // close consumed：终态收缩，重跑恢复面 = 0（幂等）
      const di2 = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
        path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
      );
      expect(di2.get('dur-test-1')?.state).toBe('closed');
      di2.dispose();
      expect(await conv2.replayAnsweredInteractions()).toBe(0);
    } finally {
      await dispose(f2);
    }
  }, 20_000);

  // cr-636 幂等兜底：close 未达（竞态/失败）但转录已消费（答案行 + 终稿行）
  // ——转录比对拦截，不重放（重复 run 防线）。
  it('replayAnsweredInteractions：已消费形态（答案行+终稿行）不重放', async () => {
    seedAgent('alpha');
    {
      const { ctx, fibers } = await bootTree('alpha');
      try {
        const di = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        di.open({
          id: 'dur-test-2', key: 'conv-b', kind: 'ask_questions',
          payload: { questions: [{ question: '继续吗？', options: ['是', '否'] }] },
          owner: 'alpha',
        });
        di.reply('dur-test-2', { answers: ['是'] });
        di.dispose();
        // 模拟已消费转录：answerNotice 行 + 终稿行（late-reply deliver 的
        // replayView 形态——sender=self 投 assistant）
        const { answerNotice } = await import('ac-ask-questions');
        const store2 = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        const rec = store2.get('dur-test-2')!;
        store2.dispose();
        const ledger = ctx.get('ledger', false) as unknown as { deliverRow(uuid: string, p: string[], kind: string, row: Record<string, unknown>): Promise<boolean> };
        await ledger.deliverRow('conv-b', ['alpha', 'user'], 'user', { role: 'agent', content: answerNotice(rec), agent_id: 'alpha', requestId: 'seed-1', uuid: 'conv-b' });
        await ledger.deliverRow('conv-b', ['alpha', 'user'], 'user', { role: 'agent', content: '[终稿] 已处理', agent_id: 'alpha', requestId: 'seed-2', uuid: 'conv-b' });
      } finally {
        await dispose(fibers);
      }
    }
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      expect(await conv2.replayAnsweredInteractions()).toBe(0);
      expect(conv2.isBusy()).toBe(false);
    } finally {
      await dispose(f2);
    }
  }, 20_000);

  // cr-638：自激回环根因回归——late-reply 重放以 owner 作 sender（保账本
  // 投影），终稿回信必须指 user。缺 replyTo 时 postReply 投回自身端点，
  // 落账又是入站 message → 再拉一轮 run（实锤：活体账本同 requestId 的
  // 终稿行两行、后一行无 run 字段 = 自投回来那条）。
  it('replyTargetOf：sender 与回信目标分离，回自体 = null（回环防线）', () => {
    const base = { uuid: 'c', requestId: 'r', kind: 'message' as const, budget: 3, to: 'alpha', payload: {} };
    expect(replyTargetOf({ ...base, sender: 'user' }, 'alpha')).toBe('user');
    // 跨壳 agent 回信：信源即目标
    expect(replyTargetOf({ ...base, sender: 'beta' }, 'alpha')).toBe('beta');
    // 自身 = 自激回环 → null
    expect(replyTargetOf({ ...base, sender: 'alpha' }, 'alpha')).toBeNull();
    // replyTo 覆盖优先（late-reply 重放形态）
    expect(replyTargetOf({ ...base, sender: 'alpha', replyTo: 'user' }, 'alpha')).toBe('user');
  });

  it('replayAnsweredInteractions：重放信封携 replyTo=user（终稿不回自体）', async () => {
    seedAgent('alpha');
    {
      const { fibers } = await bootTree('alpha');
      try {
        const di = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        di.open({
          id: 'dur-test-3', key: 'conv-c', kind: 'ask_questions',
          payload: { questions: [{ question: '选哪条？', options: ['A', 'B'] }] },
          owner: 'alpha',
        });
        di.reply('dur-test-3', { answers: ['B'] });
        di.dispose();
      } finally {
        await dispose(fibers);
      }
    }
    const { fibers: f2, conv: conv2 } = await bootTree('alpha');
    try {
      // deliver 是本服务公开方言叶（真 run 面另测）——此处只验信封构造
      const spy = vi.spyOn(conv2 as unknown as { deliver: (...a: unknown[]) => Promise<unknown> }, 'deliver')
        .mockResolvedValue({ kind: 'run', result: { steps: [], text: '', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } } });
      expect(await conv2.replayAnsweredInteractions()).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0]![2] as { sender: string; replyTo?: string; requestId: string };
      expect(opts.sender).toBe('alpha'); // 账本投影口径不变（owner）
      expect(opts.replyTo).toBe('user'); // 回信目标 = user（回环根因）
      expect(opts.requestId).toBe('late-reply-dur-test-3');
    } finally {
      await dispose(f2);
    }
  }, 20_000);
});

});
