// ============================================================
// ac-memory/tests/memory.test.ts —— 记忆时间线（cr-4）
//
// · 存储：files/<agentId>/memory/timeline.md 单文件（条目 = 宿主铸造头
//   + 正文；seq 位置派生）；persist=false 纯内存后端同语义
// · 注入：checkpoint/delta 协议（loop/before-run seam——cr-1102 迁移；
//   cr-1154 水位归时间线私有 .anchors.json per-(Agent×会话)：H>S delta /
//   H=S 稳态 / 无锚或 H<S 快照重定基线；账本注入行 = 纯回放材料）
// · system 侧：恒定静态指引（memory-guide）
// · 工具：memory_write / memory_grep（memory 标签门禁）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { wrapSystemReminder } from 'ac-core-utils';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as memoryRow from '../src/index';
import * as toolsRow from 'ac-tools';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-memory-'));
  tmps.push(dir);
  return dir;
}

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

/** 假 session（注入协议测试）：context 行内存列表 + 触发 seam。
 *  cr-1154 后 memory 不再消费 records 读面——本类只承载 recordContext 落账面。 */
class FakeSession extends Service {
  rows = new Map<string, Array<{ role: string; source?: string; content: string; agent_id?: string; payload?: unknown }>>();
  constructor(ctx: Context) {
    super(ctx, 'session');
  }
  recordContext(id: string, agentId: string, content: string, extra: { source: string; label?: string; payload?: unknown }) {
    const list = this.rows.get(id) ?? [];
    list.push({ role: 'context', source: extra.source, content, agent_id: agentId, ...(extra.payload !== undefined ? { payload: extra.payload } : {}) });
    this.rows.set(id, list);
    return `inj-${list.length}`;
  }
}

interface BootOpts {
  memoryConfig?: Record<string, unknown>;
  withAgents?: boolean;
  /** 传 true 挂假 session（注入协议测试） */
  fakeSession?: boolean;
}

async function boot(opts: BootOpts = {}) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    ...(opts.withAgents ? [agentsRow] : []),
    loopRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  if (opts.fakeSession) {
    const fiber = ctx.plugin(FakeSession as any);
    await fiber;
    fibers.push(fiber);
  }
  const fiber = ctx.plugin(memoryRow, opts.memoryConfig ?? { persist: false, migrate: false });
  await fiber;
  fibers.push(fiber);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const USER = [{ role: 'user' as const, content: 'hi' }];

/** 首次模型调用的 system 内容（messages[0]） */
function systemOf(i = 0): string {
  const m = captured[i]?.messages?.[0];
  return m && m.role === 'system' ? String(m.content) : '';
}

describe('ac-memory 服务面（write/entries/grep 三口）', () => {
  it('write 铸造条目（宿主 origin/at/date），entries 位置派生 seq；标签走正文前缀', async () => {
    const { ctx } = await boot();
    ctx.memory.write('a1', { content: '[约定] 周五同步', origin: 'alice~a1' });
    ctx.memory.write('a1', { content: '[偏好] 偏好简洁', peers: ['alice'] });
    ctx.memory.write('a1', { content: '[档案] 历史事实', date: '2026-08-16' }); // date 回填
    const entries = ctx.memory.entries('a1');
    expect(entries).toHaveLength(3);
    expect(entries[0].origin).toBe('alice~a1');
    expect(entries[0].seq).toBe(1);
    expect(entries[1].peers).toEqual(['alice']);
    // 标签从正文前缀提取为轴
    expect(entries[0].tags).toEqual(['约定']);
    expect(entries[1].tags).toEqual(['偏好']);
    // date 回填：at 的日期段 = 参数值（时间部分为当下）
    expect(entries[2].at).toContain('2026-08-16');
    expect(entries[0].at).not.toContain('2026-08-16');
  });

  it('grep 过滤轴（pattern/tag/peer）——tag 轴来自正文前缀', async () => {
    const { ctx } = await boot();
    ctx.memory.write('a1', { content: '[运维] 部署窗口周三' });
    ctx.memory.write('a1', { content: '[偏好] 用户喜欢简洁', peers: ['alice'] });
    expect(ctx.memory.grep('a1', { pattern: '部署' })).toContain('部署窗口周三');
    expect(ctx.memory.grep('a1', { tag: '偏好' })).toContain('简洁');
    expect(ctx.memory.grep('a1', { peer: 'alice' })).toContain('简洁');
  });

  it('persist 模式：文件落盘 + 外写（fs）即时可见', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root, migrate: false } });
    ctx.memory.write('a1', { content: '条目一' });
    const file = ctx.memory.timelineFileOf('a1');
    expect(existsSync(file)).toBe(true);
    // fs 外写追加（容错降级路径）
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '<!-- 坏头没有时间戳 -->\n裸行内容\n', 'utf-8');
    const entries = ctx.memory.entries('a1');
    expect(entries).toHaveLength(2);
    expect(entries[1].degraded).toBe(true);
  });
});

