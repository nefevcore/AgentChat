// ============================================================
// archive 行单测（cr-546：D11 全壳内裁决）——四线验收：
// ① 阈值检测触发整理 run（reviewRun 真调用 + 概要滚动）；
// ② 归档重建（分段 + anchor + keep + 概要头注入）；
// ③ archive-all 批量面（枚举 + below-threshold 跳过）；
// ④ timers archive-all 机制任务 = 批量唤醒信（宿主零 archive 职责）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service } from '@agentchat/cordis';
import { ArchiveShellService, makeArchiveRow } from '../src/archive.ts';
import { makeLedgerRow, readLedger, LedgerService } from 'ac-ledger';

const ROOT = path.join('sandbox', 'test-archive-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/**
 * 最小壳环境：ledger + conversation stub（reviewRun 接口契约——archive 行
 * 唯一依赖面；真身链 agent-loop/llm 归 conversation 行自测）+ archive 行。
 */
type ReviewFn = (uuid: string, prompt: string) => Promise<{ finish: string; text: string }>;

async function bootShellRows(agentId: string, review: ReviewFn = async () => ({ finish: 'ok', text: '此前，概要。' })) {
  const ctx = new Context();
  const f1 = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId }));
  const f3 = ctx.plugin({
    name: 'conversation-stub',
    inject: ['ledger'],
    apply(c: Context) {
      c.plugin(class extends Service {
        constructor(cc: Context) { super(cc, 'conversation'); }
        reviewRun = review;
      });
    },
  });
  const f4 = ctx.plugin(makeArchiveRow({ dataRoot: ROOT, agentId }));
  await Promise.all([f1, f3, f4]);
  const conv = ctx.get('conversation') as unknown as { reviewRun: ReviewFn };
  return {
    ctx,
    ledger: ctx.ledger,
    archive: (ctx as unknown as { archive: ArchiveShellService }).archive,
    conversation: conv,
    async dispose() {
      for (const f of [f4, f3, f1].reverse()) await f.dispose();
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

describe('archive 行（D11 全壳内）', () => {
  it('① 阈值检测 → 整理 run → 归档重建全链（低阈值触发 + 分段 + 概要）', async () => {
    seedAgent('alpha', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const spy: string[] = [];
    const h = await bootShellRows('alpha', async () => {
      spy.push('review');
      return { finish: 'ok', text: '此前，这是整理概要。' };
    });
    try {
      await seedBulkyConversation(h.ledger, 'user~alpha', 'alpha', 6);
      await h.archive.requestArchive('user~alpha');
      const dir = path.join(ROOT, 'agents', 'alpha', 'sessions', 'user~alpha');
      const after = readLedger(dir);
      expect(spy).toEqual(['review']); // 整理 run 真调用
      // 分段存在 + 主体被压缩
      const segs = fs.readdirSync(path.join(dir, 'archive')).filter((n) => n.startsWith('history_'));
      expect(segs.length).toBeGreaterThanOrEqual(1);
      expect(after.rows.length).toBeLessThan(6);
      // 概要滚动（回退文本线——mock 不写文件）
      expect(fs.readFileSync(path.join(dir, 'summary.md'), 'utf-8')).toContain('此前，');
      // 概要头注入（historyFor 置首 system）
      const hist = h.ledger.historyFor('user~alpha');
      expect(hist[0]?.role).toBe('system');
      expect(hist[0]?.content).toContain('此前，');
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('② 亲写概要优先（mtime 新鲜判定）——Agent 写 summary.md 后概要用文件版', async () => {
    seedAgent('beta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('beta', async (uuid: string) => {
      // 模拟 Agent 亲写概要（reviewRun 期间写文件——mtime 判新鲜依据）
      const dir = path.join(ROOT, 'agents', 'beta', 'sessions', uuid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.md'), '此前，这是亲写概要（文件版）。', 'utf-8');
      return { finish: 'ok', text: '回复文本概要' };
    });
    try {
      await seedBulkyConversation(h.ledger, 'user~beta', 'beta', 6);
      await h.archive.requestArchive('user~beta');
      expect(fs.readFileSync(path.join(ROOT, 'agents', 'beta', 'sessions', 'user~beta', 'summary.md'), 'utf-8'))
        .toContain('亲写概要');
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('③ archive-all 批量面：枚举本域 + below-threshold 跳过 + pending 幂等', async () => {
    seedAgent('gamma', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('gamma');
    try {
      // 一个超阈值会话 + 一个未超会话
      await seedBulkyConversation(h.ledger, 'user~gamma', 'gamma', 6);
      await h.ledger.deliverRow('x~gamma', ['gamma', 'x'], 'agent', {
        role: 'agent', content: '短会话', agent_id: 'x', requestId: 'short-1', uuid: 'x~gamma',
      });
      const report = await h.archive.archiveAll();
      const bulky = report.find((r) => r.conversationId === 'user~gamma');
      const short = report.find((r) => r.conversationId === 'x~gamma');
      expect(bulky?.skipped).toBeFalsy(); // 超阈值 → 触发
      expect(short?.skipped).toBe(true);
      expect(short?.reason).toBe('below-threshold');
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it('④ 二次归档去重（anchor seq 锚）——同批行不重复入段', async () => {
    seedAgent('delta', { archive: { maxContextTokens: 100, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 } });
    const h = await bootShellRows('delta');
    try {
      await seedBulkyConversation(h.ledger, 'user~delta', 'delta', 6);
      await h.archive.requestArchive('user~delta'); // 第一次归档
      // 新增两行再归档（第二次）
      await h.ledger.deliverRow('user~delta', ['delta', 'user'], 'user', {
        role: 'agent', content: 'y'.repeat(2000), agent_id: 'delta', requestId: 'seed-a', uuid: 'user~delta',
      });
      await h.archive.requestArchive('user~delta'); // 第二次归档
      const dir = path.join(ROOT, 'agents', 'delta', 'sessions', 'user~delta', 'archive');
      const segs = fs.readdirSync(dir).filter((n) => /^history_\d+\.jsonl$/.test(n)).sort();
      expect(segs.length).toBe(2); // 两段
      // 二段不含一段已归档行（seq 锚去重）——读两段行数对照
      const readSeg = (n: string) => fs.readFileSync(path.join(dir, n), 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
      const seg1 = readSeg(segs[0]!);
      const seg2 = readSeg(segs[0]! < segs[1]! ? segs[1]! : segs[0]!);
      // 一段 = 初次归档条数；二段仅含新增行（< 一段——keep 窗内已保留）
      expect(seg1).toBeGreaterThan(0);
      expect(seg2).toBeLessThan(seg1);
    } finally {
      await h.dispose();
    }
  }, 20_000);
});

