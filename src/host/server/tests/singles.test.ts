// ============================================================
// P3 测试：SinglesService（独立会话）—— CRUD/校验/路径隔离
// + paths 三形态会话键 + HistoryService.queryDialog
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  chatDialogKey, groupDialogKey, singleDialogKey,
  isGroupDialog, isSingleDialog, sessionIdOfDialog, counterpartOfDialog,
} from '@agentchat/agents';
import { SinglesService } from '../src/singles';
import { HistoryService } from '../src/history-service';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-singles-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 假 registry：alpha 实体、user 虚拟 */
const fakeRegistry = {
  get: (id: string) => (id === 'alpha' ? { agent_id: 'alpha' } : id === 'user' ? { agent_id: 'user', virtual: true } : undefined),
  listIds: () => ['alpha', 'user'],
};

function makeService(pools: Record<string, unknown> = { deepseek: { provider: 'deepseek', model: 'x' } }): SinglesService {
  return new SinglesService({ wsRoot: tmp, registry: fakeRegistry, llmPools: () => pools });
}

describe('paths 三形态会话键', () => {
  it('chat/group/single 构造与判别互不重叠', () => {
    expect(chatDialogKey('b', 'a')).toBe('chat~a~b');
    expect(groupDialogKey('g1', 'alpha')).toBe('group~g1~alpha');
    expect(singleDialogKey('s1')).toBe('single~s1');

    expect(isGroupDialog('group~g1~alpha')).toBe(true);
    expect(isGroupDialog('single~s1')).toBe(false);
    expect(isSingleDialog('single~s1')).toBe(true);
    expect(isSingleDialog('chat~a~b')).toBe(false);
    expect(sessionIdOfDialog('single~abc-123')).toBe('abc-123');
  });

  it('counterpartOfDialog：single → 会话 id（会话级隔离记忆）', () => {
    expect(counterpartOfDialog('single~s1', 'alpha')).toBe('s1');
    expect(counterpartOfDialog('chat~alpha~user', 'user')).toBe('alpha');
    expect(counterpartOfDialog('group~g1~alpha', 'alpha')).toBe('group~g1');
  });
});

