// ============================================================
// durable-interaction service 测试 —— cordis Service + 事件
// ============================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { Context } from '@agentchat/cordis';
import { DurableInteractionService, type DurableInteraction } from '../src';

describe('DurableInteractionService', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('默认 memory 后端并发布 opened/replied/closed 事件', () => {
    const ctx = new Context();
    const service = new DurableInteractionService(ctx);
    const events: Array<{ name: string; record: DurableInteraction }> = [];
    ctx.on('durable-interaction/opened', (record) => events.push({ name: 'opened', record }));
    ctx.on('durable-interaction/replied', (record) => events.push({ name: 'replied', record }));
    ctx.on('durable-interaction/closed', (record) => events.push({ name: 'closed', record }));

    const record = service.open({ key: 'k', kind: 'ask', payload: { q: 'Q' } });
    expect(service.openCount).toBe(1);
    service.reply(record.id, 'A');
    service.close(record.id, 'consumed');

    expect(events.map(e => e.name)).toEqual(['opened', 'replied', 'closed']);
    expect(service.get(record.id)?.state).toBe('closed');
  });

  it('configure 切换 jsonl 后端并恢复 pending', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-durable-svc-'));
    dirs.push(dir);
    const file = path.join(dir, 'interactions.jsonl');
    const ctx = new Context();
    const service = new DurableInteractionService(ctx);
    service.configure({ backend: 'jsonl', file, fsync: true });

    const id = service.open({ key: 'k', kind: 'ask', payload: { q: 'Q' } }).id;
    const afterCrash = new DurableInteractionService(new Context());
    afterCrash.configure({ backend: 'jsonl', file });
    expect(afterCrash.listOpen().map(r => r.id)).toEqual([id]);
    expect(afterCrash.openCount).toBe(1);
  });

  it('jsonl 后端缺少 file 配置时显式报错', () => {
    const service = new DurableInteractionService(new Context());
    expect(() => service.configure({ backend: 'jsonl' })).toThrow(/file/);
  });
});
