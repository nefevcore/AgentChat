// ============================================================
// ac-group 持久化（M15 → D11 存储统一）：本体落 sessions/groups/（经
// session.append/setShelf）· 重启恢复 · 本体轮转（分段 + compact 重建）·
// historyFor 视角回放 · send 传 per-member history 种子 · 纯内存兼容
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as groupRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-persist-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

interface BootOpts {
  groupConfig?: Record<string, unknown>;
}

async function boot(root?: string, opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<{ name?: string; inject?: string[]; apply?: (c: Context) => void }> = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (_: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              yield { delta: '群回复' };
              yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
    conversationRow,
    groupRow,
  ];
  for (const row of rows) {
    const name = (row as { name?: string }).name;
    const isGroup = name === 'ac-group';
    const isSession = name === 'ac-session';
    let fiber: Fiber | undefined;
    if (isGroup && root !== undefined) {
      fiber = ctx.plugin(row as any, { root, ...opts.groupConfig });
    } else if (isSession && root !== undefined) {
      fiber = ctx.plugin(row as any, { root });
    } else if (root === undefined && isSession) {
      fiber = undefined; // 纯内存形态：不挂 session 行（缺省 './data' 会触仓库数据目录）
    } else {
      fiber = ctx.plugin(row as any);
    }
    if (fiber) {
      await fiber;
      fibers.push(fiber);
    }
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).group && (ctx as any).conversation) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function disposeAll() {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
}

afterEach(async () => {
  await disposeAll();
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-group 持久化（D11 存储统一）', () => {
  it('本体落 sessions/groups/<gid>/（shelf 上架，中性行 + 头行）；旧 groups/<gid>/messages.jsonl 不再产生', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    await ctx.group.post('g', 'user', '大家好');
    await ctx.group.post('g', 'a', '早');
    // 成员表在本域；本体在 sessions 树（shelf 上架 + 头行 + 中性行）
    expect(fs.existsSync(path.join(root, 'groups', 'g', 'group.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'groups', 'g', 'messages.jsonl'))).toBe(false); // 退役
    const bucket = path.join(root, 'sessions', 'groups', 'g', 'messages.jsonl');
    expect(fs.existsSync(bucket)).toBe(true);
    const lines = fs.readFileSync(bucket, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'session-header', version: 1 });
    expect(lines.slice(1).map((l: any) => [l.role, l.agent_id])).toEqual([
      ['agent', 'user'],
      ['agent', 'a'],
    ]);
    expect(fs.existsSync(path.join(root, 'sessions', 'groups', '.shelf'))).toBe(true);
    // 寻址不变：records 走映射（GroupMessageRecord 形状保持——UI 契约）
    const recs = await ctx.group.records('g');
    expect(recs.map((r) => r.from)).toEqual(['user', 'a']);
  });

  it('重启（二次 boot）恢复：成员表 + 本体水合 + 成员流扇出续接', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
      await ctx.group.post('g', 'user', '大家好');
      await ctx.group.post('g', 'a', '早');
      ctx.group.rename('g', '新客厅');
      ctx.group.join('g', 'b'); // 幂等
    }
    await disposeAll();
    {
      const { ctx } = await boot(root);
      const g = ctx.group.get('g');
      expect(g?.name).toBe('新客厅');
      expect(g?.members).toEqual(['a', 'b']);
      // 本体水合：records 照常
      const recs = await ctx.group.records('g', 50);
      expect(recs.map((r) => r.from)).toEqual(['user', 'a']);
      // 成员流（cr-4）持久存活：a 的流含 own 投影（assistant）
      const ha = await ctx.session.history('g~a', { viewer: 'a' });
      expect(ha.some((m) => m.role === 'assistant' && String(m.content) === '早')).toBe(true);
    }
  });

  it('delete 清理磁盘目录（本域 + sessions 本体桶）；leave 清空 → 自动删除同款', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g2', name: '临时', members: ['a'] });
    await ctx.group.post('g2', 'user', 'x');
    expect(fs.existsSync(path.join(root, 'sessions', 'groups', 'g2', 'messages.jsonl'))).toBe(true);
    ctx.group.delete('g2');
    expect(fs.existsSync(path.join(root, 'groups', 'g2'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'sessions', 'groups', 'g2'))).toBe(false);
  });

  it('本体轮转：分段 + 机械摘要 + compact 重建保留尾部（头行/seq 保活）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { groupConfig: { archiveTokens: 50, keepTokens: 5 } });
    ctx.group.create({ id: 'big', name: '大群', members: ['a'] });
    for (let i = 0; i < 8; i++) await ctx.group.post('big', 'user', `第${i}条消息内容比较长会占token`);
    const archiveDir = path.join(root, 'groups', 'big', 'archive');
    expect(fs.existsSync(path.join(archiveDir, 'history_1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'summary_1.md'))).toBe(true);
    const summary = fs.readFileSync(path.join(archiveDir, 'summary_1.md'), 'utf-8');
    expect(summary).toContain('早期摘要');
    // 本体保留尾部（头行 + 少于 8 行数据）
    const bucket = path.join(root, 'sessions', 'groups', 'big', 'messages.jsonl');
    const lines = fs.readFileSync(bucket, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'session-header' });
    expect(lines.length - 1).toBeLessThan(8);
  });

  it('成员流扇出（cr-4）：own=assistant 原文 / peer=user 包装；send 触发成员 run', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    await ctx.group.post('g', 'user', '第一条');
    await ctx.group.post('g', 'user', '第二条');
    await ctx.group.post('g', 'a', '我说过的话'); // own
    await ctx.group.post('g', 'b', '我说两句'); // 对 a 是 peer

    const forA = await ctx.session.history('g~a', { viewer: 'a' });
    expect(forA.at(-3)!.role).toBe('user'); // user 投影 ×2（各自独立行——成员流不合并）
    expect(forA.at(-2)!.role).toBe('assistant'); // own
    expect(String(forA.at(-2)!.content)).toBe('我说过的话');
    expect(String(forA.at(-1)!.content)).toContain('<msg from="b"'); // peer 包装

    // b 自己视角：own 原文（assistant）
    const forB = await ctx.session.history('g~b', { viewer: 'b' });
    expect(String(forB.at(-1)!.content)).toBe('我说两句');
    expect(forB.at(-1)!.role).toBe('assistant');

    // send：成员被触发（hint 只唤醒，投影行已入流）
    const received: string[] = [];
    ctx.on('router/message-received', (_agentId, m) => received.push(m.content));
    const sent = await ctx.group.send('g', 'user', '新消息', { settle: true });
    expect(sent.triggered).toEqual(['a', 'b']);
    expect(received.length).toBeGreaterThan(0);
  });

  it('无 root 且无 session 行 = 纯内存（现有语义不变）', async () => {
    const { ctx } = await boot();
    ctx.group.create({ id: 'mem', name: '内存群', members: ['a'] });
    const r = await ctx.group.post('mem', 'user', 'hi');
    expect(r.content).toBe('hi');
    expect((await ctx.group.records('mem')).some((x) => x.content === 'hi')).toBe(true);
  });
});
