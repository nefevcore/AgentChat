// ============================================================
// durable-interaction store 测试 —— 领域无关状态机 + 崩溃恢复
// ============================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MemoryDurableInteractionStore,
  JsonlDurableInteractionStore,
  DurableInteractionConflictError,
} from '../src';

describe('MemoryDurableInteractionStore', () => {
  it('open → reply → duplicate：回答幂等且返回原回答', () => {
    const store = new MemoryDurableInteractionStore();
    const open = store.open({ key: 'k1', kind: 'ask', payload: { q: 'Q' }, id: 'i1' });
    expect(open.state).toBe('pending');

    const first = store.reply('i1', 'A');
    expect(first.status).toBe('ok');
    expect(store.get('i1')?.state).toBe('answered');

    const again = store.reply('i1', 'B');
    expect(again.status).toBe('duplicate');
    expect(again.answer).toBe('A');
    expect(store.get('i1')?.answer).toBe('A');
  });

  it('close 后 reply 返回 closed；open 冲突抛错', () => {
    const store = new MemoryDurableInteractionStore();
    store.open({ key: 'k', kind: 'ask', payload: {}, id: 'i1' });
    expect(store.close('i1', 'aborted')).toBe(true);
    expect(store.reply('i1', 'late')).toMatchObject({ status: 'closed' });
    expect(() => store.open({ key: 'k', kind: 'ask', payload: {}, id: 'i1' }))
      .toThrow(DurableInteractionConflictError);
  });

  it('open 对 payload 深拷贝：调用方后续修改不影响已提交记录', () => {
    const store = new MemoryDurableInteractionStore();
    const payload: any = { questions: ['q1'] };
    store.open({ key: 'k', kind: 'ask', payload, id: 'i1' });
    payload.questions.push('q2');
    expect((store.get('i1')!.payload as any).questions).toEqual(['q1']);
  });

  it('listOpen 过滤 key/kind/state', () => {
    const store = new MemoryDurableInteractionStore();
    store.open({ key: 'a', kind: 'ask', payload: {}, id: '1' });
    store.open({ key: 'a', kind: 'notice', payload: {}, id: '2' });
    store.open({ key: 'b', kind: 'ask', payload: {}, id: '3' });
    store.reply('2', 'ok');
    expect(store.listOpen().map(r => r.id)).toEqual(['1', '3']);
    expect(store.listOpen({ key: 'a' }).map(r => r.id)).toEqual(['1']);
    expect(store.list({ state: 'answered' }).map(r => r.id)).toEqual(['2']);
  });
});

describe('JsonlDurableInteractionStore（崩溃恢复）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-durable-'));
    file = path.join(dir, 'interactions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('open/reply/close 逐条追加；重新构造 store 恢复完整投影', () => {
    const store = new JsonlDurableInteractionStore(file);
    const open = store.open({ key: 'conv1', kind: 'ask_questions', payload: { q: 'Q' }, owner: 'agentA' });
    expect(open.id).toMatch(/^dur-/);
    store.reply(open.id, 'yes');
    const closedId = store.open({ key: 'conv2', kind: 'ask', payload: {}, id: 'closed' }).id;
    store.close(closedId, 'timeout');

    const restored = new JsonlDurableInteractionStore(file);
    expect(restored.get(open.id)?.state).toBe('answered');
    expect(restored.get(open.id)?.answer).toBe('yes');
    expect(restored.get(closedId)?.state).toBe('closed');
    expect(restored.listOpen()).toHaveLength(0);
  });

  it('pending 跨实例恢复且 reply 幂等', () => {
    const store = new JsonlDurableInteractionStore(file);
    const id = store.open({ key: 'conv', kind: 'ask', payload: { q: 'Q' } }).id;

    const afterCrash = new JsonlDurableInteractionStore(file);
    expect(afterCrash.listOpen().map(r => r.id)).toEqual([id]);
    expect(afterCrash.reply(id, 'A').status).toBe('ok');
    expect(new JsonlDurableInteractionStore(file).reply(id, 'B').status).toBe('duplicate');
  });

  it('torn tail 被忽略，已提交前缀可恢复', () => {
    const store = new JsonlDurableInteractionStore(file);
    const id = store.open({ key: 'conv', kind: 'ask', payload: { q: 'Q' } }).id;
    fs.appendFileSync(file, '{"id":"dur-torn","key":"x",'); // 半行

    const restored = new JsonlDurableInteractionStore(file);
    expect(restored.get(id)?.state).toBe('pending');
    expect(restored.get('dur-torn')).toBeUndefined();
  });

  it('fsync=false 也能工作（测试/低保证部署）', () => {
    const store = new JsonlDurableInteractionStore(file, { fsync: false });
    const id = store.open({ key: 'conv', kind: 'ask', payload: {} }).id;
    expect(new JsonlDurableInteractionStore(file).get(id)).toBeDefined();
  });
});
