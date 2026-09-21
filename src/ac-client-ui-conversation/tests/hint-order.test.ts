// ============================================================
// journal 提升行时刻还原回归（2026-11 hint 错位修复）
//
// 注入行 timestamp 必须还原 journal 落行时刻（注入真实时刻），
// 而非 settlement 铸造时刻——前端步级 ts 稳定排序据此把技能注入
// hint 排在正确步位（此前铸造时刻晚于全部步 ts → hint 排到终稿后）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';

const STEP1_TS = 1789835279246;
const INJECT_TS = 1789835280000; // 步1 后、步2 前
const STEP2_TS = 1789835287912;

const records = [
  { role: 'agent', content: '测试 load_skill', agent_id: 'user', message_id: 'm1', timestamp: '2026-09-19T16:27:46.000Z', seq: 1 },
  { role: 'agent', content: '', agent_id: 'a', message_id: 'm2', timestamp: '2026-09-19T16:29:00.100Z', seq: 2, run: 'r1', steps: [
    { content: '步1', ts: STEP1_TS, toolCalls: [] },
  ] },
  { role: 'context', content: '<system-reminder>技能正文</system-reminder>', source: 'skill', label: '已加载技能 x', agent_id: 'a', message_id: 'm3', timestamp: new Date(INJECT_TS).toISOString(), seq: 3, run: 'r1', injected: true },
  { role: 'agent', content: '', agent_id: 'a', message_id: 'm4', timestamp: '2026-09-19T16:29:00.100Z', seq: 4, run: 'r1', steps: [
    { content: '终稿文本', ts: STEP2_TS, toolCalls: [] },
  ] },
];

describe('journal 提升行时刻还原（hint 步位）', () => {
  it('注入行 timestamp = 注入时刻 → 前端排序落在步1 与终稿之间', () => {
    const out = toHistoryMessages(records as never, 'a~user');
    const brief = out.map((m) => {
      const r = m as Record<string, unknown>;
      return String(r.role) + ':' + String(r.content ?? '').slice(0, 12);
    });
    const iStep1 = brief.findIndex((x) => x.includes('步1'));
    const iHint = brief.findIndex((x) => x.startsWith('event'));
    const iFinal = brief.findIndex((x) => x.includes('终稿'));
    expect(iStep1).toBeGreaterThanOrEqual(0);
    expect(iHint).toBeGreaterThan(iStep1);
    expect(iHint).toBeLessThan(iFinal);
  });
});
