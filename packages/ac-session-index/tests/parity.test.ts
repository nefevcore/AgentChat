// ============================================================
// parity.test.ts —— 索引 ↔ 单源等价测试（cr-973 Phase 1，2026-11-09）
//
// 方案 §1.3 插槽-插头验收：摘掉索引行 → 读面回落全扫投影（慢但
// 正确）。等价面在此对拍：指纹（index.fingerprintOf ↔ historyView）
// 与 subcall 定位（index.subcallLines ↔ readSubcalls 过滤）；折叠等价
// （assembleSessionView 带 subcallsOf 钩子 vs 不带——索引加速路径与
// 全扫回落路径 records 深等，分页/lite 随之等价）。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionIndex } from '../src/core.ts';
import { LedgerWriter, assembleSessionView, historyView, readSubcalls, sessionDir } from 'ac-ledger';
import type { JournalToolResult } from 'ac-ledger';

const ROOTS: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-idx-parity-'));
  ROOTS.push(root);
  return root;
}
afterEach(() => {
  for (const r of ROOTS.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** 造一个有消息/journal/subcalls 的 agent 域会话（含两个 run） */
async function seed(root: string, agent = 'alpha', uuid = 'conv-1'): Promise<void> {
  const w = new LedgerWriter(sessionDir(root, agent, uuid), { participants: [agent, 'user'], kind: 'user' });
  await w.deliver({ role: 'agent', content: '问一句', agent_id: 'user', requestId: 'q1', uuid, timestamp: '2026-11-09T10:00:00.000Z' });
  await w.deliver({ role: 'agent', content: '答一段', agent_id: agent, requestId: 'a1', run: 'run-1', runMs: 1200, uuid, timestamp: '2026-11-09T10:00:05.000Z' });
  await w.deliver({ role: 'agent', content: '再答', agent_id: agent, requestId: 'a2', run: 'run-2', uuid, timestamp: '2026-11-09T10:01:00.000Z' });
  const dir = sessionDir(root, agent, uuid);
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  // subcalls 档案：两行 run-1、一行 run-2（journal-tool-result 判别形态）
  const lines = [
    { type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-1#1', result: { ok: true }, subcall: true, name: 'read', seq: 7 },
    { type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-1#2', result: { ok: false, error: 'x' }, subcall: true, name: 'glob', seq: 8 },
    { type: 'journal-tool-result', run: 'run-2', toolCallId: 'tc-9#1', result: { ok: true }, subcall: true, name: 'grep', seq: 9 },
  ];
  fs.writeFileSync(path.join(dir, 'subcalls.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

describe('索引 ↔ 单源等价（cr-973 §1.3）', () => {
  it('指纹：fingerprintOf 与 ac-ledger historyView 逐字节同值（跨互认短路）', async () => {
    const root = tmpRoot();
    await seed(root);
    const idx = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    try {
      const a = idx.fingerprintOf(root, 'conv-1');
      const b = historyView(root, 'conv-1');
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.domains).toEqual(b.domains);
    } finally {
      idx.close();
    }
  });

  it('subcall 定位：subcallLines(run) ≡ readSubcalls 全读过滤（seek 与全扫等价）', async () => {
    const root = tmpRoot();
    await seed(root);
    const idx = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(root, 'conv-1');
      const dir = sessionDir(root, 'alpha', 'conv-1');
      for (const run of ['run-1', 'run-2']) {
        const viaIndex = idx.subcallLines(root, 'conv-1', 'alpha', run) as unknown as JournalToolResult[];
        const viaScan = readSubcalls(dir).filter((l) => l.run === run);
        expect(viaIndex).toEqual(viaScan);
      }
      // 增量追加后仍等价（接线序 = fingerprintOf 先 refresh，再 seek；
      // 追加未入账时 subcallLines 守卫返回 undefined 回落全读——不吐陈旧行）
      fs.appendFileSync(path.join(dir, 'subcalls.jsonl'), JSON.stringify({ type: 'journal-tool-result', run: 'run-1', toolCallId: 'tc-1#3', result: { ok: true }, subcall: true, name: 'edit', seq: 10 }) + '\n', 'utf-8');
      expect(idx.subcallLines(root, 'conv-1', 'alpha', 'run-1')).toBeUndefined();
      idx.refreshConversation(root, 'conv-1');
      const viaIndex = idx.subcallLines(root, 'conv-1', 'alpha', 'run-1') as unknown as JournalToolResult[];
      expect(viaIndex).toEqual(readSubcalls(dir).filter((l) => l.run === 'run-1'));
      expect(viaIndex.at(-1)?.toolCallId).toBe('tc-1#3');
    } finally {
      idx.close();
    }
  });

  it('折叠等价：assembleSessionView 带索引钩子与全扫回落 records 深等（索引行摘除语义）', async () => {
    const root = tmpRoot();
    await seed(root);
    const idx = new SessionIndex(path.join(root, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(root, 'conv-1');
      const fallback = assembleSessionView(root, 'conv-1');
      const accelerated = assembleSessionView(root, 'conv-1', {
        subcallsOf: (domain, run) => idx.subcallLines(root, 'conv-1', domain, run) as JournalToolResult[] | undefined,
      });
      expect(accelerated).toEqual(fallback);
      // lite 投影同构等价（视图参数化——chat/plain 记录面同构，lite 截断纯函数）
      expect(assembleSessionView(root, 'conv-1', {
        view: 'lite',
        subcallsOf: (domain, run) => idx.subcallLines(root, 'conv-1', domain, run) as JournalToolResult[] | undefined,
      })).toEqual(assembleSessionView(root, 'conv-1', { view: 'lite' }));
    } finally {
      idx.close();
    }
  });
});
