// ============================================================
// ac-memory/tests/memory.test.ts —— 记忆时间线（cr-4）
//
// · 存储：files/<agentId>/memory/timeline.md 单文件（条目 = 宿主铸造头
//   + 正文；seq 位置派生）；persist=false 纯内存后端同语义
// · 注入：checkpoint/delta 协议（conversation/before-start seam 直落
//   context 行——锚检测 H>S delta / H=S 稳态 / 无锚或 H<S 快照重定基线）
// · system 侧：恒定静态指引（memory-guide）
// · 工具：memory_write / memory_grep（memory 标签门禁）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
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

/** 假 session（注入协议测试）：context 行内存列表 + 触发 seam */
class FakeSession extends Service {
  rows = new Map<string, Array<{ role: string; source?: string; content: string; agent_id?: string }>>();
  constructor(ctx: Context) {
    super(ctx, 'session');
  }
  async records(id: string) {
    return this.rows.get(id) ?? [];
  }
  recordContext(id: string, agentId: string, content: string, extra: { source: string; label?: string }) {
    const list = this.rows.get(id) ?? [];
    list.push({ role: 'context', source: extra.source, content, agent_id: agentId });
    this.rows.set(id, list);
    return `inj-${list.length}`;
  }
  /** 手动触发 seam（集成中由 conversation.startRun 发）；emit 后 flush 微任务（async 监听器落定） */
  async fireBeforeStart(agentId: string, conversationId: string) {
    this.ctx.emit('conversation/before-start', agentId, conversationId);
    await new Promise((r) => setTimeout(r, 5));
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

describe('ac-memory 注入协议（before-start seam + 锚检测状态机）', () => {
  it('无锚（新会话）→ 快照注入（统计行 + 条目 + 基线尾行）', async () => {
    const { ctx } = await boot({ fakeSession: true });
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '记忆一' });
    ctx.memory.write('a1', { content: '记忆二' });
    await session.fireBeforeStart('a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('memory-snapshot');
    expect(rows[0].content).toContain('记忆时间线：2 条');
    expect(rows[0].content).toContain('记忆二');
    expect(rows[0].content).toMatch(/记忆基线 seq=2$/);
  });

  it('H = S（稳态）→ 不注入', async () => {
    const { ctx } = await boot({ fakeSession: true });
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '记忆一' });
    await session.fireBeforeStart('a1', 'alice~a1');
    await session.fireBeforeStart('a1', 'alice~a1'); // 第二次：H=S
    expect(session.rows.get('alice~a1')).toHaveLength(1);
  });

  it('H > S（他源新写入）→ delta 注入（本会话 origin 过滤）', async () => {
    const { ctx } = await boot({ fakeSession: true });
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '基线条目' });
    await session.fireBeforeStart('a1', 'alice~a1');
    // 本会话写入（origin = alice~a1）：不进 delta（tool-call 历史已有副本）
    ctx.memory.write('a1', { content: '本会话写的', origin: 'alice~a1' });
    // 他源写入（origin = bob~a1）
    ctx.memory.write('a1', { content: '他源写的', origin: 'bob~a1' });
    await session.fireBeforeStart('a1', 'alice~a1');
    const rows = session.rows.get('alice~a1')!;
    expect(rows).toHaveLength(2);
    expect(rows[1].source).toBe('memory-delta');
    expect(rows[1].content).toContain('他源写的');
    expect(rows[1].content).not.toContain('本会话写的');
    expect(rows[1].content).toMatch(/记忆基线 seq=3$/);
  });

  it('H < S（文件被人工缩短）→ 全量重定基线（快照自愈）', async () => {
    const { ctx } = await boot({ fakeSession: true });
    const session = ctx.get('session') as unknown as FakeSession;
    ctx.memory.write('a1', { content: '一' });
    ctx.memory.write('a1', { content: '二' });
    await session.fireBeforeStart('a1', 'alice~a1');
    // 模拟锚在 seq=2 但盘上只剩 1 条（人工删行）——直接把锚行内容改成 seq=2 保持、清 store
    const rows = session.rows.get('alice~a1')!;
    rows.length = 0;
    rows.push({ role: 'context', source: 'memory-snapshot', content: '旧快照\n记忆基线 seq=2', agent_id: 'a1' });
    // persist=false 无文件——用 entries 数无法缩；改为写 1 条后重开（模拟缩短后 H=1 < S=2）
    // FakeSession 场景下直接构造：新 boot 一组写 1 条
    const second = await boot({ fakeSession: true });
    const s2 = second.ctx.get('session') as unknown as FakeSession;
    s2.rows.set('alice~a1', [{ role: 'context', source: 'memory-snapshot', content: 'x\n记忆基线 seq=5', agent_id: 'a1' }]);
    second.ctx.memory.write('a1', { content: '仅存一条' });
    await s2.fireBeforeStart('a1', 'alice~a1');
    const r2 = s2.rows.get('alice~a1')!;
    expect(r2).toHaveLength(2);
    expect(r2[1].source).toBe('memory-snapshot'); // H<S → 快照重定基线
    expect(r2[1].content).toMatch(/记忆基线 seq=1$/);
  });

  it('空时间线不注入', async () => {
    const { ctx } = await boot({ fakeSession: true });
    const session = ctx.get('session') as unknown as FakeSession;
    await session.fireBeforeStart('a1', 'alice~a1');
    expect(session.rows.get('alice~a1')).toBeUndefined();
  });

  it('settings.memory.enabled=false 软停用（不注入指引与内容）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ withAgents: true, memoryConfig: { root, migrate: false } });
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'], settings: { memory: { enabled: false } } });
    ctx.memory.write('a1', { content: '条目' });
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(systemOf()).not.toContain('memory-guide');
  });
});

