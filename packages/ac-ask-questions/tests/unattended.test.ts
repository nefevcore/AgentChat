// ============================================================
// cr-1148 无人值守会话 ask_questions 两道防线验收：
//   C —— 无人桶超时兜底：发起体记 noReplyDeadlineMs；挂起等待超龄
//        close('timeout') → closed 注入支线「用户未响应——请自行决断」。
//   B —— peer 提问路由：agent~agent 无人桶 ask opened → peerAsk 信封
//        通知对端；对端回信带 [peer-ask:<id>] 标记 → 发起壳收信面转
//        interactionReply → 发起侧 store.answered。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, type Fiber, type Plugin } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as diRow from 'ac-durable-interaction';
import * as askRow from '../src/index.ts';
import { makeLedgerRow } from 'ac-ledger';
import { makeConversationRow, type ConversationService } from 'ac-shell-conversation';
import { makeEnvelope, type Envelope } from 'ac-envelope-core';
import { writeAgentConfig } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-ask-unattended-' + process.pid);
const SHELL_ROWS = ['fs-tools', 'shell-tools'].map((id) => ({ id, tree: 'shell' as const, zone: 'capability' as const }));
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const id of ['alpha', 'beta']) {
    writeAgentConfig(ROOT, { id, model: 'mock-1' } as never, { shellRows: SHELL_ROWS });
  }
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 发起壳树：tools → llm → mock provider → loop → ledger → durable →
 *  conversation → ask（与生产壳行序同构的子集）。 */
async function bootAsker(): Promise<{ ctx: Context; fibers: Fiber[]; conv: ConversationService }> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow]) {
    fibers.push(ctx.plugin(row as never, undefined as never));
  }
  const mockFiber = ctx.plugin({
    name: 'mock-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register('mock', () => ({
        stream: async function* (input: { messages: Array<{ role: string; content: string }> }) {
          const last = input.messages.filter((m) => m.role === 'user').at(-1);
          yield { delta: '[回复 ' + (last?.content ?? '') + ']' };
          yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
        },
      }), { models: ['mock-1'] });
    },
  });
  fibers.push(mockFiber);
  fibers.push(ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'alpha' })));
  fibers.push(ctx.plugin(diRow as unknown as Plugin, { root: path.join(ROOT, 'agents', 'alpha') } as never));
  fibers.push(ctx.plugin(makeConversationRow({ dataRoot: ROOT, agentId: 'alpha' })));
  fibers.push(ctx.plugin(askRow as never, undefined as never));
  for (const f of fibers) await f;
  return { ctx, fibers, conv: ctx.get('conversation', false) as unknown as ConversationService };
}

async function dispose(fibers: Fiber[]): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
}

type DiFace = {
  open(i: Record<string, unknown>): { id: string };
  get(id: string): { state: string; payload?: unknown; closedReason?: string } | undefined;
  reply(id: string, answer: unknown): unknown;
  close(id: string, reason?: string): boolean;
  list(filter?: Record<string, unknown>): Array<{ id: string; state: string; key: string; owner?: string; payload?: unknown }>;
};

