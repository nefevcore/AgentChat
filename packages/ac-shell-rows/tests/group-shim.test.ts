// ============================================================
// cr-712 垫片面单测：AgentsShim.has / SessionShim.history / GroupShim
//（send_group 壳内接通——群读面单源 ac-core-utils + 方案 A 广播扇出）。
// 数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { AgentsShim, SessionShim, GroupShim } from '../src/shims.ts';
import { makeLedgerRow, readLedger } from 'ac-ledger';
import type { Envelope } from 'ac-envelope-core';

const ROOT = path.resolve('sandbox/group-shim-test-' + process.pid);
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(id: string): void {
  const dir = path.join(ROOT, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id, model: 'mock-1' }), 'utf-8');
}

function seedGroup(gid: string, members: string[]): void {
  const dir = path.join(ROOT, 'groups', gid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'group.json'), JSON.stringify({ id: gid, name: '群-' + gid, members, createdAt: 1 }), 'utf-8');
}

/** 假 conversation 服务（捕获 sendEnvelope——群扇出投递面） */
class FakeConversation extends Service {
  sent: Envelope[] = [];
  constructor(c: Context) { super(c, 'conversation'); }
  async sendEnvelope(env: Envelope): Promise<void> { this.sent.push(env); }
}

/** 壳树（shims + ledger + 假 conversation）——history/group 消费链同 boot */
async function bootShell(agentId: string): Promise<{ ctx: Context; fibers: Fiber[]; agents: AgentsShim; session: SessionShim; group: GroupShim; conversation: FakeConversation }> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const ledgerFiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId }));
  fibers.push(ledgerFiber);
  await ledgerFiber;
  const convFiber = ctx.plugin(class extends FakeConversation {
    constructor(c: Context) { super(c); }
  } as never, undefined as never);
  fibers.push(convFiber);
  await convFiber;
  const agents = new AgentsShim(ctx, ROOT);
  const session = new SessionShim(ctx);
  const group = new GroupShim(ctx, ROOT, 'pipe-test');
  return { ctx, fibers, agents, session, group, conversation: ctx.get('conversation', false) as unknown as FakeConversation };
}

async function dispose(fibers: Fiber[]): Promise<void> {
  for (const fiber of [...fibers].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
}

describe('cr-712 垫片面（has / history / group）', () => {
  it('AgentsShim.has：盘上在场判定 + user 保留端点放行', () => {
    seedAgent('alpha');
    const ctx = new Context();
    const agents = new AgentsShim(ctx, ROOT);
    expect(agents.has('alpha')).toBe(true);
    expect(agents.has('ghost')).toBe(false);
    expect(agents.has('user')).toBe(true); // 虚拟端点（盘上无目录）
  });

  it('SessionShim.history：ledger 读面 + viewer 投影（viewer 的话 assistant）', async () => {
    seedAgent('alpha');
    seedAgent('beta');
    const { ctx, fibers, session } = await bootShell('alpha');
    try {
      const ledger = ctx.get('ledger') as unknown as {
        deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<boolean>;
      };
      await ledger.deliverRow('alpha~beta', ['alpha', 'beta'], 'agent', { role: 'agent', content: 'alpha 说', agent_id: 'alpha' });
      await ledger.deliverRow('alpha~beta', ['alpha', 'beta'], 'agent', { role: 'agent', content: 'beta 答', agent_id: 'beta' });
      // viewer = beta（委托对回放口径——自己的话 assistant）
      const view = await session.history('alpha~beta', { viewer: 'beta' });
      expect(view).toEqual([
        { role: 'user', content: 'alpha 说' },
        { role: 'assistant', content: 'beta 答' },
      ]);
      // 缺席会话 = 空史（首条委托消息）
      expect(await session.history('none~none')).toEqual([]);
    } finally {
      await dispose(fibers);
    }
  });

  it('GroupShim 读面：get/list/listForAgent/isMember/membersWithUser', () => {
    seedGroup('g1', ['alpha', 'beta']);
    seedGroup('g2', ['beta']);
    const ctx = new Context();
    const group = new GroupShim(ctx, ROOT);
    expect(group.get('g1')).toMatchObject({ id: 'g1', name: '群-g1', members: ['alpha', 'beta'] });
    expect(group.get('ghost')).toBeUndefined();
    expect(group.list().map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(group.listForAgent('beta').map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(group.listForAgent('alpha').map((g) => g.id)).toEqual(['g1']);
    expect(group.isMember('g1', 'alpha')).toBe(true);
    expect(group.isMember('g1', 'gamma')).toBe(false);
    expect(group.membersWithUser('g1')).toEqual(['alpha', 'beta', 'user']);
  });

  it('GroupShim.send（方案 A）：自留言落自己成员流 + 逐成员广播信封（broadcast 标记，不回投）', async () => {
    seedAgent('alpha');
    seedGroup('g1', ['alpha', 'beta', 'gamma']);
    const { fibers, group, conversation } = await bootShell('alpha');
    try {
      const out = await group.send('g1', 'alpha', '群公告');
      expect(out.triggered).toEqual(['beta', 'gamma']);
      // 自己成员流：一行自留言（群读面 = 全成员流合并——缺此行自己发言不可见）
      const { rows } = readLedger(path.join(ROOT, 'agents', 'alpha', 'sessions', 'g1~alpha'));
      expect(rows.filter((r) => r.source !== 'segment').map((r) => r.content)).toEqual(['群公告']);
      // 扇出信封：成员流键 + 同 requestId（合并读面去重锚）+ broadcast 标记
      expect(conversation.sent.map((e) => [e.uuid, e.to])).toEqual([['g1~beta', 'beta'], ['g1~gamma', 'gamma']]);
      const requestId = conversation.sent[0]!.requestId;
      for (const e of conversation.sent) {
        expect(e).toMatchObject({ sender: 'alpha', kind: 'message', requestId, payload: { text: '群公告', broadcast: true } });
      }
      // 非成员发言拒绝
      await expect(group.send('g1', 'outsider', 'x')).rejects.toThrow('不在群内');
    } finally {
      await dispose(fibers);
    }
  });
});