describe('system 静态指引（字节恒定）', () => {
  it('注入 memory-guide 块（不含记忆内容）', async () => {
    const { ctx } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'] });
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
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'] });
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
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'] });
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
    for (const row of [toolsRow, agentsRow, FakeConversation]) {
      const fiber = ctx.plugin(row as any);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'] });
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
    for (const row of [toolsRow, agentsRow, Conversation2, memoryRow]) {
      const fiber = ctx2.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers2.push(fiber);
    }
    ctx2.agents.register({ id: 'a1', model: 'mock@mock-1', tags: ['memory'] });
    booted.push({ ctx: ctx2, fibers: fibers2 });
    await new Promise((r) => setTimeout(r, 250));
    expect(delivered2).toHaveLength(0);
  });

  it('infra 等价授予（用户裁决 2026-09-27）：有存量桶 + infra tag + 无 memory → 自动补 tag（持久化 + reassign）后迁移；预设不迁', async () => {
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
    for (const row of [toolsRow, agentsRow, FakeConversation, FakeAgentStore, memoryRow]) {
      const fiber = ctx.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'ia', model: 'mock@mock-1', tags: ['infra'] } as never);
    ctx.agents.register({ id: '__preset__', model: 'mock@mock-1', tags: ['infra'], preset: true } as never);
    booted.push({ ctx, fibers });
    await ctx.memory.migrateLegacyBuckets();
    // infra Agent：补 tag + 投递
    expect(delivered).toHaveLength(1);
    expect(delivered[0].agentId).toBe('ia');
    expect(saved).toHaveLength(1);
    expect((saved[0].tags as string[]).includes('memory')).toBe(true);
    // 注册表热更新：memory_write 可见性生效（tags 含 memory）
    expect((ctx.agents.get('ia')?.tags ?? []).includes('memory')).toBe(true);
    // 预设（preset: true）不迁移不补 tag——不为其建档（agentStore 无它）
    expect(saved.every((s) => s.id !== '__preset__')).toBe(true);
    expect(existsSync(join(root, 'files', 'ia', 'memory', '.migrated'))).toBe(true);
  });

  it('无 memory tag → 跳过投递并告警（不落 marker——补标签后重启重试）', async () => {
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
        return { kind: 'run' };
      }
    }
    for (const row of [toolsRow, agentsRow, FakeConversation, memoryRow]) {
      const fiber = ctx.plugin(row as any, row === memoryRow ? { root } : undefined);
      await fiber;
      fibers.push(fiber);
    }
    ctx.agents.register({ id: 'a2', model: 'mock@mock-1', tags: [] });
    booted.push({ ctx, fibers });
    await new Promise((r) => setTimeout(r, 250));
    expect(delivered).toHaveLength(0);
    expect(existsSync(join(root, 'files', 'a2', 'memory', '.migrated'))).toBe(false);
  });
});