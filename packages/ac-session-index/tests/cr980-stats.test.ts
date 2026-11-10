// ============================================================
// cr980-stats.test.ts —— stat 面入账 / 账面聚合 / 清账（cr-980）
//
// runs/snapshot 指纹零盘读的基础件：refreshStats 只 stat 不读内容；
// catalog 按 conv 聚合；倒退（compact 式）清锚 + 指针行不残双份；
// drop 全清。指针面（refreshConversation）与 stat 面交错后的完整性。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex } from '../src/core.ts';

let root: string;
let dbFile: string;
const openIdx: SessionIndex[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-index-stats-'));
  dbFile = path.join(root, 'index', 'session-index.db');
});
afterEach(() => {
  for (const idx of openIdx.splice(0)) idx.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function newIndex(): SessionIndex {
  const idx = new SessionIndex(dbFile);
  openIdx.push(idx);
  return idx;
}

function writeSession(domain: string, convId: string, lines: { messages?: string[]; subcalls?: string[] }): void {
  const dir = path.join(root, domain === 'viewer' ? path.join('viewer', 'sessions') : path.join('agents', domain, 'sessions'), convId);
  fs.mkdirSync(dir, { recursive: true });
  if (lines.messages !== undefined) fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.messages.join('\n') + '\n');
  if (lines.subcalls !== undefined) fs.writeFileSync(path.join(dir, 'subcalls.jsonl'), lines.subcalls.join('\n') + '\n');
}

const msg = (i: number) => JSON.stringify({ role: 'agent', agent_id: 'a1', content: '行' + i, message_id: 'm' + i, timestamp: '2026-11-10T00:00:0' + (i % 10) + 'Z' });

describe('cr-980 · stat 面入账 / 账面聚合 / 清账', () => {
  it('refreshStats 只 stat：catalog 聚合 size/mtime（零内容入账——records 表仍空）', () => {
    writeSession('a1', 'c1', { messages: [msg(1), msg(2)], subcalls: [] });
    const idx = newIndex();
    idx.refreshStats(root, 'c1');
    const cat = idx.catalog();
    expect(cat).toHaveLength(1);
    expect(cat[0]!.conv).toBe('c1');
    const dir = path.join(root, 'agents', 'a1', 'sessions', 'c1');
    const sizeOnDisk = fs.statSync(path.join(dir, 'messages.jsonl')).size + fs.statSync(path.join(dir, 'subcalls.jsonl')).size;
    expect(cat[0]!.size).toBe(sizeOnDisk); // 全部源文件聚合（subcalls 空载荷也计入）
    // 指针面未入账（consumed=0）——subcallLines 走 undefined 回落而非假空集
    expect(idx.subcallLines(root, 'c1', 'a1', 'r1')).toBeUndefined();
  });

  it('追加后 refreshStats 步进账面；指针面随后增量入账无双份', () => {
    writeSession('a1', 'c1', { messages: [msg(1)] });
    const idx = newIndex();
    idx.refreshStats(root, 'c1');
    const before = idx.catalog()[0]!;
    fs.appendFileSync(path.join(root, 'agents', 'a1', 'sessions', 'c1', 'messages.jsonl'), msg(2) + '\n');
    idx.refreshStats(root, 'c1');
    const after = idx.catalog()[0]!;
    expect(after.size).toBeGreaterThan(before.size);
    // 指针面首次全量入账（consumed=0 → 整读），无残留双份
    const rep1 = idx.refreshConversation(root, 'c1');
    expect(rep1.appended).toBe(2);
    // 再次 stat + 指针刷新：无新行
    idx.refreshStats(root, 'c1');
    expect(idx.refreshConversation(root, 'c1').appended).toBe(0);
  });

  it('倒退（compact 重写变小）→ 锚与指针行清：再入账不残双份', () => {
    writeSession('a1', 'c1', { messages: [msg(1), msg(2), msg(3)] });
    const idx = newIndex();
    idx.refreshConversation(root, 'c1'); // 指针面全量入账 3 行
    // compact 重写（变小 + 新 mtime）——需确保 mtime 前移
    const file = path.join(root, 'agents', 'a1', 'sessions', 'c1', 'messages.jsonl');
    fs.writeFileSync(file, msg(1) + '\n');
    const st = fs.statSync(file);
    fs.utimesSync(file, new Date(st.atimeMs + 5000), new Date(st.mtimeMs + 5000));
    idx.refreshStats(root, 'c1');
    // 锚已清 → catalog 该 conv 从 files 表消失（直到再入账）
    expect(idx.catalog().find((c) => c.conv === 'c1')).toBeUndefined();
    // 再 stat 入账 + 指针面全量重建 → 单份 1 行
    idx.refreshStats(root, 'c1');
    const rep = idx.refreshConversation(root, 'c1');
    expect(rep.appended).toBe(1);
    expect(idx.refreshConversation(root, 'c1').appended).toBe(0);
  });

  it('messagesCatalog 与逐域 messages.jsonl stat 聚合同公式（跨域含 viewer 兼容窗）', () => {
    writeSession('a1', 'c1', { messages: [msg(1)] });
    writeSession('viewer', 'c1', { messages: [msg(2)], subcalls: [] });
    writeSession('a1', 'c2', { messages: [msg(3), msg(4)] });
    const idx = newIndex();
    idx.refreshStats(root, 'c1');
    idx.refreshStats(root, 'c2');
    const cat = new Map(idx.messagesCatalog().map((r) => [r.conv, r]));
    const expectOf = (cid: string, domains: string[]) => {
      let size = 0;
      let mtimeMs = 0;
      for (const d of domains) {
        const dir = d === 'viewer'
          ? path.join(root, 'viewer', 'sessions', cid)
          : path.join(root, 'agents', d, 'sessions', cid);
        const st = fs.statSync(path.join(dir, 'messages.jsonl'));
        size += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
      expect(cat.get(cid)).toEqual({ conv: cid, size, mtimeMs });
    };
    expectOf('c1', ['a1', 'viewer']);
    expectOf('c2', ['a1']);
    // 无 messages 文件的会话不在账面（journal-only 域——与 ledgerFingerprint null 同义）
    expect(cat.has('ghost')).toBe(false);
  });

  it('drop：目录消失后账面与指针行全清', () => {
    writeSession('a1', 'c1', { messages: [msg(1)] });
    const idx = newIndex();
    idx.refreshConversation(root, 'c1');
    expect(idx.catalog()).toHaveLength(1);
    idx.drop('c1');
    expect(idx.catalog()).toHaveLength(0);
    expect(idx.refreshConversation(root, 'c1').appended).toBe(1); // 重建可恢复（纯缓存）
  });
});
