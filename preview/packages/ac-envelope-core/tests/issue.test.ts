// ============================================================
// R-1 签发面单测（M8.4）：UUIDv7 形状 / 时间有序 / 唯一性
// ============================================================
import { describe, it, expect } from 'vitest';
import { uuidv7, issueConversationId, issueRequestId } from '../src/issue.ts';

describe('R-1 签发面', () => {
  it('UUIDv7 形状：36 字符连字符格式 + version 7 + variant 10', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('时间有序：后签发 > 先签发（字典序 = 时间序——会话列表排序键）', async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 4)); // 跨毫秒
    const b = uuidv7();
    expect(b > a).toBe(true);
  });

  it('高并发唯一性：同毫秒 1000 次无碰撞（随机位承载）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(1000);
  });

  it('issueConversationId / issueRequestId 各自独立签发', () => {
    expect(issueConversationId()).toMatch(/-7/);
    expect(issueRequestId()).toMatch(/-4/); // UUIDv4（crypto.randomUUID）
  });
});
