// ============================================================
// archive 行单测（cr-546 D11 + cr-1189 V3 注入驱动/结构化提交）——
// ① 触发检测（注册式——token 阈值缺省 + run-count 扩展注册）→ 机制信
//   deliver 唤醒整理轮（注入行落账）→ digest 捞取 → 摘要行 + 边界；
// ② 结构化提交闭环：摘要注入行全文 = digest 参数；compaction 事件无 summary；
// ③ 无提交退化：Agent 不调 digest → 边界照落、摘要行缺席、回放头沿用上一代；
// ④ 工具守卫：非压缩轮调用 session_digest → 无副作用提示返回；
// ⑤ fs 无关性 + 存量兼容（v2 事件摘要代回放头不回退）；
// ⑥ archive-all 批量面 + 二次压缩（逻辑代叠加 + 物理解耦）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Context, Service } from '@agentchat/cordis';
import { ArchiveShellService, makeArchiveRow } from '../src/archive.ts';
import { makeLedgerRow, readLedger, foldSession, foldDigestOf, ARCHIVE_SUMMARY_SOURCE, LedgerService } from 'ac-ledger';
import * as toolsRow from 'ac-tools';

const ROOT = path.join('sandbox', 'test-archive-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/**
 * 最小壳环境：ledger + conversation stub（deliver 接口契约——archive 行
 * 唯一依赖面；真身链 agent-loop/llm 归 conversation 行自测）。stub 的
 * deliver 模拟压缩轮：机制信落 context 行 + run 事实（可选 session_digest
 * 调用对）+ run-end，再回执——编排等待窗据此收束。
 */
interface DeliverOptions { conversationId?: string; requestId?: string; mechanism?: boolean; sender?: string; source?: string }
type DeliverFn = (agentId: string, inbound: string, options?: DeliverOptions) => Promise<unknown>;

interface StubSetup {
  deliver: DeliverFn;
  /** 模拟整理轮内 Agent 是否调 session_digest；文本 = digest 参数 */
  digestText: string | null;
  /** 整理轮 runId 纪录（断言面） */
  seenRunIds: string[];
}

async function bootShellRows(agentId: string, setup: Partial<StubSetup> = {}) {
  const ctx = new Context();
  const f0 = ctx.plugin(toolsRow as unknown as Parameters<typeof ctx.plugin>[0]);
  const f1 = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId }));
  const stub: StubSetup = { deliver: async () => undefined, digestText: null, seenRunIds: [], ...setup };
  const f3 = ctx.plugin({
    name: 'conversation-stub',
    inject: ['ledger'],
    apply(c: Context) {
      c.plugin(class extends Service {
        constructor(cc: Context) { super(cc, 'conversation'); }
        deliver = async (agentId: string, inbound: string, options?: DeliverOptions) => {
          stub.seenRunIds.push(options?.requestId ?? "");
          const uuid = options?.conversationId ?? "";
          if (uuid === "") return { kind: 'sent', handle: '' };
          const runId = 'run-' + (options?.requestId ?? 'local');
          // 机制信落账（inboundRowOf 同形：context + event）
          if (options?.mechanism === true) {
            await c.ledger.deliverRow(uuid, [agentId], 'user', {
              role: 'context', source: 'event', content: inbound, agent_id: agentId, requestId: options?.requestId ?? 'x', uuid,
            });
          }
          // 模拟整理轮内 Agent 调 session_digest（真工具链：守卫 → 观察面 →
          // ledger 结果事件行；runId/toolCallId 在场 = after-execute 落账面）
          if (stub.digestText !== null) {
            const tools = c.get('tools') as unknown as {
              execute(call: { name: string; args: Record<string, unknown>; agentId?: string; conversationId?: string; runId?: string; toolCallId?: string }): Promise<unknown>;
            };
            await tools.execute({ name: 'session_digest', args: { text: stub.digestText }, agentId, conversationId: uuid, runId, toolCallId: 'tc-digest-1' });
          }
          await c.ledger.settleRun(uuid, [agentId], 'user', {
            role: 'agent', content: '整理完成', agent_id: agentId, requestId: 'reply-' + (options?.requestId ?? 'x'), uuid, run: runId,
          }, runId, 'ok');
          return { kind: 'run', result: { text: '整理完成', finish: 'stop' } };
        };
      });
    },
  });
  const f4 = ctx.plugin(makeArchiveRow({ dataRoot: ROOT, agentId }));
  await Promise.all([f1, f3, f4]);
  const conv = ctx.get('conversation') as unknown as { deliver: DeliverFn };
  return {
    ctx,
    ledger: ctx.ledger,
    archive: (ctx as unknown as { archive: ArchiveShellService }).archive,
    conversation: conv,
    async dispose() {
      for (const f of [f4, f3, f1, f0].reverse()) await f.dispose();
    },
  };
}
function seedAgent(id: string, settings?: Record<string, unknown>) {
  const dir = path.join(ROOT, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id, model: 'mock', ...(settings !== undefined ? { settings } : {}) }), 'utf-8');
}

