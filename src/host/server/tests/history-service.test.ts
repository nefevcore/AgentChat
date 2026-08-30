// ============================================================
// src/services/history-service 单元测试 —— 历史查询门面（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService, readTurnWindow, pendingTurnIndexBuilds } from '../src/history-service';
import { chatDialogKey } from '@agentchat/agents';

let tmp: string;
let tmpSeq = 0;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hist-${++tmpSeq}-`)); });
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

  it('query 归一化旧 trigger：user + source（legacyRole 标记）；新 event 原样返回', async () => {
    writeSession(tmp, 'user', 'agentA', [
      { role: 'trigger', content: '<trigger>归档提醒</trigger>', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'event', content: '定时检查', source: { kind: 'timer', form: 'hint', summary: '定时检查' }, timestamp: '2026-01-01T00:00:01.000Z' },
      { role: 'trigger', content: '历史工具结果', tool_call_id: 'call_1', name: 'query_history', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    const svc = new HistoryService({ wsRoot: tmp });
    const msgs = await svc.query({ from: 'user', to: 'agentA' });

    expect(msgs[0]).toMatchObject({ role: 'user', content: '归档提醒' });
    expect(msgs[0].source).toMatchObject({ kind: 'system', form: 'hint', legacyRole: 'trigger' });

    expect(msgs[1]).toMatchObject({ role: 'event', content: '定时检查' });
    expect(msgs[1].source).toMatchObject({ kind: 'timer', form: 'hint' });

    // 历史损坏（trigger+tool_call_id）→ tool 兜底
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
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

// ============================================================
// 轮次窗口分页 + 不可变归档 .tidx 索引
// ============================================================

describe('readTurnWindow / 归档轮次索引', () => {
  /** 多文件会话布局：main + before_archive + history_2 + history_1（时间升序） */
  function writeLayeredSession(wsRoot: string, layers: Record<string, any[]>): string {
    const dialogId = chatDialogKey('user', 'agentA');
    const dir = path.join(wsRoot, 'sessions', dialogId);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, msgs: any[]) => {
      if (msgs.length > 0) {
        const p = path.join(dir, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
      }
    };
    write('messages.jsonl', layers.main ?? []);
    write('before_archive.jsonl', layers.before ?? []);
    write(path.join('archive', 'history_2.jsonl'), layers.h2 ?? []);
    write(path.join('archive', 'history_1.jsonl'), layers.h1 ?? []);
    return dialogId;
  }

  const u = (content: string, ts: string, id?: string) =>
    ({ role: 'agent', content, agent_id: 'user', timestamp: ts, ...(id ? { message_id: id } : {}) });
  const a = (content: string, ts: string, id?: string) =>
    ({ role: 'agent', content, agent_id: 'agentA', timestamp: ts, ...(id ? { message_id: id } : {}) });

  /** 时间基点（ISO），各文件错开秒级避免同秒歧义 */
  const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

  it('深 offset 跨归档分页：索引路径与强制扫描路径逐窗口等价，且生成 .tidx', async () => {
    // 时间升序：h1 孤儿轮 → h2 轮 → before 轮 → main 轮（共 4 轮）
    const dialogId = writeLayeredSession(tmp, {
      h1: [a('h1a', T(1))],
      h2: [u('h2u', T(2)), a('h2a', T(3))],
      before: [u('bU', T(4)), a('bA', T(5))],
      main: [u('mU', T(6)), a('mA', T(7))],
    });

    // 首查触发后台索引构建（异步）：本次经扫描路径，结果即时正确
    const first = readTurnWindow(tmp, dialogId, 'user', 0, 2);
    expect(first.map((m) => m.content)).toEqual(['bU', 'bA', 'mU', 'mA']);
    await pendingTurnIndexBuilds(); // 构建完成后才断言 .tidx / 索引路径

    // 全部 (offset, limit) 组合：索引路径 == 扫描路径。
    // 第一轮可能对深 offset 触发更多文件的异步构建（本次查询经扫描兜底，
    // 结果仍等价）；等待构建完成后再跑一轮，确保比对的是真索引路径。
    const assertEquiv = () => {
      for (let offset = 0; offset <= 5; offset++) {
        for (const limit of [1, 2, 3, 10]) {
          const viaIndex = readTurnWindow(tmp, dialogId, 'user', offset, limit);
          const viaScan = readTurnWindow(tmp, dialogId, 'user', offset, limit, { noIndex: true });
          expect(viaIndex, `offset=${offset} limit=${limit}`).toEqual(viaScan);
        }
      }
    };
    assertEquiv();
    await pendingTurnIndexBuilds();
    assertEquiv();
    // 抽查期望窗口内容（新序轮：T0=[mU,mA] T1=[bU,bA] T2=[h2u,h2a] T3=[h1a]）
    const c = (msgs: any[]) => msgs.map((m) => m.content);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 0, 2))).toEqual(['bU', 'bA', 'mU', 'mA']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 1, 2))).toEqual(['h2u', 'h2a', 'bU', 'bA']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 2, 2))).toEqual(['h1a', 'h2u', 'h2a']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 3, 2))).toEqual(['h1a']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 4, 2))).toEqual([]);

    // 索引文件：仅不可变文件有；messages.jsonl 不建
    const dir = path.join(tmp, 'sessions', dialogId);
    expect(fs.existsSync(path.join(dir, 'messages.jsonl.tidx'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'before_archive.jsonl.tidx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive', 'history_2.jsonl.tidx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive', 'history_1.jsonl.tidx'))).toBe(true);
  });

  it('轮次跨文件边界：viewer 消息在归档、回复在主文件头，归入同一轮', () => {
    // 归档切割点落在 viewer 之后：before=[u1,a1]，main 头部续接 a1 的后续 aTail
    const dialogId = writeLayeredSession(tmp, {
      before: [u('u1', T(1)), a('a1', T(2))],
      main: [a('aTail', T(3))],
    });
    // 唯一一轮 = [u1, a1, aTail]
    expect(readTurnWindow(tmp, dialogId, 'user', 0, 5).map((m) => m.content))
      .toEqual(['u1', 'a1', 'aTail']);
    expect(readTurnWindow(tmp, dialogId, 'user', 1, 5)).toEqual([]);
  });

  it('跨文件时间戳倒置（真实病灶）：归档尾部比主文件头部新，交错消息不丢', () => {
    // 复刻 chat~news~user 的真实数据形态：归档重建在轮次中间切割，
    // before_archive 尾部承载了一轮的前半（ts 新于 main 头部的后半）。
    // 全量路径（全局时间排序）能拼回完整轮次；窗口路径须靠水位线校正对齐。
    const dialogId = writeLayeredSession(tmp, {
      before: [
        u('bU', T(1)), a('bA', T(2)),
        // ── 被切割的轮次前半（时间戳新于 main 头部）──
        u('splitU', T(10)), a('splitA1', T(11)), a('splitA2', T(12)),
      ],
      main: [
        // ── 该轮后半（ts 较旧但文件位置新）──
        a('splitTail', T(8)),
        u('mU', T(15)), a('mA', T(16)),
      ],
    });
    // 全局时间序：bU(1) bA(2) splitTail(8) splitU(10) splitA1(11) splitA2(12) mU(15) mA(16)
    // 轮次（viewer 链，按全局时间序）：轮1=[bU,bA,splitTail]（splitTail 时间序上
    // 先于 splitU，归入轮1）；轮2=[splitU,splitA1,splitA2]；轮3=[mU,mA]
    const c = (msgs: any[]) => msgs.map((m) => m.content);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 0, 3))).toEqual(
      ['bU', 'bA', 'splitTail', 'splitU', 'splitA1', 'splitA2', 'mU', 'mA'],
    );
    expect(c(readTurnWindow(tmp, dialogId, 'user', 0, 1))).toEqual(['mU', 'mA']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 1, 1))).toEqual(['splitU', 'splitA1', 'splitA2']);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 2, 1))).toEqual(['bU', 'bA', 'splitTail']);
    expect(readTurnWindow(tmp, dialogId, 'user', 3, 1)).toEqual([]);
  });

  it('跨文件 message_id 重复：保留较新出现，重复 viewer 不二次开轮', () => {
    // before 与 h1 出现同 id=X 的 viewer 消息（新架构按构造不重叠，此处验证语义兜底）
    const dialogId = writeLayeredSession(tmp, {
      h1: [u('hU', T(1), 'X'), a('hA', T(2))],
      before: [u('bU', T(3), 'X'), a('bA', T(4))],
      main: [u('mU', T(5))],
    });
    // 新序轮：T0=[mU] T1=[bU,bA]（bU 胜出）T2=[hA]（hU 为重复被吞，不开轮）
    // 返回时间正序：hA(T2) → bU(T3) → bA(T4) → mU(T5)
    const c = (msgs: any[]) => msgs.map((m) => m.content);
    expect(c(readTurnWindow(tmp, dialogId, 'user', 0, 10))).toEqual(['hA', 'bU', 'bA', 'mU']);
    const viaScan = readTurnWindow(tmp, dialogId, 'user', 0, 10, { noIndex: true });
    expect(c(viaScan)).toEqual(['hA', 'bU', 'bA', 'mU']);
  });

  it('归档文件被追加（size/mtime 变化）→ 索引自动重建', async () => {
    const dialogId = writeLayeredSession(tmp, {
      before: [u('b1', T(1)), a('b2', T(2))],
      main: [u('m1', T(3))],
    });
    expect(readTurnWindow(tmp, dialogId, 'user', 1, 5).map((m) => m.content)).toEqual(['b1', 'b2']);
    await pendingTurnIndexBuilds();

    // 违反不可变假设：向归档文件追加更旧一轮（mtime/size 变 → 索引失效）
    // 追加后的首查：缓存校验失败 → 退回扫描路径（结果即时正确），后台重建索引
    const before = path.join(tmp, 'sessions', dialogId, 'before_archive.jsonl');
    fs.appendFileSync(before, JSON.stringify(a('b0', T(0))) + '\n', 'utf-8');
    expect(readTurnWindow(tmp, dialogId, 'user', 1, 5).map((m) => m.content)).toEqual(['b0', 'b1', 'b2']);
    await pendingTurnIndexBuilds();
    // 重建完成后索引路径与扫描路径一致（含追加的更旧一轮）
    const viaIndex = readTurnWindow(tmp, dialogId, 'user', 1, 5);
    const viaScan = readTurnWindow(tmp, dialogId, 'user', 1, 5, { noIndex: true });
    expect(viaIndex).toEqual(viaScan);
    expect(viaIndex.map((m) => m.content)).toEqual(['b0', 'b1', 'b2']);
  });

  it('queryDialog 经索引路径分页（single 会话含归档）', async () => {
    const dialogId = 'single~s1';
    const dir = path.join(tmp, 'sessions', dialogId);
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive', 'history_1.jsonl'),
      [u('o1', T(1)), a('o2', T(2))].map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'messages.jsonl'),
      [u('n1', T(3)), a('n2', T(4))].map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');

    const svc = new HistoryService({ wsRoot: tmp });
    const c = (msgs: any[]) => msgs.map((m) => m.content);
    expect(c(await svc.queryDialog(dialogId, { viewerId: 'user', limit: 5 }))).toEqual(['o1', 'o2', 'n1', 'n2']);
    await pendingTurnIndexBuilds(); // 索引就绪后再验证深翻页（走索引路径）
    expect(c(await svc.queryDialog(dialogId, { viewerId: 'user', limit: 1 }))).toEqual(['n1', 'n2']);
    expect(c(await svc.queryDialog(dialogId, { viewerId: 'user', limit: 5 }))).toEqual(['o1', 'o2', 'n1', 'n2']);
    // 深翻页落在归档内
    expect(c(await svc.queryDialog(dialogId, { viewerId: 'user', limit: 5, offset: 1 }))).toEqual(['o1', 'o2']);
  });
});
