// ============================================================
// lite-project.test.ts —— D2 读投影单源化（cr-95）：
// liteProjectRecords 语义（截断/标记/零变异）+ records({view:"lite"})
// 接线。缓存零变异纪律在此锁定（cr-55 病理的构造防复发）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { liteProjectRecords } from 'ac-session';

const LONG = 'x'.repeat(5 * 1024);
const BIG_RESULT = { blob: 'y'.repeat(10 * 1024) };

const rec = (over: Record<string, unknown> = {}) => ({
  role: 'agent', content: '答', agent_id: 'a', message_id: 'm1',
  steps: [{ content: '', reasoning: LONG, toolCalls: [{ id: 't1', name: 'read', arguments: LONG, result: BIG_RESULT }] }],
  ...over,
} as never);

describe('liteProjectRecords（投影语义 + 零变异）', () => {
  it('超长 reasoning/arguments 截断为摘要，result 换 truncated 摘要对象', () => {
    const out = liteProjectRecords([rec()], 1024);
    const step = (out[0] as any).steps[0];
    expect(step.reasoning).toMatch(/^x{1024}…\[\+4096B 截断\]$/);
    expect(step.toolCalls[0].arguments).toMatch(/^x{1024}…\[\+4096B 截断\]$/);
    expect(step.toolCalls[0].resultTruncated).toBe(true);
    expect(step.toolCalls[0].result).toMatchObject({ truncated: true });
    expect((step.toolCalls[0].result as any).preview.startsWith('{"blob":"yyy')).toBe(true);
  });

  it('零变异：输入 records 对象（含嵌套 steps/toolCalls）原样——缓存不可写纪律', () => {
    const input = rec();
    const snapshot = JSON.stringify(input);
    liteProjectRecords([input], 512);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('短字段原样直通（不截断不拷贝 steps 之外的键）', () => {
    const short = { role: 'user', content: 'hi', message_id: 'm0' } as never;
    const out = liteProjectRecords([short]);
    expect(out[0]).toBe(short); // 无 steps 的行对象身份不变（直通）
  });
});