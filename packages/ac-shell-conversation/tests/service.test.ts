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
import { makeEnvelope, socketPathFor, type Envelope } from 'ac-envelope-core';
import { listenIpc } from 'ac-post-office';

const ROOT = path.join('sandbox', 'test-conv-svc-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock-1', ...extra }), 'utf-8');
}

/** 真树 boot：tools → llm → mock provider → loop → ledger → conversation。
 *  chatModels（可选）= 捕获 provider 实收的 model（cr-565 覆盖生效断言面）；
 *  gate（可选）= 慢 mock 闸门（首流挂起直到放行——busy 窗口用，cr-575）；
 *  gates（可选）= 逐调用闸门（第 n 次流调用等 gates[n]——多 run 顺序挂起，
 *  cr-745 链跑交接面用；与 gate 二选一）。 */
async function bootTree(agentId: string, chatModels?: string[], gate?: Promise<void>, providerError?: Error, chatTools?: string[][], chatMessages?: Array<Array<{ role: string; content: string }>>, postOfficeAddress?: string, gates?: Array<Promise<void>>): Promise<{ ctx: Context; fibers: Fiber[]; conv: ConversationService }> {
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
      let streamN = 0;
      c.llm.register('mock', () => ({
        stream: async function* (input: { model?: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function?: { name?: string } }> }) {
          if (gates !== undefined) { const g = gates[streamN++]; if (g !== undefined) await g; }
          else if (gate !== undefined) await gate;
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
    ...(postOfficeAddress !== undefined ? { postOfficeAddress } : {}),
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

function msg(uuid: string, requestId: string, text: string, sender = 'user', lane?: 'next-step' | 'next-turn'): Envelope {
  return makeEnvelope({ uuid, requestId, sender, to: 'alpha', payload: { text, ...(lane !== undefined ? { lane } : {}) } });
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
      // cr-697：settlement 物化段行（source='segment'，content 恒空）——
      // 终稿层断言过滤物化行（steps 在场性归 ledger.test）
      const final = rows.filter((r) => r.source !== 'segment' && r.source !== 'inject');
      expect(final.map((r) => r.content)).toEqual(['第一问', '[回复 第一问]', '第二问', '[回复 第二问]']);
      expect(final[1]).toMatchObject({ agent_id: 'alpha', run: 'run-r1' });
      // 步级事实已物化段行在账（journal 收束即清）
      expect(rows.some((r) => r.source === 'segment' && r.run === 'run-r1')).toBe(true);
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
      // 重发未增行（物化段行不计——幂等只看消息行）
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject')).toHaveLength(2);
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

  // cr-710：回环根因回归——唤醒许可取信封 budget（0 = 只落账）。旧实现
  // 用机器内存预算（壳代起 3），子 Agent 回信每代重获满额 → 父⇄子自动
  // 互答跨重启无限续跑（数据根 21:42–21:47 reply- 链实锤）。
  it('agent 入站 budget=0：只落账不起 run（壳换代重放同款，零 LLM 调用）', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const first = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    try {
      const zero = makeEnvelope({ uuid: UUID, requestId: 'zero-hop', sender: 'kid1', to: 'alpha', budget: 0, payload: { text: '子 Agent 回信' } });
      expect(await first.conv.receiveEnvelope(zero, { fresh: true })).toBe('ledger-only');
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows.filter((r) => r.requestId === 'zero-hop')).toHaveLength(1);
      expect(rows.some((r) => r.run !== undefined)).toBe(false);
      expect(chatMessages).toEqual([]); // 零 LLM 调用
      // 预算之源（R-2）：user 直发 budget=0 也重置满额 → 照常起 run
      const userZero = makeEnvelope({ uuid: UUID, requestId: 'user-zero', sender: 'user', to: 'alpha', budget: 0, payload: { text: '用户新消息' } });
      expect(await first.conv.receiveEnvelope(userZero, { fresh: true })).toBe('settled');
      expect(chatMessages).toHaveLength(1);
    } finally {
      await dispose(first.fibers);
    }
    // 换代（新 service 实例 = 旧实现的内存预算重置点）：同额度信封重放仍不唤醒
    const second = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    try {
      const replay = makeEnvelope({ uuid: UUID, requestId: 'zero-hop-2', sender: 'kid1', to: 'alpha', budget: 0, payload: { text: '回信重放' } });
      expect(await second.conv.receiveEnvelope(replay, { fresh: true }, { recovered: true })).toBe('ledger-only');
      expect(chatMessages).toHaveLength(1); // 无新增调用（仅上代 user run）
    } finally {
      await dispose(second.fibers);
    }
  }, 30_000);

  // cr-710：子 Agent 回信直投——在管子 id 不在宿主可达表，走邮局会拉起
  // 同 id 顶层幽灵身份；postReply 必须经 subagents 服务直投其 ipc。
  // cr-711：回信 payload 原样回带 replyConversation（完成回执的发起会话键）。
  it('postReply：目标是本壳子 Agent → 经 subagents 直投（不触邮局）', async () => {
    seedAgent('alpha');
    const deliveries: Envelope[] = [];
    class FakeChildren extends Service {
      constructor(c: Context) { super(c, 'subagents'); }
      ownsChild(id: string): boolean { return id === 'kid1'; }
      async deliverToChild(_id: string, env: Envelope): Promise<boolean> { deliveries.push(env); return true; }
    }
    // postOfficeAddress 故意给不可用值：命中子 Agent 分支就不应尝试连接邮局
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, undefined, 'pipe-never-used');
    const fakeFiber = ctx.plugin({
      name: 'fake-children',
      apply(c: Context) { c.plugin(FakeChildren); },
    } as never, undefined as never);
    fibers.push(fakeFiber);
    await fakeFiber;
    try {
      // 回信目标 = 子 Agent 由 replyTo 指定（sender 是发起会话的用户——
      // 子 Agent 自来信已归「完成回执」，不再起 run，见下一用例）
      const out = await conv.receiveEnvelope(makeEnvelope({
        uuid: UUID, requestId: 'kid-rep', sender: 'user', to: 'alpha', budget: 1,
        replyTo: 'kid1',
        payload: { text: '发起会话消息', replyConversation: 'u-init' },
      }), { fresh: true });
      expect(out).toBe('settled');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        to: 'kid1', sender: 'alpha', requestId: 'reply-kid-rep', budget: 0,
        payload: { replyConversation: 'u-init' },
      });
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  // cr-711：子 Agent 完成回执落点——父⇄子对桶只落账（不跑 run），结果作为
  // 一条来自子 Agent 的消息转投**发起会话**（spawn 工具调用所在 user⇄父），
  // 父以 replyTo=user 回复——不再出现「LLM 有消息必回」的父⇄子互答。
  it('子 Agent 完成回执：对桶只落账 + 结果转投发起会话（不起父⇄子 run）', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    class FakeChildren extends Service {
      constructor(c: Context) { super(c, 'subagents'); }
      ownsChild(id: string): boolean { return id === 'kid1'; }
      async deliverToChild(): Promise<boolean> { return true; }
    }
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    const fakeFiber = ctx.plugin({
      name: 'fake-children',
      apply(c: Context) { c.plugin(FakeChildren); },
    } as never, undefined as never);
    fibers.push(fakeFiber);
    await fakeFiber;
    const PAIR = 'alpha~kid1';
    const INIT = 'u-init~alpha';
    try {
      const done = makeEnvelope({
        uuid: PAIR, requestId: 'reply-sub-1', sender: 'kid1', to: 'alpha', budget: 1,
        payload: { text: '子 Agent 的结果正文', replyConversation: INIT },
      });
      expect(await conv.receiveEnvelope(done, { fresh: true })).toBe('ledger-only');
      // 对桶：子终稿一行在账；父 run / 父回信都不存在
      const pairRows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', PAIR)).rows;
      expect(pairRows.filter((r) => r.role === 'agent' && r.agent_id === 'kid1')).toHaveLength(1);
      expect(pairRows.some((r) => r.run !== undefined)).toBe(false);
      // 发起会话：结果注入行（来自子 Agent）+ 父 run（面向用户的一轮）
      const initRows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', INIT)).rows;
      expect(initRows.find((r) => r.agent_id === 'kid1')).toMatchObject({
        content: expect.stringContaining('子 Agent 的结果正文'),
      });
      expect(initRows.some((r) => r.agent_id === 'alpha' && typeof r.run === 'string')).toBe(true);
      expect(chatMessages).toHaveLength(1);
      // 同一回执重放（壳重启 inbox 重投）：通知 requestId 幂等 → 不再唤醒
      expect(await conv.receiveEnvelope(done, { fresh: true }, { recovered: true })).toBe('ledger-only');
      expect(chatMessages).toHaveLength(1);
      // sync/waitMs 完成（无 replyConversation）：只落账，不二次通知
      const syncDone = makeEnvelope({
        uuid: PAIR, requestId: 'reply-sub-2', sender: 'kid1', to: 'alpha', budget: 1,
        payload: { text: '同步结果' },
      });
      expect(await conv.receiveEnvelope(syncDone, { fresh: true })).toBe('ledger-only');
      expect(chatMessages).toHaveLength(1);
    } finally {
      await dispose(fibers);
    }
  }, 30_000);

  // cr-713：busy-steer 消息不落入站行——mid-run 到达的完成回执只以注入行
  // 落账（run 轨迹真实到达位），不再「seq 错位排在 run 块之前 + 与注入行
  // 同文双份」；重放按注入行/台账同键幂等。
  it('完成回执 mid-run 到达（busy-steer）：无入站行、注入行单份在位、重放不重复', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class FakeChildren extends Service {
      constructor(c: Context) { super(c, 'subagents'); }
      ownsChild(id: string): boolean { return id === 'kid1'; }
      async deliverToChild(): Promise<boolean> { return true; }
    }
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const fakeFiber = ctx.plugin({
      name: 'fake-children',
      apply(c: Context) { c.plugin(FakeChildren); },
    } as never, undefined as never);
    fibers.push(fakeFiber);
    await fakeFiber;
    const PAIR = 'alpha~kid1';
    const INIT = 'u-init~alpha';
    const done = makeEnvelope({
      uuid: PAIR, requestId: 'reply-sub-9', sender: 'kid1', to: 'alpha', budget: 1,
      payload: { text: 'mid-run 结果正文', replyConversation: INIT },
    });
    try {
      const first = conv.receiveEnvelope(msg(INIT, 'm1', '发起任务'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80)); // 占门 + runStarted 补登
      expect(conv.isBusy()).toBe(true);
      expect(await conv.receiveEnvelope(done, { fresh: true })).toBe('ledger-only');
      release();
      await first;
      const dir = path.join(ROOT, 'agents', 'alpha', 'sessions', INIT);
      const { rows } = readLedger(dir);
      // 无独立入站行：发起会话不出现 kid1 的非注入行（修复前 seq 错位行）
      expect(rows.some((r) => r.agent_id === 'kid1' && r.source !== 'inject')).toBe(false);
      // 注入行恰一条，携带回执派生 requestId（重放判重锚）
      const inj = rows.filter((r) => r.source === 'inject');
      expect(inj).toHaveLength(1);
      expect(inj[0]).toMatchObject({ content: expect.stringContaining('mid-run 结果正文'), requestId: 'subagent-done-reply-sub-9' });
      // 注入行落在 run 轨迹位（用户行之后、终稿行之前）——不在 run 块之前
      const injAt = rows.findIndex((r) => r.source === 'inject');
      expect(injAt).toBeGreaterThan(rows.findIndex((r) => r.requestId === 'm1'));
      expect(injAt).toBeLessThan(rows.findIndex((r) => r.requestId === 'reply-m1'));
      // 轨迹单份（不双喂）：通知正文精确一份（mock 终稿回声含原文属正常回复，
      // 不计入）——注入行进轨迹，无入站行复读
      const notice = '[子 Agent kid1 完成]\nmid-run 结果正文';
      const ledgerFace = ctx.get('ledger', false) as unknown as { historyMessagesFor(u: string): Array<{ content: string }> };
      expect(ledgerFace.historyMessagesFor(INIT).filter((m) => m.content === notice)).toHaveLength(1);
      // 重放（壳重启 inbox 重投）：注入行同键判重 → 不再唤醒、不二份
      expect(await conv.receiveEnvelope(done, { fresh: true }, { recovered: true })).toBe('ledger-only');
      expect(readLedger(dir).rows.filter((r) => r.source === 'inject')).toHaveLength(1);
    } finally {
      release();
      await dispose(fibers);
    }
  }, 30_000);
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
      // 账本：入站两行（慢问题 + 排队消息A）+ 终稿一行；steer 注入物化行
      // 携带 requestId（cr-713——queue→steered 双记录，读侧去重防双喂）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      expect(rows.filter((r) => r.requestId === 'q2').map((r) => r.source ?? '')).toEqual(['', 'inject']);
      const ledgerFace = ctx.get('ledger', false) as unknown as { historyMessagesFor(u: string): Array<{ content: string }> };
      expect(ledgerFace.historyMessagesFor(UUID).filter((m) => m.content === '排队消息A')).toHaveLength(1);
      const journal = readJournal(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      // cr-697：收束即清——注入行物化进账本（source='inject'），journal 不留
      expect(rows).toContainEqual(expect.objectContaining({ source: 'inject', run: 'run-q1', content: '排队消息A' }));
      expect(journal).not.toContainEqual(expect.objectContaining({ type: 'journal-inject', run: 'run-q1' }));
    } finally {
      release();
      await dispose(fibers);
    }
  }, 15_000);

  // cr-707：上下文注入落账口——注入身份缺省即铸（直播帧与物化行同锚）、
  // 事件先于落盘（journal IO 不得挡在帧前，否则续跑帧超车致直播注入行漂移）、
  // label/来源随行落盘（此前只进事件，刷新即丢文案）。
  it('recordContext：事件带注入身份+label，物化注入行同锚同文案（刷新可回放）', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const injections: Array<{ source?: string; label?: string; injectionId?: string }> = [];
    ctx.on('session/context-injected', (_cid: string, _agent: string | undefined, meta: { source?: string; label?: string; injectionId?: string } | undefined) => {
      if (meta !== undefined) injections.push(meta);
    });
    try {
      const first = conv.receiveEnvelope(msg(UUID, 'rc1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80)); // 占门 + run 活跃
      expect(conv.isBusy()).toBe(true);
      await conv.recordContext(UUID, '[系统通知] 你此前发起的提问已收到用户回答：…', {
        source: 'durable-interaction', label: '已收到用户回答',
      });
      const ev = injections.at(-1)!;
      expect(ev).toMatchObject({ source: 'durable-interaction', label: '已收到用户回答' });
      expect(ev.injectionId).toMatch(/^inj-/);
      release();
      await first;
      // 落盘：收束物化后注入行 message_id = 直播帧 injectionId（同锚）+
      // 来源/文案随行（前端 context 行直出）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', UUID));
      const inj = rows.find((r) => r.source === 'inject');
      expect(inj).toMatchObject({
        message_id: ev.injectionId,
        label: '已收到用户回答',
        injectSource: 'durable-interaction',
        run: 'run-rc1',
      });
    } finally {
      release();
      await dispose(fibers);
    }
  }, 15_000);

  // cr-591（run-error 泛化）：每用户 run 收束 → conversation/run-settled
  // 事件（boot 旁带发射的数据源——前端收束三件套唯一驱动）；reviewRun 机制 run 不发。
  it('run 收束发 conversation/run-settled（失败带 message；reviewRun 不发）', async () => {    seedAgent('alpha');
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

  // cr-746 per-门：busy 判定按 runAddress——跨会话信在自己门恒空闲，直接
  // 开跑（A 的 run 不再阻塞 B）。cr-627 的「跨会话转投 + 链跑消费」语义随
  // 单门退役；跨会话排队只发生在该会话自己的门 busy 时。
  it('跨会话并行（cr-746）：A 慢 run 占门期间 B 的信直接开跑——不排队不等 A', async () => {
    seedAgent('alpha');
    // 双闸门：A 首流挂起占 A 门；B 首流挂起后断言 B run 在途（A 仍挂）
    const gates = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    });
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, undefined, undefined, gates.map((g) => g.promise));
    try {
      // 会话 A 慢 run（首流挂起——A 门 busy）
      const first = conv.receiveEnvelope(msg('conv-a', 'a1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(conv.isBusy()).toBe(true);
      expect(conv.runState().runs.map((r: { conversationId: string }) => r.conversationId)).toEqual(['conv-a']);
      // 会话 B 的信：B 门空闲 → 直接 run（旧单门：steer 落空 → 转投队列等 A）
      const second = conv.receiveEnvelope(msg('conv-b', 'b1', '跨会话信'), { fresh: true });
      // B 的首流入闸 = B run 已在途（与 A 并行）
      await new Promise((r) => setTimeout(r, 200));
      const rs = conv.runState().runs;
      expect(rs.map((r: { conversationId: string }) => r.conversationId).sort()).toEqual(['conv-a', 'conv-b']);
      expect(rs.find((r: { conversationId: string }) => r.conversationId === 'conv-b')!.runId).toBe('run-b1');
      // 各自收束互不干扰
      gates[1]!.resolve(); // 放行 B
      await second;
      gates[0]!.resolve(); // 放行 A
      await first;
      expect(conv.isBusy()).toBe(false);
      // cr-748 收束尾巴：两会话的 run 各入 recentSettled（runId 归属正确）
      const tail = conv.runState().recentSettled.map((s) => [s.conversationId, s.runId, s.finish]);
      expect(tail).toContainEqual(['conv-a', 'run-a1', 'ok']);
      expect(tail).toContainEqual(['conv-b', 'run-b1', 'ok']);
      // 活跃集已空——尾巴与 runs 独立（收束后仍可读）
      expect(conv.runState().busy).toBe(false);
      // 两会话账本各自闭环
      for (const [cid, text] of [['conv-a', '慢问题'], ['conv-b', '跨会话信']] as const) {
        const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', cid));
        expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((x) => x.content)).toEqual([text, `[回复 ${text}]`]);
      }
    } finally {
      gates[0]!.resolve();
      gates[1]!.resolve();
      await dispose(fibers);
    }
  }, 20_000);

  // cr-745 语义在 per-门下（cr-746）的同会话形态：next-turn 排队 → 收束点
  // 链跑消费，runState 的 runs 数组随 run 换届（runId 正确归属会话）。
  it('同会话链跑交接（cr-745×746）：排队 turn 的 run 在 runState 报正确 runId', async () => {
    seedAgent('alpha');
    const gates = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    });
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, undefined, undefined, gates.map((g) => g.promise));
    try {
      // 会话 conv-a 首 run 占门（首流挂起）
      const first = conv.receiveEnvelope(msg('conv-a', 'a1', '第一问'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(conv.runState()).toMatchObject({ busy: true, conversationId: 'conv-a', runId: 'run-a1' });
      // 同会话第二封 next-turn 排队（busy → lane=next-turn 入队）
      await conv.receiveEnvelope(msg('conv-a', 'a2', '第二问', 'user', 'next-turn'), { fresh: true });
      expect(conv.queue('conv-a')).toHaveLength(1);
      // 放行首 run → 收束 → 链跑拉起 a2 run（第二流挂起）
      gates[0]!.resolve();
      for (let i = 0; i < 100 && conv.runState().runId !== 'run-a2'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const st = conv.runState();
      expect(st.busy).toBe(true);
      expect(st.conversationId).toBe('conv-a');
      expect(st.runId).toBe('run-a2'); // runId 随链跑换届（cr-745 交接语义）
      gates[1]!.resolve();
      await first;
      expect(conv.isBusy()).toBe(false);
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-a'));
      // 行序：a2 入站行在 a1 收束前已落（到达序），a1 终稿在收束时
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((x) => x.content)).toEqual(['第一问', '第二问', '[回复 第一问]', '[回复 第二问]']);
    } finally {
      gates[0]!.resolve();
      gates[1]!.resolve();
      await dispose(fibers);
    }
  }, 20_000);

  it('链跑死信跳过（cr-685）：队头死信（inbox 无信封残迹）不再丢整队——后续合法 turn 照跑', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fibers, conv } = await bootTree('alpha', undefined, gate);
    try {
      // 会话 conv-b 慢 run 占门（首流挂起）
      const first = conv.receiveEnvelope(msg('conv-b', 'a1', '占门问'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      // 同会话两封 next-turn 依次排队：b1（将被做成死信——inbox 残迹被清）+ b2（合法）
      await conv.receiveEnvelope(msg('conv-b', 'b1', '第一封', 'user', 'next-turn'), { fresh: true });
      await conv.receiveEnvelope(msg('conv-b', 'b2', '第二封', 'user', 'next-turn'), { fresh: true });
      expect(conv.queue('conv-b')).toHaveLength(2);
      // b1 的 inbox 信封文件移除 = 死信形态（已被消费的残迹 / 无信封合成轮）
      fs.rmSync(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-b', 'inbox', 'b1.json'));
      release();
      await first;
      for (let i = 0; i < 100 && conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(conv.isBusy()).toBe(false);
      // b1 死信被跳过（无 run 轨迹）；b2 照跑——修复前 b1 miss 即 break +
      // finally 再移位丢 b2，两 turn 全蒸发（creator 实锤现场）。
      // 行序：排队信入站行在占门 run 收束前已落（到达序），占门终稿在收束时
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-b'));
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((x) => x.content)).toEqual(['占门问', '第一封', '第二封', '[回复 占门问]', '[回复 第二封]']);
      expect(rows.filter((r) => r.source !== 'segment')[4]).toMatchObject({ run: 'run-b2' });
      expect(conv.queue('conv-b')).toHaveLength(0);
    } finally {
      release();
      await dispose(fibers);
    }
  }, 20_000);

  it('restart break 不丢队列（cr-685）：收束点早退后排队 turn 原位保留', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, fibers, conv } = await bootTree('alpha', undefined, gate);
    const restartReady: string[] = [];
    ctx.on('conversation/restart-ready', (p2: { conversationId?: string }) => { restartReady.push(p2.conversationId ?? ''); });
    try {
      const first = conv.receiveEnvelope(msg('conv-a', 'a1', '慢问题'), { fresh: true });
      await new Promise((r) => setTimeout(r, 80));
      await conv.receiveEnvelope(msg('conv-a', 'b1', '排队信', 'user', 'next-turn'), { fresh: true }); // 同会话排队
      expect(conv.requestRestart()).toBe(true); // 收束点将 break（restart 兑现）
      release();
      await first;
      expect(restartReady).toEqual(['conv-a']);
      expect(conv.isBusy()).toBe(false);
      // 修复前：finally runSettled(false) 移位丢弃队头（b1 静默蒸发）；
      // 修复后：清门不动队列——b1 原位保留（新代 boot 恢复面/下一封信消费）
      expect(conv.queue('conv-a')).toHaveLength(1);
      expect(conv.queue('conv-a')[0]!.id).toBe('b1');
    } finally {
      release();
      await dispose(fibers);
    }
  }, 20_000);

  it('reviewRun 收束唤醒排队 turn（cr-688）：非链跑消费者释放门后队列不再滞留', async () => {
    seedAgent('alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fibers, conv } = await bootTree('alpha', undefined, gate);
    try {
      // reviewRun 先占门（首流挂起——整理 run 持有串行化门）
      const review = conv.reviewRun('conv-a', '整理提示', { runId: 'review-1' });
      await new Promise((r) => setTimeout(r, 80));
      expect(conv.isBusy()).toBe(true);
      // 占门期同会话 next-turn 信 → 入队（无信再触发 = 修复前滞留现场）
      const cross = await conv.receiveEnvelope(msg('conv-a', 'b1', '排队信', 'user', 'next-turn'), { fresh: true });
      expect(cross).toBe('queued');
      expect(conv.queue('conv-a')).toHaveLength(1);
      release();
      await review;
      // review 收束 → 唤醒消费：conv-a 的 run 真跑并收束（不再等下一封信）
      for (let i = 0; i < 100 && conv.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(conv.isBusy()).toBe(false);
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-a'));
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((x) => x.content)).toEqual(['排队信', '[回复 排队信]']);
      expect(conv.queue('conv-a')).toHaveLength(0);
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
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((x) => x.content)).toEqual(['慢问题', '[回复 慢问题]']);
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
      // 终稿行恰一份（cr-697 物化段行同 run 在场不计）；段行在账
      expect(rows.filter((r) => r.agent_id === 'alpha' && r.run === 'run-f1' && r.source === undefined)).toHaveLength(1);
      expect(rows.some((r) => r.source === 'segment' && r.run === 'run-f1')).toBe(true);
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

  // cr-747 回归：steer/挂起注入路径消费的答案行是 source='inject' 形态——
  // replayView 恒过滤 inject 行，旧比对（historyFor 投影）恒失配 → 每次
  // 重启重放已消费答案（二次唤醒事故现场 dur-mvrrebv9）。新比对扫原始
  // 账本行，inject 答案行 + 其后终稿行 = 已消费，不重放。
  it('replayAnsweredInteractions：inject 形态消费（答案行+终稿行）不重放', async () => {
    seedAgent('alpha');
    {
      const { ctx, fibers } = await bootTree('alpha');
      try {
        const di = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        di.open({
          id: 'dur-inj-1', key: 'conv-inj', kind: 'ask_questions',
          payload: { questions: [{ question: '继续吗？', options: ['是', '否'] }] },
          owner: 'alpha',
        });
        di.reply('dur-inj-1', { answers: ['是'] });
        di.dispose();
        const { answerNotice } = await import('ac-ask-questions');
        const store2 = new (await import('ac-durable-interaction')).JsonlDurableInteractionStore(
          path.join(ROOT, 'agents', 'alpha', 'interactions.jsonl'),
        );
        const rec = store2.get('dur-inj-1')!;
        store2.dispose();
        const ledger = ctx.get('ledger', false) as unknown as { deliverRow(uuid: string, p: string[], kind: string, row: Record<string, unknown>): Promise<boolean> };
        // 事故现场形态：notice 落 inject 行（steer 注入路径）+ 其后终稿行
        await ledger.deliverRow('conv-inj', ['alpha', 'user'], 'user', { role: 'agent', content: answerNotice(rec), agent_id: 'alpha', requestId: 'seed-1', uuid: 'conv-inj', source: 'inject' });
        await ledger.deliverRow('conv-inj', ['alpha', 'user'], 'user', { role: 'agent', content: '[终稿] 已按回答处理', agent_id: 'alpha', requestId: 'seed-2', uuid: 'conv-inj' });
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

// ============================================================
// cr-712：跨壳投递接通（send_agent 断点 #3）+ 完成回执泛化（cr-711
// 语义推广到跨壳 Agent 委托）+ 群广播不回投（方案 A）+ 失败文案。
// ============================================================
describe('cr-712 跨壳投递与完成回执', () => {
  it('deliver 目标非本壳 agent：信封经邮局外发 + 本侧只落出站行（不自己消费自己）', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const address = socketPathFor(path.resolve(ROOT), 'po-c712a');
    const frames: Envelope[] = [];
    const server = await listenIpc(address, (frame) => {
      frames.push(frame as Envelope);
      return { dispatched: true };
    });
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages, address);
    try {
      const out = await conv.deliver('beta', '委托任务', {
        sender: 'alpha',
        conversationId: 'alpha~beta',
        replyConversation: 'user~alpha',
      });
      // 受理即返（跨壳异步——run 在对端壳）
      expect(out).toMatchObject({ kind: 'sent' });
      // 邮局外发信封：to=目标 / 对桶键 / 发起会话键随 payload
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        to: 'beta', sender: 'alpha', uuid: 'alpha~beta', kind: 'message',
        payload: { text: '委托任务', replyConversation: 'user~alpha' },
      });
      // 本壳只落自己的出站行（对桶 sender 侧投影）——不起 run（修复前
      // 喂本壳 receiveEnvelope：发送方自己跑一轮、对端永远收不到）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'alpha~beta'));
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((r) => r.content)).toEqual(['委托任务']);
      expect(rows.some((r) => r.run !== undefined)).toBe(false);
      expect(chatMessages).toEqual([]);
    } finally {
      await dispose(fibers);
      await server.close();
    }
  }, 15_000);

  it('无邮局形态（CLI 直连）跨壳投递 fail-loud', async () => {
    seedAgent('alpha');
    const { fibers, conv } = await bootTree('alpha');
    try {
      await expect(conv.deliver('beta', 'x', { sender: 'alpha' })).rejects.toThrow('邮局未装配');
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('跨壳 Agent 完成回执（completion 标记）：对桶只落账 + 结果转投发起会话', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    const PAIR = 'alpha~beta';
    const INIT = 'user~alpha';
    try {
      const done = makeEnvelope({
        uuid: PAIR, requestId: 'reply-x1', sender: 'beta', to: 'alpha', budget: 1,
        payload: { text: '跨壳终稿正文', replyConversation: INIT, completion: true },
      });
      expect(await conv.receiveEnvelope(done, { fresh: true })).toBe('ledger-only');
      // 对桶：终稿一行在账、无 run
      const pairRows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', PAIR)).rows;
      expect(pairRows.filter((r) => r.role === 'agent' && r.agent_id === 'beta')).toHaveLength(1);
      expect(pairRows.some((r) => r.run !== undefined)).toBe(false);
      // 发起会话：'[Agent beta 回复]' 通知注入 + alpha 面向用户的一轮 run
      const initRows = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', INIT)).rows;
      expect(initRows.find((r) => r.agent_id === 'beta')?.content).toContain('[Agent beta 回复]');
      expect(initRows.find((r) => r.agent_id === 'beta')?.content).toContain('跨壳终稿正文');
      expect(initRows.some((r) => r.agent_id === 'alpha' && typeof r.run === 'string')).toBe(true);
      expect(chatMessages).toHaveLength(1);
      // 重放幂等：不再二次唤醒
      expect(await conv.receiveEnvelope(done, { fresh: true }, { recovered: true })).toBe('ledger-only');
      expect(chatMessages).toHaveLength(1);
    } finally {
      await dispose(fibers);
    }
  }, 20_000);

  it('任务信封（replyConversation 无 completion 标记）不是回执——照常起 run', async () => {
    seedAgent('alpha');
    const chatMessages: Array<Array<{ role: string; content: string }>> = [];
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, chatMessages);
    try {
      const task = makeEnvelope({
        uuid: 'alpha~beta', requestId: 'task-x1', sender: 'beta', to: 'alpha', budget: 2,
        payload: { text: '反向委托任务', replyConversation: 'user~beta' },
      });
      expect(await conv.receiveEnvelope(task, { fresh: true })).toBe('settled');
      expect(chatMessages).toHaveLength(1);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('群广播扇出（broadcast 标记）：成员 run 收束不回投发送方（无串键/回声）', async () => {
    seedAgent('alpha');
    const address = socketPathFor(path.resolve(ROOT), 'po-c712b');
    const frames: Envelope[] = [];
    const server = await listenIpc(address, (frame) => {
      frames.push(frame as Envelope);
      return { dispatched: true };
    });
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, undefined, undefined, undefined, address);
    try {
      const groupMsg = makeEnvelope({
        uuid: 'g1~alpha', requestId: 'g-msg1', sender: 'gamma', to: 'alpha', budget: 3,
        payload: { text: '群消息', broadcast: true },
      });
      expect(await conv.receiveEnvelope(groupMsg, { fresh: true })).toBe('settled');
      // 终稿只落自己成员流；邮局无回信帧（修复前 postReply 回投 gamma =
      // 发送方账本多出 g1~alpha 成员流目录 + 群内互答链）
      expect(frames).toEqual([]);
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'g1~alpha'));
      expect(rows.filter((r) => r.source !== 'segment' && r.source !== 'inject').map((r) => r.content)).toEqual(['群消息', '[回复 群消息]']);
    } finally {
      await dispose(fibers);
      await server.close();
    }
  }, 15_000);

  it('error 收束 + 跨壳 Agent 收信人：回信带失败文案（发起方不再空等）', async () => {
    seedAgent('alpha');
    const address = socketPathFor(path.resolve(ROOT), 'po-c712c');
    const frames: Envelope[] = [];
    const server = await listenIpc(address, (frame) => {
      frames.push(frame as Envelope);
      return { dispatched: true };
    });
    const { fibers, conv } = await bootTree('alpha', undefined, undefined, new Error('连接超时'), undefined, undefined, address);
    try {
      const task = makeEnvelope({
        uuid: 'alpha~beta', requestId: 'fail-x1', sender: 'beta', to: 'alpha', budget: 2,
        payload: { text: '会失败的任务' },
      });
      expect(await conv.receiveEnvelope(task, { fresh: true })).toBe('settled');
      // 回信 beta：空终稿被失败文案取代（修复前空文本跳过 = 对端永不知情）
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ to: 'beta', sender: 'alpha' });
      expect((frames[0]!.payload as { text?: string }).text).toContain('[执行失败：连接超时]');
    } finally {
      await dispose(fibers);
      await server.close();
    }
  }, 15_000);
});

describe('父侧代答（cr-736）：interactionReply 标记信封 → durableInteraction.reply', () => {
  it('标记信封不进会话机（ledger-only）——直接落 interaction store', async () => {
    seedAgent('alpha');
    const { ctx, fibers, conv } = await bootTree('alpha');
    try {
      const rec = (ctx.get('durableInteraction', false) as unknown as { open(i: Record<string, unknown>): { id: string } }).open({
        key: 'u-conv-1', kind: 'ask_questions', payload: { questions: [{ question: '怎么走？', options: ['A', 'B'] }] },
      });
      const outcome = await conv.receiveEnvelope(makeEnvelope({
        uuid: 'u-conv-1', requestId: 'sub-answer-1', sender: 'papa', to: 'alpha', kind: 'message', budget: 0,
        payload: { interactionReply: { id: rec.id, answer: { answers: ['A'] } } },
      }), { fresh: true });
      expect(outcome).toBe('ledger-only');
      expect((ctx.get('durableInteraction', false) as { get(id: string): { state: string } }).get(rec.id)?.state).toBe('answered');
    } finally {
      await dispose(fibers);
    }
  }, 15_000);
});