describe('cr-1148 C：无人桶超时兜底', () => {
  it('无人桶发起 → payload 记 noReplyDeadlineMs；有人桶不记', async () => {
    const { ctx, fibers } = await bootAsker();
    try {
      const di = ctx.get('durableInteraction', false) as unknown as DiFace;
      const unattended = di.open({
        key: 'alpha~beta', kind: 'ask_questions', owner: 'alpha',
        payload: { questions: [{ question: '怎么办？', options: ['甲', '乙'] }], noReply: true, noReplyDeadlineMs: Date.now() + 60_000 },
      });
      const attended = di.open({
        key: 'user~alpha', kind: 'ask_questions', owner: 'alpha',
        payload: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      });
      const p1 = (di.get(unattended.id)?.payload as { noReplyDeadlineMs?: unknown }).noReplyDeadlineMs;
      expect(typeof p1).toBe('number');
      const p2 = (di.get(attended.id)?.payload as { noReplyDeadlineMs?: unknown }).noReplyDeadlineMs;
      expect(p2).toBeUndefined();
      // 判据单源：发起体落 payload 的条件与 humanPresentOf 对齐
      const { humanPresentOf } = await import('ac-agents');
      expect(humanPresentOf('alpha~beta')).toBe(false);
      expect(humanPresentOf('user~alpha')).toBe(true);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('工具发起：无人桶会话键自动获得 deadline，有人桶没有', async () => {
    const { ctx, fibers } = await bootAsker();
    try {
      const args = { questions: [{ question: '怎么处置？', options: ['修', '等'] }] };
      const noHuman = await (ctx.tools.execute as unknown as (c: Record<string, unknown>) => Promise<{ ok: boolean; output: { interaction_id: string } }>)({
        name: 'ask_questions', args, agentId: 'alpha', conversationId: 'alpha~beta', toolCallId: 'call-un-1',
      });
      expect(noHuman.ok).toBe(true);
      const withHuman = await (ctx.tools.execute as unknown as (c: Record<string, unknown>) => Promise<{ ok: boolean; output: { interaction_id: string } }>)({
        name: 'ask_questions', args, agentId: 'alpha', conversationId: 'user~alpha', toolCallId: 'call-hu-1',
      });
      expect(withHuman.ok).toBe(true);
      const di = ctx.get('durableInteraction', false) as unknown as DiFace;
      const p1 = (di.get(noHuman.output.interaction_id)?.payload as { noReplyDeadlineMs?: unknown }).noReplyDeadlineMs;
      expect(typeof p1).toBe('number');
      const p2 = (di.get(withHuman.output.interaction_id)?.payload as { noReplyDeadlineMs?: unknown }).noReplyDeadlineMs;
      expect(p2).toBeUndefined();
    } finally {
      await dispose(fibers);
    }
  }, 15_000);
});

describe('cr-1148 B：peer 提问路由', () => {
  it('无人桶 ask opened → peerAsk 信封落对端 inbox（正文含问题与标记引导）', async () => {
    const { ctx, fibers } = await bootAsker();
    try {
      const di = ctx.get('durableInteraction', false) as unknown as DiFace;
      const rec = di.open({
        key: 'alpha~beta', kind: 'ask_questions', owner: 'alpha',
        payload: { questions: [{ question: '文件谁修？', options: ['你修', '我修'] }] },
      });
      // opened 事件驱动路由是异步（void push）——等落盘
      await new Promise((r) => setTimeout(r, 150));
      const inboxDir = path.join(ROOT, 'agents', 'beta', 'sessions', 'alpha~beta', 'inbox');
      const files = fs.readdirSync(inboxDir);
      expect(files).toContain('peer-ask-' + rec.id + '.json');
      const env = JSON.parse(fs.readFileSync(path.join(inboxDir, 'peer-ask-' + rec.id + '.json'), 'utf-8')) as Envelope;
      expect(env.sender).toBe('alpha');
      expect(env.to).toBe('beta');
      const text = String((env.payload as { text?: unknown }).text ?? '');
      expect(text).toContain('文件谁修？');
      expect(text).toContain('[peer-ask:' + rec.id + ']');
      expect(text).toContain('alpha~beta');
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('有人桶 / 自桶不路由：无 peerAsk 信封', async () => {
    const { ctx, fibers } = await bootAsker();
    try {
      const di = ctx.get('durableInteraction', false) as unknown as DiFace;
      di.open({ key: 'user~alpha', kind: 'ask_questions', owner: 'alpha', payload: { questions: [{ question: 'q', options: ['a'] }] } });
      di.open({ key: 'alpha~alpha', kind: 'ask_questions', owner: 'alpha', payload: { questions: [{ question: 'q', options: ['a'] }] } });
      await new Promise((r) => setTimeout(r, 150));
      expect(fs.existsSync(path.join(ROOT, 'agents', 'user'))).toBe(false);
      // 自桶 owner 即本壳——路由分支排除（无 beta 信封面）
      expect(fs.existsSync(path.join(ROOT, 'agents', 'beta', 'sessions', 'alpha~alpha'))).toBe(false);
    } finally {
      await dispose(fibers);
    }
  }, 15_000);

  it('对端回信带标记 → 发起壳收信面转 interactionReply → answered', async () => {
    const { ctx, fibers, conv } = await bootAsker();
    try {
      const di = ctx.get('durableInteraction', false) as unknown as DiFace;
      const rec = di.open({
        key: 'alpha~beta', kind: 'ask_questions', owner: 'alpha',
        payload: { questions: [{ question: '谁修？', options: ['你修', '我修'] }] },
      });
      await new Promise((r) => setTimeout(r, 150));
      // beta 树（对端壳）：收通知醒 run 读问题（登记册在发起侧 alpha——
      // pushPeerAsk 成功即记，beta 零状态）。
      const betaCtx = new Context();
      const betaFibers: Fiber[] = [];
      for (const row of [toolsRow, llmRow, loopRow]) {
        betaFibers.push(betaCtx.plugin(row as never, undefined as never));
      }
      const betaMock = betaCtx.plugin({
        name: 'mock-provider-beta',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register('mock', () => ({
            stream: async function* (input: { messages: Array<{ role: string; content: string }> }) {
              const last = input.messages.filter((m) => m.role === 'user').at(-1);
              yield { delta: '[beta 回复 ' + (last?.content ?? '') + ']' };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }), { models: ['mock-1'] });
        },
      });
      betaFibers.push(betaMock);
      const betaLedgerFiber: Fiber = betaCtx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'beta' }));
      betaFibers.push(betaLedgerFiber);
      const betaDiFiber: Fiber = betaCtx.plugin(diRow as unknown as Plugin, { root: path.join(ROOT, 'agents', 'beta') } as never);
      betaFibers.push(betaDiFiber);
      const betaConvFiber: Fiber = betaCtx.plugin(makeConversationRow({ dataRoot: ROOT, agentId: 'beta' }));
      betaFibers.push(betaConvFiber);
      for (const f of betaFibers) await f;
      const betaConv = betaCtx.get('conversation', false) as unknown as ConversationService;
      try {
        // beta 收通知（alpha 侧已落的 inbox 文件——读出来直投收信面）。
        // fire-and-forget：登记册在收信面、run 之前——run 收束与否不影响转发链路。
        const notifyFile = path.join(ROOT, 'agents', 'beta', 'sessions', 'alpha~beta', 'inbox', 'peer-ask-' + rec.id + '.json');
        const notifyEnv = JSON.parse(fs.readFileSync(notifyFile, 'utf-8')) as Envelope;
        const notifyP = betaConv.receiveEnvelope(notifyEnv, { fresh: true }).catch(() => 'err');
        // 等收信面跑到登记册之后（receiveEnvelope 前段同步落账 + 登记——
        // run 可能仍在跑，不等它；轮询 peerAskSeen 已登记的可见副作用：无——
        // 直接等 200ms 让同步段完成）
        await new Promise((r) => setTimeout(r, 200));
        // beta 回信（send_agent 语义 = deliver to alpha——本测直投 alpha 收信面）
        const answerEnv = makeEnvelope({
          uuid: 'alpha~beta', requestId: 'beta-reply-' + rec.id, sender: 'beta', to: 'alpha', kind: 'message', budget: 1,
          payload: { text: '我来修，你等校验结果 [peer-ask:' + rec.id + ']' },
        });
        const out2 = await conv.receiveEnvelope(answerEnv, { fresh: true });
        expect(out2).toBe('ledger-only'); // 转发后代答不作会话行
        // 测试树无 ipc listener——转发的 interactionReply 信封落 alpha inbox 文件；
        // 真实拓扑 = 活壳直投 ipc → 收信面 iReply 分支。此处直投回环模拟同链：
        const fwdFile = path.join(ROOT, 'agents', 'alpha', 'sessions', 'alpha~beta', 'inbox', 'peer-answer-' + rec.id + '.json');
        const fwdEnv = JSON.parse(fs.readFileSync(fwdFile, 'utf-8')) as Envelope;
        const out3 = await conv.receiveEnvelope(fwdEnv, { fresh: true });
        expect(out3).toBe('ledger-only');
        expect(di.get(rec.id)?.state).toBe('answered');
        const answer = (di.get(rec.id) as { answer?: { answers?: string[] } }).answer;
        expect(answer?.answers?.[0]).toBe('我来修，你等校验结果');
      } finally {
        await dispose(betaFibers);
      }
    } finally {
      await dispose(fibers);
    }
  }, 30_000);
});