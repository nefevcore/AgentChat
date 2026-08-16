// ============================================================
// InteractionBridge durable 适配测试 —— ask_questions 跨重启等待
// ============================================================

import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { JsonlDurableInteractionStore } from '@agentchat/durable-interaction';
import { InteractionBridge } from '../src/interactions';

describe('InteractionBridge × DurableInteractionStore', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('提问先落盘再弹窗；回答先落盘再 resolve（幂等）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const store = new JsonlDurableInteractionStore(file);
    const bus = new EventEmitter();
    const bridge = new InteractionBridge(bus, store);

    const events: any[] = [];
    bus.on('chat.interaction', (d) => events.push(d));
    const p = bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'Q', options: ['1', '2'] });
    expect(events).toHaveLength(1);
    const id = events[0].interaction_id;

    // 弹窗可见时，问题必然已经持久化（write-ahead）
    expect(store.listOpen().map(r => r.id)).toEqual([id]);

    expect(bridge.respond(id, '2')).toEqual({ ok: true });
    await expect(p).resolves.toBe('2');

    // 幂等：重启后的 bridge 再回同一问题返回 ok 且不改变答案
    const afterCrash = new InteractionBridge(new EventEmitter(), new JsonlDurableInteractionStore(file));
    expect(afterCrash.respond(id, '1')).toEqual({ ok: true });
    expect(new JsonlDurableInteractionStore(file).get(id)?.answer).toBe('2');
  });

  it('timeout_ms=0：永久等待，不装定时器；重启后 pending 可恢复', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const bridge = new InteractionBridge(new EventEmitter(), new JsonlDurableInteractionStore(file));

    void bridge.askUser({ agentId: 'a', convKey: 'user__a', question: 'Q', options: ['1'], timeoutMs: 0 });
    expect(bridge.pendingCount).toBe(1);

    const afterCrash = new InteractionBridge(new EventEmitter(), new JsonlDurableInteractionStore(file));
    expect(afterCrash.pendingCount).toBe(0); // live Promise 不跨进程，状态跨进程
    expect(afterCrash.listOpen()).toHaveLength(1);
    const record = afterCrash.listOpen()[0];
    expect(record.deadline).toBeUndefined();
    expect(afterCrash.toWireMessage(record).timeout_ms).toBe(0);
  });

  it('重启后晚到回答：durable 落盘并触发 onLateReply（唤醒/调和）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const first = new InteractionBridge(new EventEmitter(), new JsonlDurableInteractionStore(file));
    const p = first.askUser({ agentId: 'a', convKey: 'k', question: 'Q', options: ['1'], timeoutMs: 0, correlationId: 'call_1' });
    expect(p).toBeDefined();

    const lateReplies: string[] = [];
    const afterCrash = new InteractionBridge(new EventEmitter(), new JsonlDurableInteractionStore(file), {
      onLateReply: (record) => lateReplies.push(String(record.answer)),
    });
    expect(afterCrash.pendingCount).toBe(0);
    expect(afterCrash.respond(afterCrash.listOpen()[0].id, 'yes').ok).toBe(true);
    expect(lateReplies).toEqual(['yes']);
    const persisted = new JsonlDurableInteractionStore(file);
    expect(persisted.listOpen()).toHaveLength(0);
    expect(persisted.list()[0].answer).toBe('yes');
  });

  it('超时/abort 关闭持久记录，回答晚到返回 closed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const store = new JsonlDurableInteractionStore(file);
    const bridge = new InteractionBridge(new EventEmitter(), store);

    const p = bridge.askUser({ agentId: 'a', convKey: 'k', question: 'Q', options: ['1'], timeoutMs: 30 });
    await expect(p).rejects.toThrow(/超时/);
    const record = store.list()[0];
    expect(record.state).toBe('closed');
    expect(record.closedReason).toBe('timeout');
    expect(bridge.respond(record.id, '1').ok).toBe(false);
  });

  it('abortAgent 关闭该 agent 的持久 pending 并 reject live waiter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interact-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const store = new JsonlDurableInteractionStore(file);
    const bridge = new InteractionBridge(new EventEmitter(), store);

    const p = bridge.askUser({ agentId: 'a', convKey: 'k', question: 'Q', options: ['1'], timeoutMs: 0 });
    bridge.abortAgent('a');
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(store.list().every(r => r.state === 'closed')).toBe(true);
  });
});