describe('ac-memory 注入协议（loop/before-run seam + 私有水位 .anchors——cr-1154）', () => {
  /** 经真实 seam 触发（agentLoop.run → loop/before-run waterfall） */
  async function runOnce(ctx: Context, agent: string, conversationId: string) {
    await ctx.agentLoop.run({ agent, model: 'mock-1', system: 'BASE', messages: USER, conversationId });
  }
  /** 尾部 user 消息内容（cr-1101 live 注入对齐：工作数组 = 落账行的包裹形） */
  function tailUser(i = 0): string {
    const m = captured[i]?.messages?.at(-1);
    return m && m.role === 'user' ? String(m.content) : '';
  }

  async function bootSession() {
    const { ctx } = await boot({ fakeSession: true, withAgents: true });
    for (const id of ['a1', 'news', 'user']) ctx.agents.register({ id, model: 'mock@mock-1' });
    return ctx;
  }

  it('无锚（新会话）→ 快照注入：context 行落账 + 同字节 user 消息进工作数组（双写同源）', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '记忆一' });
    ctx.memory.write('a1', { content: '记忆二' });
    await runOnce(ctx, 'a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('memory-snapshot');
    expect(rows[0].content).toContain('记忆时间线：2 条');
    expect(rows[0].content).toContain('记忆二');
    expect(rows[0].payload).toBeUndefined(); // cr-1154：注入行纯回放材料，水位不寄生 payload
    expect(tailUser()).toBe(wrapSystemReminder(rows[0].content!)); // cr-1101：落账裸文，工作数组包裹 = 回放投影同字节
  });

  it('cr-1233 dryRun（previewSystemPrompt 干跑）→ 不落账不推水位，真实 run 照常快照', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '记忆一' });
    // 干跑（预览形态）：不得快照注入、不得推水位
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: [], conversationId: 'alice~a1', dryRun: true });
    expect(session.rows.get('alice~a1')).toBeUndefined();
    // 真实 run：无锚 → 快照照常（干跑没吃掉首注）
    await runOnce(ctx, 'a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('memory-snapshot');
  });

  it('H = S（稳态）→ 不注入（工作数组不加行）', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '记忆一' });
    await runOnce(ctx, 'a1', 'alice~a1');
    captured.length = 0;
    await runOnce(ctx, 'a1', 'alice~a1'); // 第二次：H=S
    expect(session.rows.get('alice~a1')).toHaveLength(1);
    expect(tailUser()).toBe('hi'); // 只有触发消息，无注入体
  });

  it('H > S（他源新写入）→ delta 注入（本会话 origin 过滤）', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '基线条目' });
    await runOnce(ctx, 'a1', 'alice~a1');
    // 本会话写入（origin = alice~a1）：不进 delta（tool-call 历史已有副本）
    ctx.memory.write('a1', { content: '本会话写的', origin: 'alice~a1' });
    // 他源写入（origin = bob~a1）
    ctx.memory.write('a1', { content: '他源写的', origin: 'bob~a1' });
    await runOnce(ctx, 'a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows).toHaveLength(2);
    expect(rows[1].source).toBe('memory-delta');
    expect(rows[1].content).toContain('他源写的');
    expect(rows[1].content).not.toContain('本会话写的');
    expect(rows[1].payload).toBeUndefined(); // cr-1154：纯回放材料
  });

  // （cr-1102「锚检测兼容 v2 inject 行形态」用例随锚扫描机制退役删除——
  //  认锚从账本行改为锚文件私有，账本行对判定零影响的语义由下方
  //  「水位私有化：脏账本」用例锁定。）

  it('水位私有化：脏账本（乱序/无 seq/重复 memory 行在场）不影响判定——锚恒私有(cr-1155 回归同源)', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    // 模拟事故形态的脏账本：v1 无 seq 行 + 重复 delta + 乱序混排——
    // cr-1154 后这些行对判定零影响（水位不在账本上）
    session.rows.set('alice~a1', [
      { role: 'context', source: 'memory-delta', content: '旧 delta\n记忆基线 seq=1', agent_id: 'a1' },
      { role: 'context', source: 'memory-delta', content: '旧 delta\n记忆基线 seq=1', agent_id: 'a1' },
      { role: 'context', source: 'memory-delta', content: '僵尸 v1 行（无 seq 假装最新）', agent_id: 'a1' },
    ]);
    for (let i = 1; i <= 5; i++) ctx.memory.write('a1', { content: i < 5 ? `第${i}条` : '第五条', origin: 'bob~a1' });
    await runOnce(ctx, 'a1', 'alice~a1'); // 无锚 → 快照重定基线（脏行零影响）
    await runOnce(ctx, 'a1', 'alice~a1'); // 稳态
    ctx.memory.write('a1', { content: '第六条', origin: 'bob~a1' });
    await runOnce(ctx, 'a1', 'alice~a1'); // delta
    const rows = session.rows.get('alice~a1')!;
    // 按内容标记断言（预置脏行 source 也是 memory-delta，不能按 source 计数）：
    // 快照注入恰 1 次、delta 注入恰 1 次且只含第六条——脏账本不产生任何额外注入
    expect(rows.filter((r) => r.content.includes('第六条'))).toHaveLength(1);
    const injected = rows.filter((r) => r.content.includes('第六条'))[0];
    expect(injected.source).toBe('memory-delta');
    expect(rows.filter((r) => r.source === 'memory-snapshot' && !r.content.includes('旧'))).toHaveLength(1);
    expect(injected.content).not.toContain('第五条');
  });

  it('H < S（文件被人工缩短）→ 全量重定基线（快照自愈）', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '一' });
    ctx.memory.write('a1', { content: '二' });
    await runOnce(ctx, 'a1', 'alice~a1');
    // 模拟锚在 seq=5 但盘上只剩 1 条（人工删行）——锚行保留、时间线缩短
    const rows = session.rows.get('alice~a1')!;
    rows.length = 0;
    rows.push({ role: 'context', source: 'memory-snapshot', content: 'x\n记忆基线 seq=5', agent_id: 'a1' });
    const secondCtx = await bootSession();
    const s2 = secondCtx.get('session') as unknown as FakeSession;
    s2.rows.set('alice~a1', [{ role: 'context', source: 'memory-snapshot', content: 'x\n记忆基线 seq=5', agent_id: 'a1' }]);
    secondCtx.memory.write('a1', { content: '仅存一条' });
    await runOnce(secondCtx, 'a1', 'alice~a1');
    const r2 = s2.rows.get('alice~a1')!;
    expect(r2).toHaveLength(2);
    expect(r2[1].source).toBe('memory-snapshot'); // H<S → 快照重定基线
  });

  it('双人格共桶（cr-46→cr-1154）：水位 per-Agent 私有——共桶对方水位天然隔离', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    // news 人格：4 条，已注入（锚在 news 自己的 .anchors 里）
    for (let i = 0; i < 4; i++) ctx.memory.write('news', { content: `news 记忆 ${i + 1}` });
    await runOnce(ctx, 'news', 'news~user');
    // user 人格：1 条——共桶内 news 的注入行在场，但 user 的水位在自己的锚文件（零串台可能）
    ctx.memory.write('user', { content: 'user 记忆' });
    await runOnce(ctx, 'user', 'news~user');
    const rows = session.rows.get('news~user')!;
    expect(rows).toHaveLength(2);
    expect(rows[1].agent_id).toBe('user');
    // news 侧稳态复跑（user 的注入行在场——news 水位不受影响，稳态不注入）
    await runOnce(ctx, 'news', 'news~user');
    expect(rows).toHaveLength(2); // H=S=4 稳态不注入
  });

  it('cr-1154 锚持久化（persist 模式）：跨 Context 重启水位存活——重启后稳态不重注', async () => {
    const root = tmpRoot();
    const first = await boot({ memoryConfig: { root, migrate: false }, fakeSession: true });
    for (let i = 1; i <= 3; i++) first.ctx.memory.write('a1', { content: `条目${i}` });
    const s1 = first.ctx.get('session') as unknown as FakeSession;
    const run1 = async () => first.ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER, conversationId: 'alice~a1' });
    await run1(); // 快照 + 锚落盘
    await run1(); // 稳态
    expect(s1.rows.get('alice~a1')).toHaveLength(1);
    // 新 Context（新 MemoryService 实例读同一数据根）：锚从盘上恢复
    const ctx2 = new Context();
    const fibers2: Fiber[] = [];
    for (const row of [toolsRow, llmRow, {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) { c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] }); },
    }, loopRow] as any[]) {
      const fiber = ctx2.plugin(row);
      await fiber;
      fibers2.push(fiber);
    }
    const fiber = ctx2.plugin(FakeSession as any);
    await fiber;
    fibers2.push(fiber);
    const fiber2 = ctx2.plugin(memoryRow, { root, migrate: false });
    await fiber2;
    fibers2.push(fiber2);
    booted.push({ ctx: ctx2, fibers: fibers2 });
    const s2 = ctx2.get('session') as unknown as FakeSession;
    await ctx2.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER, conversationId: 'alice~a1' });
    expect(s2.rows.get('alice~a1')).toBeUndefined(); // 锚存活 → H=S 稳态，不注入
    // 锚文件确实在盘上
    expect(existsSync(join(root, 'files', 'a1', 'memory', '.anchors.json'))).toBe(true);
  });

  it('空时间线不注入', async () => {
    const ctx = await bootSession();
    const session = ctx.get('session') as unknown as FakeSession;
    await runOnce(ctx, 'a1', 'alice~a1');
    expect(session.rows.get('alice~a1')).toBeUndefined();
  });

});

