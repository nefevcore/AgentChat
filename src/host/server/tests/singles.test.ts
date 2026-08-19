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