describe('SinglesService CRUD', () => {
  it('create：写 session.json（uuid 目录）；list/get 可见', () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha', title: '试一会话' });
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.agentId).toBe('alpha');
    expect(info.status).toBe('active');
    expect(fs.existsSync(path.join(tmp, 'singles', info.id, 'session.json'))).toBe(true);
    expect(svc.list()).toHaveLength(1);
    expect(svc.get(info.id)?.title).toBe('试一会话');
  });

  it('create 校验：Agent 不存在 / 虚拟 Agent / 池引用不存在 → 拒绝', () => {
    const svc = makeService();
    expect(() => svc.create({ agentId: 'ghost' })).toThrow(/不存在/);
    expect(() => svc.create({ agentId: 'user' })).toThrow(/虚拟/);
    expect(() => svc.create({ agentId: 'alpha', model: 'no-such-pool' })).toThrow(/模型池引用/);
    // 对象形态（内嵌/$ref）原样接受
    expect(svc.create({ agentId: 'alpha', model: { $ref: 'deepseek', temperature: 0.2 } }).model).toEqual({ $ref: 'deepseek', temperature: 0.2 });
    // 无池目录（llmPools 缺省）→ 字符串引用放行（运行时 resolveLLMPool 兜底）
    const bare = new SinglesService({ wsRoot: tmp, registry: fakeRegistry });
    expect(bare.create({ agentId: 'alpha', model: 'any' }).model).toBe('any');
  });

  it('create：空 Agent 快速创建（P4）→ update 补齐 / 清空', () => {
    const svc = makeService();
    const info = svc.create({});
    expect(info.agentId).toBe('');
    expect(info.status).toBe('active');
    // 补齐 Agent
    expect(svc.update(info.id, { agentId: 'alpha' }).agentId).toBe('alpha');
    // 清空（回到待选）
    expect(svc.update(info.id, { agentId: '' }).agentId).toBe('');
    // 清空后非法 Agent 仍拒绝
    expect(() => svc.update(info.id, { agentId: 'ghost' })).toThrow(/不存在/);
  });

  it('isEmpty / delete：空会话判定 + 硬删清目录', () => {
    const svc = makeService();
    const empty = svc.create({});
    // 空白唯一不变量：随后创建会话会清理遗留空会话——此处直接再选 Agent 规避
    // （create({agentId}) 触发 purge），改为直接落盘构造第二个会话
    const usedRaw = {
      id: '00000000-0000-4000-8000-000000000001',
      agentId: 'alpha',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    };
    fs.mkdirSync(path.join(tmp, 'singles', usedRaw.id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'singles', usedRaw.id, 'session.json'), JSON.stringify(usedRaw), 'utf8');
    const usedId = usedRaw.id;

    // 空 = 未选 Agent 且无消息
    expect(svc.isEmpty(empty.id)).toBe(true);
    expect(svc.isEmpty(usedId)).toBe(false); // 已选 Agent
    expect(svc.isEmpty('ghost')).toBe(false);

    // 有消息的会话不是空会话（即使 agentId 为空——规则 1 禁止中途清空 Agent，
    // 该形态由落盘直接构造：空会话先写消息文件）
    const msgFileEmpty = svc.messagesFileOf(empty.id);
    fs.mkdirSync(path.dirname(msgFileEmpty), { recursive: true });
    fs.writeFileSync(msgFileEmpty, '{"role":"user","content":"hi"}\n', 'utf8');
    expect(svc.isEmpty(empty.id)).toBe(false);

    // 硬删：元数据目录 + 消息目录全清
    const msgFile = svc.messagesFileOf(usedId);
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, '{"role":"user","content":"hi"}\n', 'utf8');
    svc.delete(usedId);
    expect(svc.get(usedId)).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'singles', usedId))).toBe(false);
    expect(fs.existsSync(path.dirname(msgFile))).toBe(false);
    expect(() => svc.delete(usedId)).toThrow(/不存在/);
  });

  it('archive：软删置状态；消息文件保留', () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    const msgFile = svc.messagesFileOf(info.id);
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, '{"role":"user","content":"hi"}\n', 'utf8');

    const archived = svc.archive(info.id);
    expect(archived.status).toBe('archived');
    expect(fs.existsSync(msgFile)).toBe(true); // 消息保留
    expect(() => svc.archive('ghost')).toThrow(/不存在/);
  });

  it('rename：改标题 + updatedAt', () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    expect(svc.rename(info.id, '新标题').title).toBe('新标题');
    expect(() => svc.rename('ghost', 'x')).toThrow(/不存在/);
  });

  it('update：换 Agent / 换模型 / 清除模型覆盖；非法值拒绝', () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });

    // 换 Agent + 设模型
    expect(svc.update(info.id, { agentId: 'alpha', model: 'deepseek' }).model).toBe('deepseek');
    // 清除覆盖（model=null）
    const cleared = svc.update(info.id, { model: null });
    expect(cleared.model).toBeUndefined();
    expect(svc.getRecord(info.id)?.model).toBeUndefined();
    // 非法 Agent / 池引用 → 拒绝
    expect(() => svc.update(info.id, { agentId: 'ghost' })).toThrow(/不存在/);
    expect(() => svc.update(info.id, { agentId: 'user' })).toThrow(/虚拟/);
    expect(() => svc.update(info.id, { model: 'no-such-pool' })).toThrow(/模型池引用/);
    expect(() => svc.update('ghost', { agentId: 'alpha' })).toThrow(/不存在/);
  });

  it('规则 1：已有消息的会话禁止换预设/Agent（同值免检放行）', () => {
    const svc = makeService();
    const info = svc.create({ agentId: 'alpha' });
    // 无消息：可换
    expect(svc.update(info.id, { agentId: 'alpha' }).agentId).toBe('alpha');

    // 写入消息（非空文件 = 有消息）
    const msgFile = svc.messagesFileOf(info.id);
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, '{"role":"user","content":"hi"}\n', 'utf8');
    expect(svc.hasMessages(info.id)).toBe(true);

    // 换 Agent / 清空 → 拒绝
    expect(() => svc.update(info.id, { agentId: 'alpha2' })).toThrow(/不能更换预设/);
    expect(() => svc.update(info.id, { agentId: '' })).toThrow(/不能更换预设/);
    // 同值（no-op）放行：不改归属
    expect(svc.update(info.id, { agentId: 'alpha' }).agentId).toBe('alpha');
    // 其他字段不受锁影响
    expect(svc.update(info.id, { title: '新标题', model: 'deepseek' }).title).toBe('新标题');
    // 空文件（0 字节）不算有消息
    const info2 = svc.create({ agentId: 'alpha' });
    const f2 = svc.messagesFileOf(info2.id);
    fs.mkdirSync(path.dirname(f2), { recursive: true });
    fs.writeFileSync(f2, '', 'utf8');
    expect(svc.hasMessages(info2.id)).toBe(false);
    expect(svc.update(info2.id, { agentId: '' }).agentId).toBe('');
  });

  it('workspaceId：创建/更新挂载用户工作区（目录校验；悬空引用容忍）', () => {
    const wsDir = path.join(tmp, 'ws-folders', 'proj');
    fs.mkdirSync(wsDir, { recursive: true });
    const workspaces = {
      get: (id: string) => (id === 'ws-1' ? { id: 'ws-1' } : null),
    };
    const svc = new SinglesService({ wsRoot: tmp, registry: fakeRegistry, workspaces });

    // 创建时挂载 + 校验
    const info = svc.create({ agentId: 'alpha', workspaceId: 'ws-1' });
    expect(info.workspaceId).toBe('ws-1');
    expect(svc.getRecord(info.id)?.workspaceId).toBe('ws-1');
    expect(() => svc.create({ agentId: 'alpha', workspaceId: 'ghost-ws' })).toThrow(/工作区/);

    // 更新：换工作区 / 移入未分组；工作区删除后悬空引用可清不可换新鬼
    expect(svc.update(info.id, { workspaceId: 'ws-1' }).workspaceId).toBe('ws-1');
    expect(() => svc.update(info.id, { workspaceId: 'ghost-ws' })).toThrow(/工作区/);
    expect(svc.update(info.id, { workspaceId: '' }).workspaceId).toBeUndefined();

    // 未提供目录（缺省）→ 不校验（测试桩/独立部署）
    const bare = makeService();
    expect(bare.create({ workspaceId: 'any' }).workspaceId).toBe('any');
  });

  it('空白会话全局唯一：create 先清理遗留空会话；有消息/已选 Agent 的不受影响', () => {
    const svc = makeService();
    // 两个遗留空会话（模拟历史堆积：绕过 create 守卫直接落盘两个）
    const legacy1 = svc.create({});
    void legacy1;
    // 再补一个：先制造非空场景挡住 purge，再恢复为空——直接写第二个空目录
    const raw = {
      id: '00000000-0000-4000-8000-000000000002',
      agentId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    };
    fs.mkdirSync(path.join(tmp, 'singles', raw.id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'singles', raw.id, 'session.json'), JSON.stringify(raw), 'utf8');
    expect(svc.list().filter(s => svc.isEmpty(s.id))).toHaveLength(2);

    // 已选 Agent 的会话 + 有消息的会话（不被清理）
    const withAgent = svc.create({ agentId: 'alpha' });
    const withMsg = svc.create({});
    const f = svc.messagesFileOf(withMsg.id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"role":"user","content":"hi"}\n', 'utf8');

    // 新建（非空白）：清理两个空会话，其余保留
    svc.create({ agentId: 'alpha' });
    const remaining = svc.list().map(s => s.id);
    expect(remaining).toContain(withAgent.id);
    expect(remaining).toContain(withMsg.id);
    expect(remaining).not.toContain(legacy1.id);
    expect(remaining).not.toContain(raw.id);
    // 空会话此刻为 0
    expect(svc.list().filter(s => svc.isEmpty(s.id))).toHaveLength(0);
  });

  it('list：lastActivity 来自消息文件 mtime；按 createdAt 倒序', async () => {
    const svc = makeService();
    const a = svc.create({ agentId: 'alpha' });
    await new Promise((r) => setTimeout(r, 20));
    const b = svc.create({ agentId: 'alpha' });
    const list = svc.list();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list.every((s) => s.lastActivity === undefined)).toBe(true); // 无消息

    const msgFile = svc.messagesFileOf(a.id);
    fs.mkdirSync(path.dirname(msgFile), { recursive: true });
    fs.writeFileSync(msgFile, '{"role":"user","content":"hi"}\n', 'utf8');
    expect(svc.get(a.id)?.lastActivity).toBeDefined();
  });

  it('损坏/缺失 session.json → get 返回 null（不抛）', () => {
    const svc = makeService();
    expect(svc.get('ghost')).toBeNull();
    fs.mkdirSync(path.join(tmp, 'singles', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'singles', 'broken', 'session.json'), '{broken');
    expect(svc.get('broken')).toBeNull();
    expect(svc.list()).toHaveLength(0);
  });
});