describe('cr-1154 锚健壮性（脏输入自愈）', () => {
  const runOnce = (ctx: Context, agent: string, conversationId: string) =>
    ctx.agentLoop.run({ agent, model: 'mock-1', system: 'BASE', messages: USER, conversationId });

  it('锚文件损坏/缺席 → fail-soft：按无锚处理，快照自愈一次后恢复稳态', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root, migrate: false }, fakeSession: true });
    ctx.memory.write('a1', { content: '条目一' });
    await runOnce(ctx, 'a1', 'alice~a1'); // 快照 + 锚落盘
    // 损坏锚文件（半写 JSON）
    writeFileSync(join(root, 'files', 'a1', 'memory', '.anchors.json'), '{"alice~a1": 1', 'utf-8');
    const session = ctx.get('session') as unknown as FakeSession;
    const before = (session.rows.get('alice~a1') ?? []).length;
    await runOnce(ctx, 'a1', 'alice~a1'); // 按无锚 → 再注一次快照（幂等自愈，非震荡）
    const rows = session.rows.get('alice~a1')!;
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.source).toBe('memory-snapshot');
    await runOnce(ctx, 'a1', 'alice~a1'); // 锚已重写 → 稳态
    expect(session.rows.get('alice~a1')!.length).toBe(before + 1);
  });

  it('时间线被人工缩短（H<S）→ 快照重定基线 + 锚回落到 H（单调不降只对合法推进）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root, migrate: false }, fakeSession: true });
    for (let i = 1; i <= 3; i++) ctx.memory.write('a1', { content: `条目${i}` });
    await runOnce(ctx, 'a1', 'alice~a1'); // S=3
    // 人工删行：直接重写 timeline 只留 1 条
    const file = ctx.memory.timelineFileOf('a1');
    const first = ctx.memory.entries('a1')[0];
    writeFileSync(file, `<!-- at:${first.at} | origin:${first.origin ?? 'a1'} -->\n[2026-11-18] [事实] 条目1\n`, 'utf-8');
    const session = ctx.get('session') as unknown as FakeSession;
    await runOnce(ctx, 'a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows.at(-1)!.source).toBe('memory-snapshot'); // H<S → 快照重定基线
    // 且锚回落（否则永久卡在 H<S 循环快照）——再跑一次应稳态
    await runOnce(ctx, 'a1', 'alice~a1');
    expect(session.rows.get('alice~a1')!.length).toBe(rows.length);
  });
});

