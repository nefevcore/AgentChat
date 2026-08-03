// 社交活动归档（#2 自对话 + #3 群聊参与）—— 路径与周号计算验证
import { describe, it, expect } from 'vitest';

// 复制 isoWeekKey 逻辑（与 extension.ts 一致）—— ISO 8601 周号
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // 周一=0 ... 周日=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // 移到本周四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

describe('ISO 周号（群聊参与归档按周分片）', () => {
  it('常规日期', () => {
    expect(isoWeekKey(new Date('2026-08-03T12:00:00Z'))).toBe('2026-W32'); // 8/3 周一
    expect(isoWeekKey(new Date('2026-08-09T12:00:00Z'))).toBe('2026-W32'); // 8/9 周日（同周）
  });

  it('跨年边界', () => {
    expect(isoWeekKey(new Date('2025-12-31T12:00:00Z'))).toBe('2026-W01'); // 周三属 2026 第一周
    expect(isoWeekKey(new Date('2026-01-04T12:00:00Z'))).toBe('2026-W01'); // 1/4 周日
    expect(isoWeekKey(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02'); // 1/5 周一
  });

  it('年初边界', () => {
    expect(isoWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // 1/1 周四
  });
});

describe('社交归档路径', () => {
  it('自对话归档路径：sessions/<A>/<A>/archive/self_YYYY-MM-DD.jsonl', () => {
    // 仅验证路径组合规则（不依赖实际文件系统）
    const agent = 'agent_chat_dev';
    const day = '2026-08-03';
    const p = `${agent}/${agent}/archive/self_${day}.jsonl`;
    expect(p).toBe('agent_chat_dev/agent_chat_dev/archive/self_2026-08-03.jsonl');
  });

  it('群聊参与归档路径：sessions/<A>/group__<群ID>/archive/history_YYYY-WW.jsonl', () => {
    const agent = 'news';
    const group = '2f50872c-60b7-4412-b532-49255d4fcfd3';
    const week = '2026-W32';
    const p = `${agent}/group__${group}/archive/history_${week}.jsonl`;
    expect(p).toBe(`news/group__${group}/archive/history_2026-W32.jsonl`);
  });
});