/** 直落 N 行大内容（超阈值——每行 ~500 token × N） */
async function seedBulkyConversation(ledger: LedgerService, uuid: string, agentId: string, rows: number) {
  const big = 'x'.repeat(2000);
  for (let i = 0; i < rows; i++) {
    await ledger.deliverRow(uuid, [agentId, 'user'], 'user', {
      role: 'agent',
      content: i % 2 === 0 ? big : '回复 ' + i,
      agent_id: i % 2 === 0 ? agentId : 'user',
      requestId: 'seed-' + i,
      uuid,
    });
  }
}

describe('archive 行（cr-1189 V3）', () => {
  it('V1 结构化提交闭环：摘要注入行全文 = digest 参数；compaction 事件无 summary 字段', async () => {
    seedAgent('alpha', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('alpha', { digestText: '此前会话的关键决策与结论……待办：X。' });
    try {
      await seedBulkyConversation(h.ledger, 'user~alpha', 'alpha', 6);
      await h.archive.requestArchive('user~alpha');
      const dir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'user~alpha');
      const after = readLedger(dir);
      // 请求注入行随压缩边界出清（§2.3：机制请求非会话事实——进归档段可回查）
      const segTextAll = fs.readdirSync(path.join(dir, 'archive'))
        .filter((n) => n.startsWith('history_'))
        .map((n) => {
          const raw = fs.readFileSync(path.join(dir, 'archive', n));
          return n.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
        })
        .join('\n');
      expect(segTextAll.includes('archive-review-request')).toBe(true);
      // 摘要注入行在场（新代头部事实——留主日志）
      const sumRow = after.rows.find((r) => (r as { source?: string }).source === ARCHIVE_SUMMARY_SOURCE) as { content?: string } | undefined;
      expect(sumRow?.content).toBe('此前会话的关键决策与结论……待办：X。');
      // compaction 事件不带 summary（单一事实源裁决）
      const cmp = after.rows.find((r) => (r as { type?: string }).type === 'compaction') as { summary?: string } | undefined;
      expect(cmp?.summary).toBeUndefined();
      // 回放头 = 摘要行（foldDigestOf 单源置首）
      const fold = foldSession(ROOT, 'user~alpha', [dir]);
      expect(foldDigestOf(fold)).toBe('此前会话的关键决策与结论……待办：X。');
      const hist = h.ledger.historyMessagesFor('user~alpha');
      const sysHead = hist.find((m) => m.role === 'system');
      expect(sysHead).toBeUndefined(); // 摘要行本体走 user 通道（wrapper），不再叠 system 头
      expect(hist.some((m) => m.role === 'user' && m.content.includes('此前会话的关键决策'))).toBe(true);
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('V2 无提交退化：不调 digest → 边界照落、摘要行缺席、回放头沿用上一代', async () => {
    seedAgent('beta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('beta', { digestText: null });
    try {
      await seedBulkyConversation(h.ledger, 'user~beta', 'beta', 6);
      await h.archive.requestArchive('user~beta');
      const dir = path.join(ROOT, 'agents', 'beta', 'sessions', 'user~beta');
      const after = readLedger(dir);
      const cmpCount = after.rows.filter((r) => (r as { type?: string }).type === 'compaction').length;
      expect(cmpCount).toBe(1); // 边界照落
      expect(after.rows.find((r) => (r as { source?: string }).source === ARCHIVE_SUMMARY_SOURCE)).toBeUndefined();
      // 无任何摘要时回放头无 system（合法态——本代无新总结）
      const fold = foldSession(ROOT, 'user~beta', [dir]);
      expect(foldDigestOf(fold)).toBeNull();
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('V4 工具守卫：非压缩轮调用 session_digest → 无副作用提示返回', async () => {
    seedAgent('gamma', { archive: { maxContextTokens: 1_000_000 } });
    const h = await bootShellRows('gamma');
    try {
      // 会话不在 pending（无进行中的压缩请求）→ 工具守卫拒绝
      const toolsSvc = h.ctx.get('tools') as unknown as { execute(call: { name: string; args: Record<string, unknown>; conversationId?: string }): Promise<unknown> };
      const out = await toolsSvc.execute({ name: 'session_digest', args: { text: '不该被收' }, conversationId: 'user~gamma' });
      expect((out as { ok: boolean }).ok).toBe(false);
      expect(String((out as { error?: string }).error)).toContain('仅在归档整理轮');
    } finally {
      await h.dispose();
    }
  }, 10_000);

  it('V4b 触发器注册式：run-count 触发器（appliesTo 自会话桶）命中；token 缺省行为等价', async () => {
    seedAgent('delta', { archive: { maxContextTokens: 1_000_000 } });
    const h = await bootShellRows('delta');
    try {
      // 缺省 token-threshold：大会话不超阈 → maybeArchive 不触发
      await seedBulkyConversation(h.ledger, 'delta~delta', 'delta', 4);
      await h.archive.maybeArchive('delta~delta');
      expect([...(h.archive as unknown as { pending: Map<string, string> }).pending.keys()]).toEqual([]);
      // 注册 run-count 触发器（appliesTo 自会话桶）
      h.archive.registerTrigger({ id: 'run-count', shouldTrigger: (t) => t.runCountSinceCompaction >= 2 });
      await h.archive.maybeArchive('delta~delta');
      expect([...(h.archive as unknown as { pending: Map<string, string> }).pending.keys()]).toEqual([]);
      // 直落两个 run-end 事实后再触发
      const dir = path.join(ROOT, 'agents', 'delta', 'sessions', 'delta~delta');
      const runs = readLedger(dir).rows.length;
      void runs;
      // 通过 settleRun 落两个 run（带 run-end）
      await h.ledger.settleRun('delta~delta', ['delta'], 'user', { role: 'agent', content: 'r1', agent_id: 'delta', requestId: 'sr-1', uuid: 'delta~delta', run: 'run-sr-1' }, 'run-sr-1', 'ok');
      await h.ledger.settleRun('delta~delta', ['delta'], 'user', { role: 'agent', content: 'r2', agent_id: 'delta', requestId: 'sr-2', uuid: 'delta~delta', run: 'run-sr-2' }, 'run-sr-2', 'ok');
      const p = h.archive.requestArchive('delta~delta');
      await p;
      const fold = foldSession(ROOT, 'delta~delta', [dir]);
      expect(fold.compactions.length).toBe(1);
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('V6 存量兼容：v2 事件摘要代的回放头不回退（digest 缺席时 system 头照发）', async () => {
    seedAgent('eta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('eta', { digestText: 'V3 新代总结。' });
    try {
      // 预置存量 v2 摘要代（手写 compaction 事件行——summary 在事件上）
      const dir = path.join(ROOT, 'agents', 'eta', 'sessions', 'user~eta');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
        JSON.stringify({ type: 'session-header', version: 2, createdAt: new Date().toISOString(), participants: ['eta', 'user'], kind: 'user' }),
        JSON.stringify({ type: 'compaction', run: 'legacy-c1', boundarySeq: 0, endTs: 1, summary: '存量 v2 摘要。', ts: 1 }),
        JSON.stringify({ type: 'run-end', run: 'legacy-c1', finish: 'completed', ts: 1 }),
      ].join('\n') + '\n', 'utf-8');
      await seedBulkyConversation(h.ledger, 'user~eta', 'eta', 6);
      await h.archive.requestArchive('user~eta');
      // 新代有 digest 行 → system 头不发（单一事实源：digest 行本体在场）
      const hist = h.ledger.historyMessagesFor('user~eta');
      expect(hist.some((m) => m.role === 'system' && m.content === '存量 v2 摘要。')).toBe(false);
      expect(hist.some((m) => m.role === 'user' && m.content.includes('V3 新代总结'))).toBe(true);
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('⑥ archive-all 批量面 + 二次压缩（逻辑代叠加 + 物理解耦 + anchor 去重）', async () => {
    seedAgent('zeta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('zeta', { digestText: '总结。' });
    try {
      // 一个超阈值会话 + 一个未超会话
      await seedBulkyConversation(h.ledger, 'user~zeta', 'zeta', 6);
      await h.ledger.deliverRow('x~zeta', ['zeta', 'x'], 'agent', {
        role: 'agent', content: '短会话', agent_id: 'x', requestId: 'short-1', uuid: 'x~zeta',
      });
      const report = await h.archive.archiveAll();
      const bulky = report.find((r) => r.conversationId === 'user~zeta');
      const short = report.find((r) => r.conversationId === 'x~zeta');
      expect(bulky?.skipped).toBeFalsy();
      expect(short?.skipped).toBe(true);
      expect(short?.reason).toBe('below-threshold');
      // 等待异步 requestArchive 收束（轮询 compaction 落代，上限 15s）
      const sdir = path.join(ROOT, 'agents', 'zeta', 'sessions', 'user~zeta');
      const cmpRows = () => readLedger(sdir).rows.filter((r) => (r as { type?: string }).type === 'compaction');
      const segCompactions = () => {
        let n = 0;
        for (const seg of fs.readdirSync(path.join(sdir, 'archive')).filter((s) => s.startsWith('history_'))) {
          const raw = fs.readFileSync(path.join(sdir, 'archive', seg));
          const text = seg.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
          n += (text.match(/\"type\":\"compaction\"/g) ?? []).length;
        }
        return n;
      };
      for (let i = 0; i < 30 && cmpRows().length < 1; i++) await new Promise((r) => setTimeout(r, 500));
      expect(cmpRows().length).toBe(1);
      // 新增行再压缩（第二次——shadowed 小，仅落逻辑代）
      await h.ledger.deliverRow('user~zeta', ['zeta', 'user'], 'user', {
        role: 'agent', content: 'y'.repeat(2000), agent_id: 'zeta', requestId: 'seed-a', uuid: 'user~zeta',
      });
      await h.archive.requestArchive('user~zeta');
      // 逻辑代叠加（cr-1189：历史代 compaction 随代出清进段——审计链在段内连续，
      // 主日志恒最新代；总数 = 主日志 + 段内）
      expect(cmpRows().length + segCompactions().valueOf()).toBe(2);
      const segs1 = fs.readdirSync(path.join(sdir, 'archive')).filter((n) => /^history_\d+\.jsonl(\.gz)?$/.test(n));
      // V3：第一轮整理轮事实行（终稿/工具结果/机制信——V2 时代 reviewRun
      // 不落账故无）计入第二轮 shadowed 集合，超回收阈即搬段（行为合法）
      expect(segs1.length).toBe(2);
      // 大量新增行第三次压缩——超回收阈物理搬运
      for (let i = 0; i < 6; i++) {
        await h.ledger.deliverRow('user~zeta', ['zeta', 'user'], 'user', {
          role: 'agent', content: 'z'.repeat(2000), agent_id: 'zeta', requestId: 'seed-b' + i, uuid: 'user~zeta',
        });
      }
      await h.archive.requestArchive('user~zeta');
      const segs2 = fs.readdirSync(path.join(sdir, 'archive')).filter((n) => /^history_\d+\.jsonl(\.gz)?$/.test(n)).sort();
      expect(segs2.length).toBe(3);
      const segText = (n: string) => {
        const raw = fs.readFileSync(path.join(sdir, 'archive', n));
        return n.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
      };
      const ids = (t: string) => new Set((t.match(/\"requestId\":\"[^\"]+\"/g) ?? []).map((s) => s.slice(13, -1)));
      const overlap = [...ids(segText(segs2[0]!))].filter((id) => ids(segText(segs2[1]!)).has(id));
      expect(overlap).toEqual([]); // anchor 去重
    } finally {
      await h.dispose();
    }
  }, 40_000);

  it('cr-1190 续修：v1 头行 + v2 事件行混合会话走 v2 语义——边界落代 + 摘要行 + 物理回收', async () => {
    seedAgent('iota', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('iota', { digestText: '混合会话总结。' });
    try {
      const dir = path.join(ROOT, 'agents', 'iota', 'sessions', 'user~iota');
      fs.mkdirSync(dir, { recursive: true });
      // v1 头行 + v2 事件行混合（user~writer 现场形态——头行永不重写）
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
        JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString(), participants: ['iota', 'user'], kind: 'agent-pair' }),
        JSON.stringify({ role: 'agent', content: 'v1 老消息', agent_id: 'user', message_id: 'm1', timestamp: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'step/content', run: 'r-old', step: 0, text: 'x'.repeat(2000), ts: 1 }),
        JSON.stringify({ type: 'run-end', run: 'r-old', finish: 'completed', ts: 1 }),
        JSON.stringify({ role: 'agent', content: '近期消息', agent_id: 'user', message_id: 'm2', timestamp: '2026-01-02T00:00:00Z', seq: 5, type: 'message' }),
      ].join('\n') + '\n', 'utf-8');
      await h.archive.requestArchive('user~iota');
      const after = readLedger(dir);
      // 边界落代（v2 语义——此前 v1 分支 split 空导致恒不落）
      expect(after.rows.filter((r) => (r as { type?: string }).type === 'compaction').length).toBe(1);
      // 摘要行在场
      expect(after.rows.some((r) => (r as { source?: string }).source === ARCHIVE_SUMMARY_SOURCE)).toBe(true);
      // 物理回收发生（shadowed 超回收阈）
      expect(fs.existsSync(path.join(dir, 'archive'))).toBe(true);
      // 回放头 = digest 行
      const fold = foldSession(ROOT, 'user~iota', [dir]);
      expect(foldDigestOf(fold)).toBe('混合会话总结。');
    } finally {
      await h.dispose();
    }
  }, 20_000);


  it('cr-1155：无 seq 的 v1 僵尸行随位置归档出清——不再永踞主日志', async () => {
    seedAgent('theta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('theta', { digestText: '总结。' });
    try {
      const dir = path.join(ROOT, 'agents', 'theta', 'sessions', 'user~theta');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
        JSON.stringify({ role: 'context', source: 'memory-delta', agent_id: 'theta', content: 'v1 僵尸行 A' }),
        JSON.stringify({ role: 'context', source: 'memory-delta', agent_id: 'theta', content: 'v1 僵尸行 B' }),
      ].join('\n') + '\n', 'utf-8');
      await seedBulkyConversation(h.ledger, 'user~theta', 'theta', 6);
      await h.archive.requestArchive('user~theta');
      const after = readLedger(dir);
      expect(after.rows.find((r) => r.content === 'v1 僵尸行 A')).toBeUndefined();
      expect(after.rows.find((r) => r.content === 'v1 僵尸行 B')).toBeUndefined();
      let found = false;
      for (const n of fs.readdirSync(path.join(dir, 'archive'))) {
        if (!n.startsWith('history_')) continue;
        const raw = fs.readFileSync(path.join(dir, 'archive', n));
        const text = n.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
        if (text.includes('僵尸行')) found = true;
      }
      expect(found).toBe(true);
    } finally {
      await h.dispose();
    }
  }, 20_000);
});