describe('system 静态指引（字节恒定）', () => {
  it('注入 memory-guide 块（不含记忆内容）', async () => {
    const { ctx } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1' });
    ctx.memory.write('a1', { content: '秘密内容不应进 system' });
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    const sys = systemOf();
    expect(sys).toContain('memory-guide');
    expect(sys).not.toContain('秘密内容');
    // 字节恒定：写新条目后 system 不变
    ctx.memory.write('a1', { content: '新条目' });
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(systemOf()).toBe(sys);
  });
});

describe('工具面（memory 标签门禁）', () => {
  it('memory_write 写入 + 返回 seq；无标签 Agent 不可见', async () => {
    const { ctx } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1' });
    const defs = ctx.tools.list();
    expect(defs.map((d) => d.name)).toContain('memory_write');
    expect(defs.map((d) => d.name)).toContain('memory_grep');
    const write = defs.find((d) => d.name === 'memory_write')!;
    const r = await write.execute({ content: '工具写入的条目' }, { name: 'memory_write', agentId: 'a1', conversationId: 'alice~a1' });
    expect(r.ok).toBe(true);
    expect(ctx.memory.entries('a1')).toHaveLength(1);
    expect(ctx.memory.entries('a1')[0].origin).toBe('alice~a1'); // 执行身份铸造 origin
  });

  it('memory_grep 输出条目级分组', async () => {
    const { ctx } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1' });
    ctx.memory.write('a1', { content: '查找我' });
    const grep = ctx.tools.list().find((d) => d.name === 'memory_grep')!;
    const r = await grep.execute({ pattern: '查找' }, { name: 'memory_grep', agentId: 'a1' });
    expect(r.ok).toBe(true);
    expect(String((r as { output?: unknown }).output)).toContain('#1');
  });
});