describe('HistoryService.queryDialog（single~ 键查询）', () => {
  it('按 dialogId 读 messages.jsonl + 轮次分页 + 补稳定 message_id', async () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const dir = path.join(tmp, 'sessions', singleDialogKey(sid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      JSON.stringify({ role: 'user', content: '第一问', agent_id: 'user', timestamp: '2026-08-19T10:00:00Z' }),
      JSON.stringify({ role: 'agent', content: '第一答', agent_id: 'alpha', timestamp: '2026-08-19T10:00:01Z' }),
      JSON.stringify({ role: 'user', content: '第二问', agent_id: 'user', timestamp: '2026-08-19T10:01:00Z' }),
      JSON.stringify({ role: 'agent', content: '第二答', agent_id: 'alpha', timestamp: '2026-08-19T10:01:01Z' }),
    ].join('\n') + '\n', 'utf8');

    const svc = new HistoryService({ wsRoot: tmp });
    // limit=1 快速路径 = 最后一轮
    const last = await svc.queryDialog(singleDialogKey(sid), { viewerId: 'user', limit: 1 });
    expect(last.map((m) => m.content)).toEqual(['第二问', '第二答']);
    // 全量（limit 覆盖）正序 + message_id 补齐
    const all = await svc.queryDialog(singleDialogKey(sid), { viewerId: 'user', limit: 10 });
    expect(all).toHaveLength(4);
    expect(all.every((m) => typeof m.message_id === 'string')).toBe(true);
    // 不存在的会话 → []
    expect(await svc.queryDialog('single~not-exist', { viewerId: 'user' })).toEqual([]);
  });
});
