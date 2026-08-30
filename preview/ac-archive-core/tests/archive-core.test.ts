// ============================================================
// ac-archive-core：估算 / 阈值 / 尾部截断（工具对不拆）/ 去重分割
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ARCHIVE_BUDGETS,
  dedupCutoff,
  estimateMessagesTokens,
  keepBudgetOf,
  safeSplitIdx,
  splitForArchive,
  thresholdOf,
  truncateByTokenBudget,
  truncateTail,
  type ArchiveMessage,
} from '../src/index.ts';

/** 中文文本：每字 0.6 token（估算器口径），n 字 ≈ ceil(n*0.6) */
function zh(n: number): string {
  return '话'.repeat(n);
}

const msg = (role: string, content: string, message_id?: string): ArchiveMessage => ({
  role,
  content,
  ...(message_id ? { message_id } : {}),
});

describe('ac-archive-core 估算与阈值', () => {
  it('estimateMessagesTokens：仅计 content（CJK 0.6/字）', () => {
    expect(estimateMessagesTokens([{ content: zh(10) }, { content: zh(10) }])).toBe(12); // 2×ceil(6)
    expect(estimateMessagesTokens([{ content: '' }, { content: null }])).toBe(0);
  });

  it('thresholdOf / keepBudgetOf：预算推导', () => {
    const b = { ...DEFAULT_ARCHIVE_BUDGETS, maxContextTokens: 1000, archiveTokenRatio: 0.5, keepRecentRatio: 0.03 };
    expect(thresholdOf(b)).toBe(500);
    expect(keepBudgetOf(b)).toBe(30);
  });
});

describe('ac-archive-core 尾部截断', () => {
  it('truncateByTokenBudget：从尾部累积到预算', () => {
    const ms = [msg('user', zh(100)), msg('assistant', zh(10)), msg('user', zh(10))];
    const kept = truncateByTokenBudget(ms, 12); // 预算 12 token ≈ 20 字
    expect(kept).toHaveLength(2); // 末两条（各 6 token）留下，首条（60）弹出
  });

  it('safeSplitIdx：分割点落在 tool 消息 → 回退到配对 assistant(tool_calls) 之前', () => {
    const ms: ArchiveMessage[] = [
      msg('user', 'q1'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', content: 'r1', tool_call_id: 'c1' },
      msg('assistant', 'a1'),
    ];
    expect(safeSplitIdx(ms, 2)).toBe(1); // tool 位置 → 回退到 assistant(tool_calls)
    expect(safeSplitIdx(ms, 3)).toBe(3); // 非-tool 位置不动
    expect(safeSplitIdx(ms, 0)).toBe(0); // 边界不动
  });

  it('truncateTail：预算截断后不拆 tool-call/response 对', () => {
    const ms: ArchiveMessage[] = [
      msg('user', zh(100)),
      msg('assistant', zh(100)),
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', content: '结果', tool_call_id: 'c1' },
      msg('assistant', '终答'),
    ];
    const kept = truncateTail(ms, 3); // 极小预算 → 尽量少留
    // 任何保留都必须以完整工具对出现：tool 在则其 assistant(tool_calls) 也在
    const toolIdx = kept.findIndex((m) => m.role === 'tool');
    if (toolIdx >= 0) {
      expect(kept[toolIdx - 1].role).toBe('assistant');
      expect(Array.isArray(kept[toolIdx - 1].tool_calls)).toBe(true);
    }
    expect(kept.at(-1)?.content).toBe('终答');
  });
});

describe('ac-archive-core 去重与分割', () => {
  it('dedupCutoff：message_id 精确匹配优先', () => {
    const ms = [msg('user', 'a', 'm1'), msg('assistant', 'b', 'm2'), msg('user', 'c', 'm3')];
    expect(dedupCutoff(ms, msg('assistant', 'b', 'm2'))).toBe(2);
    expect(dedupCutoff(ms, msg('assistant', '不同内容', 'm2'))).toBe(2); // id 优先于 content
    expect(dedupCutoff(ms, null)).toBe(0);
    expect(dedupCutoff(ms, msg('user', '不在流中', 'mx'))).toBe(0);
  });

  it('dedupCutoff：无 id 时 role+content 兜底', () => {
    const ms = [msg('user', 'a'), msg('assistant', 'b')];
    expect(dedupCutoff(ms, msg('assistant', 'b'))).toBe(2);
  });

  it('splitForArchive：archive = 去重后截断前；keep = 尾部水位', () => {
    const budgets = { ...DEFAULT_ARCHIVE_BUDGETS, maxContextTokens: 1000, keepRecentRatio: 0.03 };
    // 4 条大消息 + 1 条小尾巴；预算 30 token ≈ 50 字
    const ms = [
      msg('user', zh(100), 'm1'),
      msg('assistant', zh(100), 'm2'),
      msg('user', zh(100), 'm3'),
      msg('assistant', zh(100), 'm4'),
      msg('user', '小尾巴', 'm5'),
    ];
    const split = splitForArchive(ms, budgets, msg('user', zh(100), 'm1'));
    expect(split.cutoff).toBe(1); // m1 已被上次归档覆盖
    expect(split.keep.map((m) => m.message_id)).toEqual(['m5']); // 尾部水位只留小尾巴
    expect(split.archive.map((m) => m.message_id)).toEqual(['m2', 'm3', 'm4']); // 去重后、截断前
    expect(split.truncStart).toBe(4);
  });

  it('splitForArchive：无上次归档时 cutoff=0（全量）', () => {
    const budgets = { ...DEFAULT_ARCHIVE_BUDGETS, maxContextTokens: 100, keepRecentRatio: 0.5 };
    const ms = [msg('user', zh(100), 'm1'), msg('assistant', zh(100), 'm2')];
    const split = splitForArchive(ms, budgets, null);
    expect(split.cutoff).toBe(0);
    expect(split.keep).toHaveLength(1); // 预算 50（软上限 75）→ 只留末条（60 token）
    expect(split.archive.map((m) => m.message_id)).toEqual(['m1']);
  });
});