describe('存量迁移（幂等 marker）', () => {
  it('旧桶 + memory tag + conversation 在装 → 迁移投递（内嵌内容零路径）+ marker 落盘；二次构造跳过', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'files', 'a1', 'memory'), { recursive: true });
    writeFileSync(join(root, 'files', 'a1', 'memory', 'alice~a1.md'), '旧记忆内容', 'utf-8');
    const delivered: Array<{ agentId: string; prompt: string }> = [];
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const mk = async () => {
      const fiber = ctx.plugin(memoryRow, { root });
      await fiber;
      fibers.push(fiber);
      await ctx.memory.migrateLegacyBuckets(); // 显式触发（boot 路径为延迟一拍的自动触发）
    };
    class FakeConversation extends Service {
      constructor(c: Context) {
        super(c, 'conversation');
      }
      async deliver(agentId: string, inbound: string) {
        delivered.push({ agentId, prompt: inbound });
        return { kind: 'run' };
      }
    }
    for (const row of [toolsRow, llmRow, loopRow, agentsRow, FakeConversation]) {
      const fiber = ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1' });
    booted.push({ ctx, fibers });
    await mk(); // 第一次：投递 + marker
    expect(delivered).toHaveLength(1);
    // 指路形态（不内嵌旧桶内容）：指向 ./memory + 两种写入方式
    expect(delivered[0].prompt).toContain('./memory');
    expect(delivered[0].prompt).toContain('memory_write');
    expect(delivered[0].prompt).toContain('timeline.md');
    expect(delivered[0].prompt).not.toContain('旧记忆内容'); // 不内嵌
    expect(existsSync(join(root, 'files', 'a1', 'memory', '.migrated'))).toBe(true);
    // 第二次（新 Context，marker 已落盘）：幂等跳过
    const ctx2 = new Context();
    const fibers2: Fiber[] = [];
    const delivered2: Array<unknown> = [];
    const Conversation2 = class extends FakeConversation {
      delivered2Ref = delivered2;
      async deliver(agentId: string, inbound: string) {
        this.delivered2Ref.push({ agentId, inbound });
        return { kind: 'run' };
      }
    };
    void delivered;
    for (const row of [toolsRow, llmRow, loopRow, agentsRow, Conversation2, memoryRow]) {
      const fiber = ctx2.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers2.push(fiber);
    }
    ctx2.agents.register({ id: 'a1', model: 'mock@mock-1' });
    booted.push({ ctx: ctx2, fibers: fibers2 });
    await new Promise((r) => setTimeout(r, 250));
    expect(delivered2).toHaveLength(0);
  });

  it('行装载单闸（cr-953）：有存量桶的普通 Agent 全迁（无标签门）；预设不迁', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'files', 'ia', 'memory'), { recursive: true });
    writeFileSync(join(root, 'files', 'ia', 'memory', 'u~ia.md'), 'infra Agent 的旧记忆', 'utf-8');
    const delivered: Array<{ agentId: string; prompt: string }> = [];
    const ctx = new Context();
    const fibers: Fiber[] = [];
    class FakeConversation extends Service {
      constructor(c: Context) { super(c, 'conversation'); }
      async deliver(agentId: string, inbound: string) {
        delivered.push({ agentId, prompt: inbound });
        return { kind: 'run' };
      }
    }
    // 假 agentStore：捕获 saveAgent
    const saved: Array<Record<string, unknown>> = [];
    class FakeAgentStore extends Service {
      constructor(c: Context) { super(c, 'agentStore'); }
      saveAgent(config: Record<string, unknown>) { saved.push(config); }
    }
    for (const row of [toolsRow, llmRow, loopRow, agentsRow, FakeConversation, FakeAgentStore, memoryRow]) {
      const fiber = ctx.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'ia', model: 'mock@mock-1' });
    ctx.agents.register({ id: '__preset__', model: 'mock@mock-1' });
    booted.push({ ctx, fibers });
    await ctx.memory.migrateLegacyBuckets();
    // 普通 Agent：投递迁移（无标签门——行装载单闸）
    expect(delivered).toHaveLength(1);
    expect(delivered[0].agentId).toBe('ia');
    expect(saved).toHaveLength(0); // 补标签通路随 tags 退役
    // 预设（词形判定）不迁移
    expect(existsSync(join(root, 'files', 'ia', 'memory', '.migrated'))).toBe(true);
  });

  it('投递失败不落 marker（重试语义——补：投递成功才 writeMarker）', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'files', 'a2', 'memory'), { recursive: true });
    writeFileSync(join(root, 'files', 'a2', 'memory', 'b~a2.md'), '内容', 'utf-8');
    const delivered: Array<unknown> = [];
    const ctx = new Context();
    const fibers: Fiber[] = [];
    class FakeConversation extends Service {
      constructor(c: Context) {
        super(c, 'conversation');
      }
      async deliver(agentId: string, inbound: string) {
        delivered.push({ agentId, inbound });
        throw new Error('deliver 失败');
      }
    }
    for (const row of [toolsRow, llmRow, loopRow, agentsRow, FakeConversation, memoryRow]) {
      const fiber = ctx.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'a2', model: 'mock@mock-1' });
    booted.push({ ctx, fibers });
    await ctx.memory.migrateLegacyBuckets().catch(() => {});
    expect(delivered).toHaveLength(1);
    expect(existsSync(join(root, 'files', 'a2', 'memory', '.migrated'))).toBe(false);
  });
});