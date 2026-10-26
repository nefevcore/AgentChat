// ============================================================
// groups-row.test.ts —— 宿主群存储行（cr-576）：成员表 CRUD + 信封扇出
// + 成员流合并读面。邮局 = 假端口（registry 真·dispatch 捕获——扇出帧形
// 断言；registry 子集一致语义归 post-office 包测）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeGroupsHostRow } from '../src/index.ts';
import { ConversationRegistry } from 'ac-post-office';
import type { Envelope } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-host-groups-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Handler = (params: unknown) => unknown;

function seedAgent(id: string): void {
  fs.mkdirSync(path.join(ROOT, 'agents', id), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', id, 'config.json'), JSON.stringify({ id, model: 'mock' }), 'utf-8');
}

function boot() {
  const handlers = new Map<string, Handler>();
  const frames: Array<{ type: string; args?: unknown }> = [];
  const sent: Envelope[] = [];
  const po = {
    registry: new ConversationRegistry(),
    dispatch: async (env: Envelope) => { sent.push(env); return []; },
  };
  const web = {
    registerRpc: (m: string, h: Handler) => { handlers.set(m, h); },
    broadcast: (type: string, data?: unknown) => { frames.push({ type, ...(data as { args?: unknown }) }); },
  };
  const row = makeGroupsHostRow({ dataRoot: ROOT, postOffice: po as never }) as unknown as { apply(ctx: unknown): void };
  row.apply({ webServer: web });
  return { handlers, frames, sent, registry: po.registry };
}

function writeStream(member: string, key: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(ROOT, 'agents', member, 'sessions', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('宿主群存储行（成员表 CRUD）', () => {
  it('create/list/join/leave/rename/set-description + 帧广播 + 校验 fail-loud', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    const { handlers, frames } = boot();
    const create = await handlers.get('group/create')!({ name: '测试群', members: ['alpha', 'beta'], description: '简介' }) as { group: { id: string; members: string[] } };
    const gid = create.group.id;
    expect(create.group.members).toEqual(['alpha', 'beta']);
    expect(frames.at(-1)).toMatchObject({ type: 'group/created' });

    // 成员校验 / gid 词法闸 / 撞 Agent 名（同步 throw——RPC 面同义）
    expect(() => handlers.get('group/create')!({ name: 'x', members: ['ghost'] })).toThrow(/未注册/);
    expect(() => handlers.get('group/create')!({ id: 'a~b', name: 'x', members: [] })).toThrow(/非法/);
    expect(() => handlers.get('group/create')!({ id: 'alpha', name: 'x', members: [] })).toThrow(/同名/);

    const listed = await handlers.get('group/list')!({}) as { groups: Array<{ id: string }> };
    expect(listed.groups.map((g) => g.id)).toEqual([gid]);

    expect(await handlers.get('group/join')!({ groupId: gid, agentId: 'alpha' })).toEqual({ joined: true }); // 幂等（已在群 = 无 member-added 帧）
    expect(await handlers.get('group/leave')!({ groupId: gid, agentId: 'beta' })).toEqual({ left: true });
    expect(await handlers.get('group/leave')!({ groupId: gid, agentId: 'beta' })).toEqual({ left: false });
    expect(await handlers.get('group/rename')!({ groupId: gid, name: '新名' })).toEqual({ renamed: true });
    expect(await handlers.get('group/set-description')!({ groupId: gid, description: '' })).toEqual({ descriptionSet: true });
    const after = await handlers.get('group/list')!({}) as { groups: Array<{ name: string; members: string[]; description?: string }> };
    expect(after.groups[0]).toMatchObject({ name: '新名', members: ['alpha'] });
    expect(after.groups[0].description).toBeUndefined();
    expect(frames.map((f) => f.type)).toEqual(expect.arrayContaining([
      'group/created', 'group/member-removed', 'group/renamed', 'group/description-set',
    ]));
    // 不存在的群（同步 throw）
    expect(() => handlers.get('group/rename')!({ groupId: 'nope', name: 'x' })).toThrow(/不存在/);
  });
  // cr-579：入群种子（主线 seedMemberStream 语义）——既有成员流合并投影进新成员流
  it('join 新成员：既有群内容（合并去重）投影进新成员流（requestId 随行迁移）；幂等 join 不重复种', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    seedAgent('gamma');
    const { handlers } = boot();
    const gid = ((await handlers.get('group/create')!({ name: 'g', members: ['alpha', 'beta'] })) as { group: { id: string } }).group.id;
    writeStream('alpha', gid + '~alpha', [
      { role: 'agent', agent_id: 'user', content: '大家好', message_id: 'a1', requestId: 'g-r1', timestamp: '2026-10-22T01:00:00Z' },
      { role: 'agent', agent_id: 'alpha', content: '-alpha 终稿', message_id: 'a2', requestId: 'reply-g-r1', timestamp: '2026-10-22T01:00:05Z' },
    ]);
    writeStream('beta', gid + '~beta', [
      { role: 'agent', agent_id: 'user', content: '大家好', message_id: 'b1', requestId: 'g-r1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    await handlers.get('group/join')!({ groupId: gid, agentId: 'gamma' });
    // 种子异步 fire-and-forget——稍候落盘后断言（合并去重：g-r1 一行 + reply 一行，时间升序）
    await new Promise((r) => setTimeout(r, 200));
    const seeded = path.join(ROOT, 'agents', 'gamma', 'sessions', gid + '~gamma', 'messages.jsonl');
    expect(fs.existsSync(seeded)).toBe(true);
    const lines = fs.readFileSync(seeded, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'session-header', kind: 'group' });
    expect(lines.slice(1).map((l) => l.content)).toEqual(['大家好', '-alpha 终稿']);
    expect(lines.slice(1).map((l) => l.requestId)).toEqual(['g-r1', 'reply-g-r1']);
    // 幂等 join（已成员）不再种（行数不变）
    await handlers.get('group/join')!({ groupId: gid, agentId: 'gamma' });
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(seeded, 'utf-8').trim().split('\n')).toHaveLength(3);
  });
});

describe('宿主群存储行（send 扇出 + history 合并）', () => {
  it('send：除发送者外全成员各一封（成员流 uuid gid~member + 共享 requestId）；发送者不在群 fail-loud', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    const { handlers, frames, sent, registry } = boot();
    const gid = ((await handlers.get('group/create')!({ name: 'g', members: ['alpha', 'beta'] })) as { group: { id: string } }).group.id;
    // 成员流预登记（多发送方子集一致校验的输入面）
    expect(registry.lookup(gid + '~alpha')?.participants.sort()).toEqual(['alpha', 'beta', 'user']);
    const out = await handlers.get('group/send')!({ groupId: gid, from: 'user', content: '大家好' }) as { message: { from: string; content: string }; triggered: string[] };
    expect(out.triggered).toEqual(['alpha', 'beta']);
    expect(out.message).toMatchObject({ groupId: gid, from: 'user', content: '大家好' });
    expect(sent).toHaveLength(2);
    expect(sent.map((e) => e.uuid).sort()).toEqual([gid + '~alpha', gid + '~beta'].sort());
    expect(sent.every((e) => e.sender === 'user' && (e.payload as { text?: string }).text === '大家好')).toBe(true);
    expect(new Set(sent.map((e) => e.requestId)).size).toBe(1); // 同一消息共享 requestId（history 去重键）
    expect(frames.at(-1)).toMatchObject({ type: 'group/message-posted', args: [gid] });
    // 成员发言：跳过发送者
    sent.length = 0;
    const out2 = await handlers.get('group/send')!({ groupId: gid, from: 'alpha', content: '收到' }) as { triggered: string[] };
    expect(out2.triggered).toEqual(['beta']);
    expect(sent).toHaveLength(1);
    // send 是 async handler（扇出 await）——错误以 rejected promise 形态抛出
    await expect(handlers.get('group/send')!({ groupId: gid, from: 'outsider', content: 'x' })).rejects.toThrow(/不在群内/);
  });

  it('history：全成员流合并（跨流同 requestId 去重 + 成员终稿各留各的）+ 尾部分页', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    const { handlers } = boot();
    const gid = ((await handlers.get('group/create')!({ name: 'g', members: ['alpha', 'beta'] })) as { group: { id: string } }).group.id;
    // 同一条用户消息在两条成员流各有一行（同 requestId）+ alpha 的终稿只在 alpha 流
    writeStream('alpha', gid + '~alpha', [
      { role: 'agent', agent_id: 'user', content: '大家好', message_id: 'a1', requestId: 'g-r1', timestamp: '2026-10-22T01:00:00Z' },
      { role: 'agent', agent_id: 'alpha', content: '-alpha 终稿', message_id: 'a2', requestId: 'reply-g-r1', timestamp: '2026-10-22T01:00:05Z' },
    ]);
    writeStream('beta', gid + '~beta', [
      { role: 'agent', agent_id: 'user', content: '大家好', message_id: 'b1', requestId: 'g-r1', timestamp: '2026-10-22T01:00:00Z' },
    ]);
    const hist = await handlers.get('group/history')!({ groupId: gid }) as { messages: Array<{ id: string; from: string; content: string; at: number }> };
    expect(hist.messages).toEqual([
      { id: 'g-r1', groupId: gid, from: 'user', content: '大家好', at: Date.parse('2026-10-22T01:00:00Z') },
      { id: 'reply-g-r1', groupId: gid, from: 'alpha', content: '-alpha 终稿', at: Date.parse('2026-10-22T01:00:05Z') },
    ]);
    // 尾部分页
    const page = await handlers.get('group/history')!({ groupId: gid, limit: 1, offset: 0 }) as { messages: unknown[] };
    expect(page.messages).toHaveLength(1);
    expect((page.messages[0] as { content: string }).content).toBe('-alpha 终稿');
    // leave 清成员流；delete 清群目录 + 全成员流
    await handlers.get('group/leave')!({ groupId: gid, agentId: 'beta' });
    expect(fs.existsSync(path.join(ROOT, 'agents', 'beta', 'sessions', gid + '~beta'))).toBe(false);
    await handlers.get('group/delete')!({ groupId: gid });
    expect(fs.existsSync(path.join(ROOT, 'groups', gid))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'agents', 'alpha', 'sessions', gid + '~alpha'))).toBe(false);
    expect(await handlers.get('group/delete')!({ groupId: gid })).toEqual({ deleted: false });
  });
});
