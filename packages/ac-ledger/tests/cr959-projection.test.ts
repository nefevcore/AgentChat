// ============================================================
// cr959-projection.test.ts —— context 直落行读面投影（cr-959）回归锁
//
// 进入 LLM 回放的 context 行在读面全量投出（用户诉求：会进入 LLM 推理的
// 上下文注入都显示，无需过滤）：
//  · 带 run 锚（journal settlement 物化 / conv-notice 形）→ projectInject
//    归口（source 保真：context 直落行的 source 原样透传，不再折成 'inject'）
//  · 无 run 锚（memory-snapshot/memory-delta before-start 直落）→ 直投
//    context 行（前端注入卡；label 缺席回落 source 词）
//  · 负例：机制行（context+event）维持事件分隔符；error 行不走注入卡。
// cr-973：viewer 物化账本退役——种子基线对话改为 agent 域 LedgerWriter
// 直落（显式递增时间戳，投影按 ts 排序）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleSessionView } from '../src/view.ts';
import { LedgerWriter, sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-cr959-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type SeedRow = { role: 'context'; content: string; agent_id: string; requestId: string; uuid: string; source?: string; label?: string; run?: string };

/** 种一段基线对话（agent 域：用户问 + run 终稿）+ 指定形状的 context 行 */
async function seed(conv: string, extra: SeedRow[]): Promise<void> {
  const w = new LedgerWriter(sessionDir(ROOT, 'alpha', conv), { participants: ['alpha', 'user'], kind: 'user' });
  await w.deliver({ role: 'agent', content: '问', agent_id: 'user', requestId: 'q-1', uuid: conv, timestamp: '2026-11-09T10:00:00.000Z' });
  await w.deliver({ role: 'agent', content: '答', agent_id: 'alpha', requestId: 'rq-a', uuid: conv, run: 'run-a', timestamp: '2026-11-09T10:00:01.000Z' });
  for (const row of extra) await w.deliver(row);
}

describe('cr-959 context 直落行读面投影', () => {
  it('无 run 锚的 memory-snapshot 直落行 → 直投 context 行（source/label 透传）', async () => {
    await seed('mem-1', [{ role: 'context', source: 'memory-snapshot', content: '快照正文\n记忆基线 seq=3', agent_id: 'alpha', requestId: 'ctx-m1', uuid: 'mem-1' }]);
    const out = assembleSessionView(ROOT, 'mem-1');
    const mem = out.find((r) => r.source === 'memory-snapshot');
    expect(mem).toMatchObject({ role: 'context', content: '快照正文\n记忆基线 seq=3', agent_id: 'alpha' });
    expect(mem!.label).toBe('memory-snapshot'); // label 缺席回落 source 词
    expect(typeof mem!.timestamp).toBe('string');
    expect(typeof mem!.message_id).toBe('string');
  });

  it('带 run 锚的 memory-delta 行 → projectInject 归口（source 保真不折成 inject）', async () => {
    await seed('mem-2', [{ role: 'context', source: 'memory-delta', content: '增量正文', label: '长期记忆增量注入', agent_id: 'alpha', requestId: 'ctx-m2', uuid: 'mem-2', run: 'run-a' }]);
    const out = assembleSessionView(ROOT, 'mem-2');
    const mem = out.find((r) => r.source === 'memory-delta');
    expect(mem).toMatchObject({ role: 'context', content: '增量正文', label: '长期记忆增量注入', agent_id: 'alpha', run: 'run-a' });
  });

  it('负例：机制行（context+event 无 run）维持事件分隔符；error 行不入注入卡', async () => {
    await seed('neg-1', [
      { role: 'context', source: 'event', content: '壳已重启完成', agent_id: 'alpha', requestId: 'restarted-1', uuid: 'neg-1' },
      { role: 'context', source: 'error', content: 'LLM 调用失败', agent_id: 'alpha', requestId: 'ctx-e1', uuid: 'neg-1' },
    ]);
    const out = assembleSessionView(ROOT, 'neg-1');
    const ev = out.find((r) => r.source === 'event' && r.role === 'event');
    expect(ev).toMatchObject({ content: '壳已重启完成' });
    expect(out.some((r) => r.source === 'error' && r.role === 'context')).toBe(false);
  });
});
