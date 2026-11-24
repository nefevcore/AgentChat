// ============================================================
// cr1278-attachments.test.ts —— 多模态附件旁路回归锁（cr-1278）
//
// V3 消息架构重写期，attachments 在 宿主 deliver → UserStub → 壳侧入站行
// → 账本行 → fold 回放 整段丢失；本测锁死「行 → 事件 → LlmMessage」三步：
//   ① 窄化单源 normalizeAttachments（kind/ref/上限，非法丢弃不炸轮）
//   ② v2 发言行附件随 fold 回放还原（且只在 user 位）
//   ③ v1 存量行同口径（旧会话刷新后仍可见图）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeAttachments, sessionDir } from '../src/index.ts';
import { LedgerWriter } from '../src/writer.ts';
import { foldLlmReplay, foldSession } from '../src/fold.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-attach-'));
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });

const AGENT = 'alpha';
const ATT = { kind: 'image' as const, ref: 'files/alpha/_tmp/x.png', mime: 'image/png', filename: 'x.png' };

describe('附件窄化（入口单源）', () => {
  it('合法项原样保留；缺 ref / 超长 ref / 未知 kind 丢弃；上限截断', () => {
    expect(normalizeAttachments([ATT])).toEqual([ATT]);
    expect(normalizeAttachments([{ kind: 'image' }, { kind: 'image', ref: '' }, { kind: 'image', ref: 'x'.repeat(3000) }, { kind: 'audio', ref: 'a.mp3' }])).toBeUndefined();
    expect(normalizeAttachments('not-array')).toBeUndefined();
    expect(normalizeAttachments([{ kind: 'image', ref: 'files/a.png', detail: 'weird' }])).toEqual([{ kind: 'image', ref: 'files/a.png' }]);
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'image', ref: `files/${i}.png` }));
    expect(normalizeAttachments(many)).toHaveLength(50);
  });
});

describe('回放还原（v2 发言行）', () => {
  it('入站行附件随 fold 进入 LlmMessage.user；assistant 位恒无', async () => {
    const uuid = 'conv-att-v2';
    const dir = sessionDir(ROOT, AGENT, uuid);
    const w = new LedgerWriter(dir, { participants: [AGENT, 'user'], kind: 'user' });
    await w.deliver({ role: 'agent', content: '看图', agent_id: 'user', requestId: 'q1', uuid, attachments: [ATT] });
    await w.deliver({ role: 'agent', content: '看到了', agent_id: AGENT, requestId: 'a1', uuid });
    const llm = foldLlmReplay(foldSession(ROOT, uuid), AGENT, ROOT, uuid);
    expect(llm).toHaveLength(2);
    expect(llm[0]).toMatchObject({ role: 'user', content: '看图', attachments: [ATT] });
    expect(llm[1]).toMatchObject({ role: 'assistant', content: '看到了' });
    expect(llm[1]!.attachments).toBeUndefined();
  });
});

describe('回放还原（v1 存量行）', () => {
  it('存量盘面行携带 attachments 时同口径还原（旧会话刷新后仍可见图）', () => {
    const uuid = 'conv-att-v1';
    const dir = sessionDir(ROOT, AGENT, uuid);
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    const rows = [
      { type: 'session-header', version: 1, createdAt: '2026-11-24T00:00:00.000Z', participants: [AGENT, 'user'], kind: 'user' },
      { role: 'agent', content: '看图', agent_id: 'user', requestId: 'q1', message_id: 'q1', timestamp: '2026-11-24T00:00:01.000Z', seq: 1, attachments: [ATT] },
      { role: 'agent', content: '看到了', agent_id: AGENT, requestId: 'a1', message_id: 'a1', timestamp: '2026-11-24T00:00:02.000Z', seq: 2 },
    ];
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'journal', 'partials.jsonl'), '', 'utf-8');
    const llm = foldLlmReplay(foldSession(ROOT, uuid), AGENT, ROOT, uuid);
    expect(llm[0]).toMatchObject({ role: 'user', content: '看图', attachments: [ATT] });
  });
});
