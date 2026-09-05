// ============================================================
// ac-archive-core：估算 / 阈值 / 尾部截断（工具对不拆）/ 去重分割
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ARCHIVE_BUDGETS,
  dedupCutoff,
  estimateMessagesTokens,
  estimateReplayTokens,
  keepBudgetOf,
  replayTokensOf,
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

// ============================================================
// 回放口径估算（2026-09-04 事故回归）：replayTrajectory 缺省 true 后
// LLM 上下文含 viewer 自有 steps 轨迹展开（实测 196K），content-only
// 估算只见 4.3K → 归档阈值/水位恒判"无需移出"——估算必须镜像 history()
// 的注入形状
// ============================================================
describe('ac-archive-core 回放口径估算', () => {
  /** 轨迹行：正文 zh(10)，两步（首步带 bash 调用，末步 = 正文） */
  const trajRow: ArchiveMessage = {
    role: 'agent',
    agent_id: 'a',
    content: zh(10),
    steps: [
      { content: zh(5), toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}', result: 'x'.repeat(100) }] },
      { content: zh(10) },
    ],
  };

  it('replayTokensOf：viewer 自有行按轨迹展开（步 content + 工具名/参数 + 结果 JSON；行 content 不重复计）', () => {
    // 3（zh5）+ 2（bash{}）+ 31（result 100 ASCII + JSON 引号）+ 6（末步 zh10）= 42
    expect(replayTokensOf(trajRow, 'a')).toBe(42);
  });

  it('replayTokensOf：非 viewer / 匿名读者 = 对话级 content-only', () => {
    expect(replayTokensOf(trajRow, 'b')).toBe(6);
    expect(replayTokensOf(trajRow)).toBe(6);
  });

  it('replayTokensOf：partial 行按补记齐全与否分流（与 history() 同判）', () => {
    // 工具结果补记齐全 → 视同普通轨迹行回放（中断 run 已见前缀，2026-09-04）
    expect(replayTokensOf({ ...trajRow, partial: true }, 'a')).toBe(42);
    // 悬空 tool_calls（结果缺失）→ 跳过计 0（破坏 provider 消息序的不回放）
    const dangling: ArchiveMessage = {
      ...trajRow,
      partial: true,
      steps: [
        { content: zh(5), toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}', result: undefined }] },
        { content: zh(10) },
      ],
    };
    expect(replayTokensOf(dangling, 'a')).toBe(0);
  });

  it('replayTokensOf：空 content 的 agent 行——viewer 带 steps 即保留展开（中断/max-steps 收束行），否则计 0', () => {
    // 事故形态：正文空、轨迹大（实测 448KB steps vs 1 万字符 content）——
    // 计 0 会让含中断 run 历史的会话阈值恒不触发、归档恒 0 移出
    expect(replayTokensOf({ role: 'agent', agent_id: 'a', content: '   ', steps: trajRow.steps }, 'a')).toBe(42);
    // 无 steps（或非 viewer 行）不展开 → 0
    expect(replayTokensOf({ role: 'agent', agent_id: 'a', content: '   ' }, 'a')).toBe(0);
    expect(replayTokensOf({ role: 'agent', agent_id: 'b', content: '   ', steps: trajRow.steps }, 'a')).toBe(0);
  });

  it('replayTokensOf：event 行按投递目标视点过滤（匿名读者不过滤）', () => {
    const ev: ArchiveMessage = { role: 'event', agent_id: 'b', content: zh(10) };
    expect(replayTokensOf(ev, 'a')).toBe(0); // 发给 b 的 hint 不进 a 的上下文
    expect(replayTokensOf(ev, 'b')).toBe(6);
    expect(replayTokensOf(ev)).toBe(6);
  });

  it('estimateReplayTokens：会话合计（viewer 口径 vs content-only）', () => {
    const ms = [msg('user', zh(10)), trajRow];
    expect(estimateReplayTokens(ms, 'a')).toBe(48); // 6 + 42
    expect(estimateMessagesTokens(ms)).toBe(12); // content-only 口径（对比锚）
  });

  it('splitForArchive：小 content + 大轨迹 → viewer 口径尾部水位生效（content-only 口径为 0 移出）', () => {
    const budgets = { ...DEFAULT_ARCHIVE_BUDGETS, maxContextTokens: 1000, keepRecentRatio: 0.03 }; // keep 30
    const ms: ArchiveMessage[] = [
      { role: 'user', content: zh(10), message_id: 'm1' },
      {
        role: 'agent', agent_id: 'a', content: zh(10), message_id: 'm2',
        steps: [{ content: zh(10), toolCalls: [{ name: 'bash', arguments: '{}', result: 'x'.repeat(200) }] }],
      },
      { role: 'user', content: zh(10), message_id: 'm3' },
    ];
    // 旧行为（事故形态）：content 18 ≤ 30 → 全保留、0 移出
    expect(splitForArchive(ms, budgets, null).archive).toHaveLength(0);
    // 回放口径：m2 展开 68（6+2+60）超水位 ×1.5 → m1/m2 移出、尾部留 m3
    const split = splitForArchive(ms, budgets, null, { viewer: 'a' });
    expect(split.archive.map((m) => m.message_id)).toEqual(['m1', 'm2']);
    expect(split.keep.map((m) => m.message_id)).toEqual(['m3']);
  });
});
