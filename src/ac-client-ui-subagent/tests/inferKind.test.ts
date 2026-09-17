// ============================================================
// inferKind.test.ts —— 卡片 kind 判定纯函数验收
//
// ① 显式 action 键精确分发（新 output 单源）；
// ② 历史结构猜回落（旧记录无 action 键）——重点防两处旧误判回归：
//    await idle 态落 spawn、sync send 带结果落 await；
// ③ kill 已从词表删除（action=kill 的错误结果走 ok:false 纯文本）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { inferKind } from '../client/ToolResult/inferKind.ts';

describe('inferKind：显式 action 键（新 output 单源）', () => {
  it.each([
    ['spawn', { action: 'spawn', subagent_id: 'sub_1', status: 'running' }],
    ['spawn', { action: 'spawn', subagent_id: 'sub_1', status: 'done', result: 'x', elapsed_ms: 100 }],
    ['send', { action: 'send', subagent_id: 'sub_1', delivered: 'started', status: 'running' }],
    ['send', { action: 'send', subagent_id: 'sub_1', delivered: 'started', status: 'done', result: 'x' }],
    ['await', { action: 'await', subagent_id: 'sub_1', status: 'idle', message: '尚未运行过' }],
    ['await', { action: 'await', subagent_id: 'sub_1', status: 'done', result: 'x' }],
    ['list', { action: 'list', active_count: 0, total: 0, subagents: [] }],
    ['stop', { action: 'stop', subagent_id: 'sub_1', stopped: true }],
    ['delete', { action: 'delete', subagent_id: 'sub_1', deleted: true }],
  ] as const)('%s ← %j', (expected, data) => {
    expect(inferKind(data as Record<string, unknown>)).toBe(expected);
  });

  it('显式 action 优先于结构（同形冲突时按 action）', () => {
    // spawn 阻塞等待带 result——结构猜会判 await，显式 spawn 胜出
    expect(inferKind({ action: 'spawn', subagent_id: 'sub_1', status: 'done', result: 'x' })).toBe('spawn');
  });
});

describe('inferKind：历史结构猜回落（旧记录无 action 键）', () => {
  it('list 形（subagents / active_count）', () => {
    expect(inferKind({ active_count: 2, total: 5, subagents: [] })).toBe('list');
    expect(inferKind({ subagents: [{ id: 'sub_1' }] })).toBe('list');
  });

  it('旧误判修复：sync send 带结果（delivered + result）→ send（不再落 await）', () => {
    expect(inferKind({ subagent_id: 'sub_1', delivered: 'started', status: 'done', result: 'x', elapsed_ms: 10 })).toBe('send');
  });

  it('await 带结果 → await；stop/delete 布尔 → 各自', () => {
    expect(inferKind({ subagent_id: 'sub_1', status: 'done', result: 'x', elapsed_ms: 10 })).toBe('await');
    expect(inferKind({ subagent_id: 'sub_1', error: '超时' })).toBe('await');
    expect(inferKind({ subagent_id: 'sub_1', stopped: true })).toBe('stop');
    expect(inferKind({ subagent_id: 'sub_1', deleted: true })).toBe('delete');
  });

  it('spawn 消息态（无 result/error/delivered）→ spawn 兜底', () => {
    expect(inferKind({ subagent_id: 'sub_1', status: 'running', message: '已创建并启动' })).toBe('spawn');
  });

  it('空/空对象 → spawn 兜底（不炸）', () => {
    expect(inferKind(undefined)).toBe('spawn');
    expect(inferKind(null)).toBe('spawn');
    expect(inferKind({})).toBe('spawn');
  });
});

describe('inferKind：kill 词表已删', () => {
  it('action=kill 不再是合法 kind（走 ok:false 纯文本渲染）', () => {
    expect(inferKind({ action: 'kill', subagent_id: 'sub_1' })).not.toBe('kill');
    expect(inferKind({ action: 'kill', subagent_id: 'sub_1' })).toBe('spawn'); // 未知 action → 结构猜
  });
});
