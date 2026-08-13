// ============================================================
// src/services/history-service 单元测试 —— 历史查询门面（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../src/services/history-service';
import { chatDialogKey } from '../src/agents/paths';

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 写入 1:1 会话文件（新架构：sessions/chat~<lo>~<hi>/messages.jsonl） */
function writeSession(wsRoot: string, from: string, to: string, msgs: any[]): void {
  const dir = path.join(wsRoot, 'sessions', chatDialogKey(from, to));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
}

describe('HistoryService', () => {
  it('query 读会话文件：按轮次(user 链)最新在前分页、返回正序', async () => {
    // 3 轮: [m1,m2] [m3,m4] [m5,m6]
    writeSession(tmp, 'user', 'agentA', [
      { role: 'agent', content: 'm1', agent_id: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'agent', content: 'm2', agent_id: 'agentA', timestamp: '2026-01-01T00:00:01.000Z' },
      { role: 'agent', content: 'm3', agent_id: 'user', timestamp: '2026-01-01T00:00:02.000Z' },
      { role: 'agent', content: 'm4', agent_id: 'agentA', timestamp: '2026-01-01T00:00:03.000Z' },
      { role: 'agent', content: 'm5', agent_id: 'user', timestamp: '2026-01-01T00:00:04.000Z' },
      { role: 'agent', content: 'm6', agent_id: 'agentA', timestamp: '2026-01-01T00:00:05.000Z' },
    ]);
    const svc = new HistoryService({ wsRoot: tmp });

    const all = await svc.query({ from: 'user', to: 'agentA' });
    expect(all.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    // limit 按轮数：最新 2 轮
    const page = await svc.query({ from: 'user', to: 'agentA', limit: 2 });
    expect(page.map((m) => m.content)).toEqual(['m3', 'm4', 'm5', 'm6']);

    // offset 按轮数：跳过最新 1 轮 → 取剩余 2 轮
    const off = await svc.query({ from: 'user', to: 'agentA', limit: 2, offset: 1 });
    expect(off.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);

    // 跳过最新 2 轮 → 最早 1 轮
    const off2 = await svc.query({ from: 'user', to: 'agentA', limit: 2, offset: 2 });
    expect(off2.map((m) => m.content)).toEqual(['m1', 'm2']);

    // 无 user 消息的孤儿会话：整体视为 1 轮
    writeSession(tmp, 'user', 'agentB', [
      { role: 'agent', content: 'a1', agent_id: 'agentB' },
      { role: 'agent', content: 'a2', agent_id: 'agentB' },
    ]);
    const orph = await svc.query({ from: 'user', to: 'agentB', limit: 5 });
    expect(orph.map((m) => m.content)).toEqual(['a1', 'a2']);
  });

  it('query 无文件返回空数组', async () => {
    const svc = new HistoryService({ wsRoot: tmp });
    expect(await svc.query({ from: 'a', to: 'b' })).toEqual([]);
  });

  it('query 兼容旧架构 canonical 路径（sessions/<lo>/<hi>，含 archive 合并去重）', async () => {
    // 旧存储：sessions/<lo>/<hi>/messages.jsonl + archive/history_N.jsonl（编号越大越旧）
    const dir = path.join(tmp, 'sessions', 'abap', 'user');
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    // 归档编号递增（写入顺序）：history_1 最旧 → history_2 → messages.jsonl 最新
    fs.writeFileSync(path.join(dir, 'archive', 'history_1.jsonl'),
      JSON.stringify({ role: 'agent', content: 'old1', agent_id: 'user', message_id: 'id-old1' }) + '\n' +
      JSON.stringify({ role: 'agent', content: 'old2', agent_id: 'abap', message_id: 'id-old2' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'archive', 'history_2.jsonl'),
      JSON.stringify({ role: 'agent', content: 'mid1', agent_id: 'user', message_id: 'id-mid1' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'new1', agent_id: 'abap', message_id: 'id-new1' }) + '\n' +
      // 与归档重复的 message_id → 保留较新（活跃文件）
      JSON.stringify({ role: 'agent', content: 'old2-dup', agent_id: 'abap', message_id: 'id-old2' }) + '\n', 'utf-8');

    const svc = new HistoryService({ wsRoot: tmp });

    // 平铺路径不存在 → 走旧 canonical（请求方向无关，lo/hi 按字母序）
    // 去重语义：归档 id-old2 被活跃文件较新的 old2-dup 顶替（保留较新、占原位置）
    const all = await svc.query({ from: 'user', to: 'abap' });
    expect(all.map((m) => m.content)).toEqual(['old1', 'mid1', 'new1', 'old2-dup']);

    // 轮次: old1(user) 轮1=[old1]; mid1(user) 轮2=[mid1,new1,old2-dup]
    const page = await svc.query({ from: 'user', to: 'abap', limit: 2 });
    expect(page.map((m) => m.content)).toEqual(['old1', 'mid1', 'new1', 'old2-dup']);

    const off = await svc.query({ from: 'user', to: 'abap', limit: 2, offset: 1 });
    expect(off.map((m) => m.content)).toEqual(['old1']);
  });

  it('query 忽略损坏行', async () => {
    const dir = path.join(tmp, 'sessions', chatDialogKey('user', 'agentA'));
    fs.mkdirSync(dir, { recursive: true });
    // 手动写入含非法 JSON 行的文件（非 JSON.stringify 包裹的字符串）
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'ok', agent_id: 'user' }) + '\n{broken json\n', 'utf-8');
    const svc = new HistoryService({ wsRoot: tmp });
    const msgs = await svc.query({ from: 'user', to: 'agentA' });
    expect(msgs.map((m) => m.content)).toEqual(['ok']);
  });

  it('query limit=1 快速路径：只返回最后一个轮次（含轮次起点的 viewer 消息）', async () => {
    writeSession(tmp, 'user', 'agentA', [
      { role: 'agent', content: 'm1', agent_id: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'agent', content: 'm2', agent_id: 'agentA', timestamp: '2026-01-01T00:00:01.000Z' },
      { role: 'agent', content: 'm3', agent_id: 'user', timestamp: '2026-01-01T00:00:02.000Z' },
      { role: 'agent', content: 'm4', agent_id: 'agentA', timestamp: '2026-01-01T00:00:03.000Z' },
      { role: 'agent', content: 'm5', agent_id: 'user', timestamp: '2026-01-01T00:00:04.000Z' },
      { role: 'agent', content: 'm6', agent_id: 'agentA', timestamp: '2026-01-01T00:00:05.000Z' },
    ]);
    const svc = new HistoryService({ wsRoot: tmp });
    const last = await svc.query({ from: 'user', to: 'agentA', limit: 1 });
    expect(last.map((m) => m.content)).toEqual(['m5', 'm6']);
  });

  it('query limit=1 快速路径：大文件只读尾部（跨越多个 64KB 块）', async () => {
    // 每条约 200B，共 3000 条 → 约 600KB，远超单块 64KB，验证反向分块读取
    const msgs: any[] = [];
    for (let i = 0; i < 3000; i++) {
      msgs.push({
        role: 'agent',
        content: `msg-${i}-` + 'x'.repeat(180),
        agent_id: i % 3 === 0 ? 'user' : 'agentA',
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      });
    }
    writeSession(tmp, 'user', 'agentA', msgs);
    const svc = new HistoryService({ wsRoot: tmp });
    const last = await svc.query({ from: 'user', to: 'agentA', limit: 1 });
    // 最后一条 viewer 消息为 msg-2997（2997 % 3 === 0）→ 轮次 = [2997, 2998, 2999]
    expect(last.map((m) => m.content?.slice(0, 8))).toEqual(['msg-2997', 'msg-2998', 'msg-2999']);
  });

  it('query limit=1 快速路径：文件末尾无换行 + 中间损坏行均正确', async () => {
    const dir = path.join(tmp, 'sessions', chatDialogKey('user', 'agentA'));
    fs.mkdirSync(dir, { recursive: true });
    // 中间含损坏 JSON 行、末尾无 \n
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'm1', agent_id: 'user' }) + '\n' +
      '{broken json\n' +
      JSON.stringify({ role: 'agent', content: 'm2', agent_id: 'agentA' }), 'utf-8');
    const svc = new HistoryService({ wsRoot: tmp });
    const last = await svc.query({ from: 'user', to: 'agentA', limit: 1 });
    expect(last.map((m) => m.content)).toEqual(['m1', 'm2']);
  });

  it('query limit=1 快速路径：主文件为空时回退读 before_archive 尾部', async () => {
    const dir = path.join(tmp, 'sessions', chatDialogKey('user', 'agentA'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '', 'utf-8'); // 空主文件
    fs.writeFileSync(path.join(dir, 'before_archive.jsonl'),
      JSON.stringify({ role: 'agent', content: 'b1', agent_id: 'user' }) + '\n' +
      JSON.stringify({ role: 'agent', content: 'b2', agent_id: 'agentA' }) + '\n', 'utf-8');
    const svc = new HistoryService({ wsRoot: tmp });
    const last = await svc.query({ from: 'user', to: 'agentA', limit: 1 });
    expect(last.map((m) => m.content)).toEqual(['b1', 'b2']);
  });

  it('query 新路径合并归档：messages.jsonl + before_archive.jsonl + archive/history_N.jsonl（按时间排序去重）', async () => {
    const dir = path.join(tmp, 'sessions', chatDialogKey('user', 'agentA'));
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    // archive/history_1 最旧、history_2 较旧；before_archive 中间；messages.jsonl 最新
    fs.writeFileSync(path.join(dir, 'archive', 'history_1.jsonl'),
      JSON.stringify({ role: 'agent', content: 'h1', agent_id: 'agentA', timestamp: '2026-01-01T00:00:01.000Z' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'archive', 'history_2.jsonl'),
      JSON.stringify({ role: 'agent', content: 'h2', agent_id: 'agentA', timestamp: '2026-01-02T00:00:01.000Z' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'before_archive.jsonl'),
      JSON.stringify({ role: 'agent', content: 'b1', agent_id: 'user', timestamp: '2026-01-03T00:00:01.000Z' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'm1', agent_id: 'user', timestamp: '2026-01-04T00:00:01.000Z' }) + '\n' +
      JSON.stringify({ role: 'agent', content: 'm2', agent_id: 'agentA', timestamp: '2026-01-04T00:00:02.000Z' }) + '\n', 'utf-8');

    const svc = new HistoryService({ wsRoot: tmp });
    const all = await svc.query({ from: 'user', to: 'agentA' });
    // 时间升序合并: h1, h2, b1, m1, m2
    expect(all.map((m) => m.content)).toEqual(['h1', 'h2', 'b1', 'm1', 'm2']);

    // 分页按轮次: b1(user) 轮1=[b1]; m1(user) 轮2=[m1,m2]; h1/h2 为孤儿轮(agentA)
    const page = await svc.query({ from: 'user', to: 'agentA', limit: 2 });
    // 最新在前 2 轮: 轮2=[m1,m2] + 轮1=[b1] → [b1,m1,m2]
    expect(page.map((m) => m.content)).toEqual(['b1', 'm1', 'm2']);
  });

  it('deleteFromJSONL 按 message_id 删除并重写文件', async () => {
    writeSession(tmp, 'user', 'agentA', [
      { role: 'agent', content: 'm1', agent_id: 'user', message_id: 'id1' },
      { role: 'agent', content: 'm2', agent_id: 'agentA', message_id: 'id2' },
    ]);
    const svc = new HistoryService({ wsRoot: tmp });

    expect(await svc.deleteFromJSONL('user', 'agentA', 'id2')).toBe(true);
    const msgs = await svc.query({ from: 'user', to: 'agentA' });
    expect(msgs.map((m) => m.content)).toEqual(['m1']);

    expect(await svc.deleteFromJSONL('user', 'agentA', 'nope')).toBe(false);
    expect(await svc.deleteFromJSONL('user', 'ghost', 'id1')).toBe(false);
  });

  it('deleteFromJSONL 兼容旧架构 canonical 路径', async () => {
    const dir = path.join(tmp, 'sessions', 'agentA', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'm1', agent_id: 'user', message_id: 'id1' }) + '\n' +
      JSON.stringify({ role: 'agent', content: 'm2', agent_id: 'agentA', message_id: 'id2' }) + '\n', 'utf-8');
    const svc = new HistoryService({ wsRoot: tmp });

    expect(await svc.deleteFromJSONL('user', 'agentA', 'id2')).toBe(true);
    const msgs = await svc.query({ from: 'user', to: 'agentA' });
    expect(msgs.map((m) => m.content)).toEqual(['m1']);
  });

  it('requestArchive：注入归档实现时调用；未注入时降级不抛', async () => {
    const called: string[][] = [];
    const svc = new HistoryService({
      wsRoot: tmp,
      archive: async (a, b) => { called.push([a, b]); },
    });
    await svc.requestArchive('a', 'b');
    expect(called).toEqual([['a', 'b']]);

    const svc2 = new HistoryService({ wsRoot: tmp });
    await expect(svc2.requestArchive('a', 'b')).resolves.toBeUndefined();
    await expect(svc2.idleArchive('a', 'b')).resolves.toBeUndefined();
  });
});
