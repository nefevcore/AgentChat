// ============================================================
// M7.1 历史读纯库单测：增量读往返 / watch 双平台 / 列表扫描
// ============================================================
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLedgerFrom, watchLedger, listSessions } from '../src/history.ts';
import { LedgerWriter, sessionDir } from 'ac-ledger';

const ROOT = path.join('sandbox', 'test-webui-' + process.pid);

function cleanup(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

describe('M7.1 readLedgerFrom 增量读', () => {
  it('全量读 → 锚点增量 → 追加后只交付新行（含撕裂行语义）', async () => {
    cleanup();
    const dir = sessionDir(ROOT, 'alpha', 'u-inc');
    const writer = new LedgerWriter(dir, { participants: ['alpha', 'user'], kind: 'user' });
    await writer.deliver({ role: 'agent', content: '第一条', agent_id: 'user', requestId: 'r1', uuid: 'u-inc' });
    // 全量读
    const first = readLedgerFrom(dir, 0);
    expect(first.rows).toHaveLength(1);
    expect(first.header?.participants).toEqual(['alpha', 'user']);
    expect(first.anchor).toBeGreaterThan(0);
    // 追加两行
    await writer.deliver({ role: 'agent', content: '第二条', agent_id: 'user', requestId: 'r2', uuid: 'u-inc' });
    await writer.deliver({ role: 'agent', content: '第三条', agent_id: 'user', requestId: 'r3', uuid: 'u-inc' });
    // 增量读（锚点 = 上次 anchor）
    const second = readLedgerFrom(dir, first.anchor);
    expect(second.rows.map((r) => r.content)).toEqual(['第二条', '第三条']);
    expect(second.header).toBeNull(); // 增量语义：header 已交付过
    expect(second.anchor).toBeGreaterThan(first.anchor);
  });

  it('撕裂行：手工写半行 → 增量读不产出、锚点不推进 → 补全后重读交付', () => {
    cleanup();
    const dir = sessionDir(ROOT, 'beta', 'u-tear');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '{"type":"session-header","version":1,"createdAt":"t","participants":["beta"],"kind":"user"}\n');
    const first = readLedgerFrom(dir, 0);
    expect(first.rows).toHaveLength(0);
    // 追加半行（无换行）
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"role":"agent","content":"撕裂');
    const second = readLedgerFrom(dir, first.anchor);
    expect(second.rows).toHaveLength(0);
    expect(second.anchor).toBe(first.anchor); // 锚点不动
    // 补全（加换行）
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '","agent_id":"user"}\n');
    const third = readLedgerFrom(dir, second.anchor);
    expect(third.rows.map((r) => r.content)).toEqual(['撕裂']);
  });

  it('截断重写防御：anchor 超文件长度 → 从 0 重读', () => {
    cleanup();
    const dir = sessionDir(ROOT, 'gamma', 'u-trunc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '{"type":"session-header","version":1,"createdAt":"t","participants":["gamma"],"kind":"user"}\n{"role":"agent","content":"aaa","agent_id":"user"}\n');
    const first = readLedgerFrom(dir, 0);
    expect(first.rows.map((r) => r.content)).toEqual(['aaa']);
    // 文件被截断重写（更短：行内容 'z'）——anchor 超文件长度
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '{"type":"session-header","version":1,"createdAt":"t","participants":["gamma"],"kind":"user"}\n{"role":"agent","content":"z","agent_id":"user"}\n');
    const second = readLedgerFrom(dir, first.anchor);
    expect(second.rows.map((r) => r.content)).toEqual(['z']); // 从 0 重读交付现内容
  });
});

describe('M7.1 watchLedger', () => {
  it('追加触发回调（debounce 后）+ close 停止', async () => {
    cleanup();
    const dir = sessionDir(ROOT, 'delta', 'u-watch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    let fired = 0;
    const h = watchLedger(dir, () => fired++);
    await new Promise((r) => setTimeout(r, 100)); // watch 就位
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"role":"agent","content":"x","agent_id":"user"}\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(fired).toBe(1);
    h.close();
    // close 后再追加不触发
    fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"role":"agent","content":"y","agent_id":"user"}\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(fired).toBe(1);
  });
});

describe('M7.1 listSessions', () => {
  it('扫描 agents/*/sessions/*/ + header 采样', async () => {
    cleanup();
    // alpha 一个会话
    const d1 = sessionDir(ROOT, 'alpha', 'u-1');
    const w1 = new LedgerWriter(d1, { participants: ['alpha', 'user'], kind: 'user' });
    await w1.deliver({ role: 'agent', content: 'hi', agent_id: 'user', requestId: 'r1', uuid: 'u-1' });
    // beta 空会话目录（无 messages.jsonl）
    const d2 = sessionDir(ROOT, 'beta', 'u-2');
    fs.mkdirSync(d2, { recursive: true });
    const sessions = listSessions(ROOT);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe('alpha');
    expect(sessions[0].uuid).toBe('u-1');
    expect(sessions[0].header?.participants).toEqual(['alpha', 'user']);
  });
});

afterAll(cleanup);
