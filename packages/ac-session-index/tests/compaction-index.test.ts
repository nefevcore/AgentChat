// ============================================================
// compaction-index.test.ts —— 压缩回收后的索引对账（cr-974 §2.3/S5）
// 归档重写（shrink）+ compaction 事件追加后：refreshConversation 首刷
// 必须 loud 重建（rebuilt 命中该文件），再刷幂等（零追加零重建）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex } from '../src/core.ts';
import { LedgerWriter, sessionDir } from 'ac-ledger';

const ROOT0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cmp-idx-'));
const ROOT = ROOT0;
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('压缩回收后的索引对账（cr-974）', () => {
  it('归档重写 → 首刷重建、再刷幂等；指纹随重写翻转', async () => {
    const uuid = 'conv-ci';
    const w = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), { participants: ['alpha', 'user'], kind: 'user' });
    for (let i = 0; i < 6; i++) {
      await w.deliver({ role: 'agent', content: '行' + i, agent_id: i % 2 === 0 ? 'user' : 'alpha', requestId: 'r' + i, uuid });
    }
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const fp0 = idx.fingerprintOf(ROOT, uuid).fingerprint;
      // 归档重写：前三行搬压缩段（S5 白名单），后三行留主日志
      const rows = fs.readFileSync(path.join(sessionDir(ROOT, 'alpha', uuid), 'messages.jsonl'), 'utf-8')
        .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      const seqNum = (r: Record<string, unknown>) => Number(r.seq ?? 0);
      const boundary = seqNum(rows.find((r) => r.content === '行2') ?? {});
      await w.compaction('cmp-1', '此前：前三行已整理。', boundary);
      await w.compact({
        archive: rows.filter((r) => seqNum(r) <= boundary),
        keep: rows.filter((r) => seqNum(r) > boundary),
        baselineSeq: Math.max(...rows.map(seqNum)),
        compress: true,
      });
      const rebuild = idx.refreshConversation(ROOT, uuid);
      expect(rebuild.rebuilt.some((f) => f.endsWith('messages.jsonl'))).toBe(true); // shrink → loud 重建
      const steady = idx.refreshConversation(ROOT, uuid);
      expect(steady.appended).toBe(0);
      expect(steady.rebuilt).toEqual([]);
      const fp1 = idx.fingerprintOf(ROOT, uuid).fingerprint;
      expect(fp1).not.toBe(fp0); // 指纹随重写翻转（短路自动失效）
    } finally {
      idx.close();
    }
  });
});
