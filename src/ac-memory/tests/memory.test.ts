// ============================================================
// ac-memory/tests/memory.test.ts —— 长期记忆（M14 扩展）
//
// · 键 = conversationId（缺省 agent = 1v1 桶；群 = 组 id）
// · 记忆归 Agent 本人：文件 = files/<agentId>/memory/<会话键>.md
//   （对桶两侧各一份）；LLM 侧维护 = fs 工具直接重写（专用工具已移除）
// · <memory> 块注入 system 末尾；token 预算截断（尾部保留）
// · 注入直读文件（无读缓存）：fs 外写即时可见
// · settings['memory'].enabled / maxTokens per-Agent 管控
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as memoryRow from '../src/index';
import * as singlesRow from 'ac-singles';
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

interface BootOpts {
  memoryConfig?: Record<string, unknown>;
  withAgents?: boolean;
  /** 传入 = 挂 ac-singles 行（root），记忆键重定向分支可测 */
  singlesRoot?: string;
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
  if (opts.singlesRoot !== undefined) {
    const fiber = ctx.plugin(singlesRow as any, { root: opts.singlesRoot });
    await fiber;
    fibers.push(fiber);
  }
  const fiber = ctx.plugin(memoryRow, opts.memoryConfig ?? { persist: false });
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

describe('ac-memory 注入（键 = 1v1 对键 / 群 id / singles 重定向对桶；记忆归 Agent 本人）', () => {
  it('1v1：agent 键（conversationId 缺省回退）注入 <memory> 块（file 头 = Agent 落名权威来源）', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', 'a1', '用户偏好简洁回答');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: 'BASE\n\n<memory file="memory/a1.md">\n用户偏好简洁回答\n</memory>',
    });
  });

  it('conversationId 优先于 agent（群桶：组记忆与成员自己的 1v1 记忆分文件）', async () => {
    const { ctx } = await boot();
    ctx.memory.set('g1', 'team', '群共享记忆（g1 视角）');
    ctx.memory.set('g1', 'g1', 'g1 的 1v1 记忆');
    await ctx.agentLoop.run({
      agent: 'g1',
      model: 'mock-1',
      conversationId: 'team',
      messages: USER,
    });
    expect(String(captured[0].messages[0].content)).toContain('群共享记忆（g1 视角）');
    expect(String(captured[0].messages[0].content)).not.toContain('g1 的 1v1 记忆');
  });

  it('对桶两侧各一份：同键不同 Agent 互不覆盖（files/<agent>/memory/<键>.md）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root } });
    ctx.memory.set('a', 'a~b', 'a 记住的');
    ctx.memory.set('b', 'a~b', 'b 记住的');
    expect(readFileSync(join(root, 'files', 'a', 'memory', 'a~b.md'), 'utf-8')).toBe('a 记住的');
    expect(readFileSync(join(root, 'files', 'b', 'memory', 'a~b.md'), 'utf-8')).toBe('b 记住的');
    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', conversationId: 'a~b', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('a 记住的');
  });

  it('键全空（子 Agent / loop 直连）→ 不注入', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', 'a1', '有记忆');
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('remove 后注入空桶指引块（桶在、内容空——Agent 仍知道往哪写）；append 追加', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', 'a1', '临时记忆');
    ctx.memory.append('a1', 'a1', '第二行');
    expect(ctx.memory.get('a1', 'a1')).toBe('临时记忆\n第二行');
    ctx.memory.remove('a1', 'a1');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    const sys = String(captured[0].messages[0].content);
    expect(sys).toContain('<memory file="memory/a1.md">');
    expect(sys).toContain('暂无记忆');
  });
});

describe('ac-memory 注入块自描述 + singles 键重定向（2026-09-04：排序键词法对 LLM 不可推导）', () => {
  it('空桶注入指引块：file 头给全路径（Agent 落文件名的权威来源），内容空也可起步', async () => {
    const { ctx } = await boot();
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content:
        'BASE\n\n<memory file="memory/a1.md">\n（暂无记忆：将本会话中值得长期保留的信息写入本文件，后续每轮自动注入；过时内容及时删除）\n</memory>',
    });
  });

  it('singles 键重定向：single 注入该 Agent 对用户的对桶记忆（sid 键 Agent 无从得知，永不注入）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root }, singlesRoot: root });
    const single = ctx.singles.create({ agentId: 'a1' });
    ctx.memory.set('a1', 'a1~user', 'Agent 对用户的既有记忆');
    ctx.memory.set('a1', single.id, 'sid 键旧数据（不再注入）');
    await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      conversationId: single.id,
      sender: 'user',
      messages: USER,
    });
    const sys = String(captured[0].messages[0].content);
    expect(sys).toContain('Agent 对用户的既有记忆');
    expect(sys).not.toContain('sid 键旧数据');
    // 落名权威来源 = 对桶键文件（与 1v1 同文件，记忆连续）
    expect(sys).toContain('file="memory/a1~user.md"');
  });

  it('singles 快照口径对齐：memoryBucketOf 是注入与前缀修订的单一事实源', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root }, singlesRoot: root });
    const single = ctx.singles.create({ agentId: 'a1' });
    // 单一事实源直查：single 的桶 = 对用户对桶（anchor = 本 Agent）
    expect(ctx.memory.memoryBucketOf('a1', single.id, 'user')).toEqual({
      anchor: 'a1',
      key: 'a1~user',
    });
    // 非 single 的 conversationId（对桶/群）不受重定向影响
    expect(ctx.memory.memoryBucketOf('a1', 'a1~user', 'user')).toEqual({
      anchor: 'a1',
      key: 'a1~user',
    });
    // 键全空（无 agent 身份）→ 无桶
    expect(ctx.memory.memoryBucketOf('a1', undefined, undefined)).toEqual({ anchor: 'a1', key: 'a1' });
  });
});

describe('ac-memory 预算截断（ac-memory-core）', () => {
  it('超预算 → 尾部保留 + 截断标记', async () => {
    const { ctx } = await boot({ memoryConfig: { persist: false, maxTokens: 80 } });
    ctx.memory.set(
      'a1',
      'a1',
      Array.from({ length: 200 }, (_, i) => `早期记忆条目${i}，包含足够长的内容以触发预算截断。`).join('\n'),
    );
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', messages: USER });
    const system = String(captured[0].messages[0].content);
    expect(system).toContain('<memory file="memory/a1.md">');
    expect(system).toContain('（更早的记忆已按预算截断）');
    expect(system).toContain('早期记忆条目199');
    expect(system).not.toContain('早期记忆条目0，');
  });

  it("settings['memory'].maxTokens per-Agent 覆盖；enabled=false 软停用", async () => {
    const { ctx } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'm1', model: 'mock-1', settings: { memory: { maxTokens: 10 } } });
    ctx.agents.register({ id: 'm2', model: 'mock-1', settings: { memory: { enabled: false } } });
    const long = Array.from({ length: 100 }, (_, i) => `记忆${i}`).join('\n');
    ctx.memory.set('m1', 'm1', long);
    ctx.memory.set('m2', 'm2', long);
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', messages: USER });
    const s1 = String(captured[0].messages[0].content);
    expect(s1).toContain('（更早的记忆已按预算截断）');
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'm2', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});

describe('ac-memory 文件后端（files/<agentId>/memory/<会话键>.md——fs 工具可达）', () => {
  it('set 原子落盘；重启回读（跨重启恢复）；fileOf 路径口径', async () => {
    const root = tmpRoot();
    const first = await boot({ memoryConfig: { root } });
    first.ctx.memory.set('a1', 'a1', '持久记忆');
    const file = join(root, 'files', 'a1', 'memory', 'a1.md');
    expect(first.ctx.memory.fileOf('a1', 'a1')).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('持久记忆');

    const second = await boot({ memoryConfig: { root } });
    expect(second.ctx.memory.get('a1', 'a1')).toBe('持久记忆');
    expect(second.ctx.memory.ids('a1')).toContain('a1');
  });

  it('会话键校验：路径分隔/遍历字符抛错', async () => {
    const { ctx } = await boot();
    expect(() => ctx.memory.set('a1', '../evil', 'x')).toThrow(/非法/);
    expect(() => ctx.memory.set('a1', 'a/b', 'x')).toThrow(/非法/);
  });
});

describe('ac-memory 工具面（2026-09 收敛：fs 工具兼容，专用工具移除）', () => {
  it('不注册 memory_append / memory_rewrite（维护走 fs 工具直写记忆文件）', async () => {
    const { ctx } = await boot();
    const names = ctx.tools.list().map((t) => t.name);
    expect(names).not.toContain('memory_append');
    expect(names).not.toContain('memory_rewrite');
  });

  it('注入直读文件（无读缓存）：Agent 经 fs 工具外写即时可见', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root } });
    // 预热：先注入一次（旧实现此处会缓存），再外部（fs 工具路径）改写
    ctx.memory.set('a1', 'a1', '旧记忆');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('旧记忆');
    captured.length = 0;
    // 模拟 Agent 用 write 工具重写记忆文件（不经 ctx.memory）
    const file = join(root, 'files', 'a1', 'memory', 'a1.md');
    writeFileSync(file, '整理后的新记忆', 'utf-8');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('整理后的新记忆');
    expect(String(captured[0].messages[0].content)).not.toContain('旧记忆');
  });

  it('记忆文件不存在时 Agent 视角的相对路径 = memory/<会话键>.md（归档提示词同口径）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot({ memoryConfig: { root } });
    // 归档整理指令让 Agent 写 memory/<会话键>.md（相对 Agent 工作目录）——
    // 与 fileOf 同一落点：写入后注入可见
    const relDir = join(root, 'files', 'a1', 'memory');
    mkdirSync(relDir, { recursive: true });
    writeFileSync(join(relDir, 'a1~user.md'), '归档整理写入的记忆', 'utf-8');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', conversationId: 'a1~user', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('归档整理写入的记忆');
  });
});

describe('ac-memory 群桶共享注入（2026-10 群记忆收敛：记忆属主）', () => {
  /** 最小 group 服务面：名册按表出 memoryOwner */
  class FakeGroupService extends Service {
    private table: Record<string, { memoryOwner?: string }>;
    constructor(ctx: Context, options: { groups?: Record<string, { memoryOwner?: string }> } = {}) {
      super(ctx, 'group');
      this.table = options.groups ?? {};
    }
    get(id: string): { memoryOwner?: string } | undefined {
      return this.table[id];
    }
  }

  async function bootWithGroup(root: string, groups: Record<string, { memoryOwner?: string }>) {
    const bootRes = await boot({ memoryConfig: { root } });
    const fiber = bootRes.ctx.plugin(FakeGroupService as any, { groups });
    await fiber;
    bootRes.fibers.push(fiber);
    return bootRes;
  }

  it('群桶配了 memoryOwner → 全体成员共享注入属主那份（单写多读）；成员自己的同键文件不再注入', async () => {
    const root = tmpRoot();
    const { ctx } = await bootWithGroup(root, { team: { memoryOwner: 'own' } });
    ctx.memory.set('own', 'team', '属主维护的群共享记忆');
    ctx.memory.set('m1', 'team', 'm1 私藏的群记忆（被共享版取代）');
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'team', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('属主维护的群共享记忆');
    expect(String(captured[0].messages[0].content)).not.toContain('m1 私藏的群记忆');
    captured.length = 0;
    // 另一成员同款注入（共享同一份）
    ctx.memory.set('m2', 'team', 'm2 私藏（同样被取代）');
    await ctx.agentLoop.run({ agent: 'm2', model: 'mock-1', conversationId: 'team', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('属主维护的群共享记忆');
    expect(String(captured[0].messages[0].content)).not.toContain('m2 私藏');
  });

  it('属主重写即时生效（注入直读）；解除属主（undefined）→ 回退成员各自（现状语义）', async () => {
    const root = tmpRoot();
    const { ctx } = await bootWithGroup(root, { team: { memoryOwner: 'own' } });
    // 属主经 fs 工具外写重写共享记忆 → 下一 run 即时可见（无读缓存）
    const ownFile = join(root, 'files', 'own', 'memory', 'team.md');
    mkdirSync(join(root, 'files', 'own', 'memory'), { recursive: true });
    writeFileSync(ownFile, '属主重写后的群记忆', 'utf-8');
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'team', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('属主重写后的群记忆');
    // 对桶键（含 ~）不受群名册影响：永远归 Agent 本人
    ctx.memory.set('m1', 'm1~user', '1v1 记忆不受群属主影响');
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'm1~user', messages: USER });
    expect(String(captured[1].messages[0].content)).toContain('1v1 记忆不受群属主影响');
    // 未配属主的群 → 现状（各自文件）
    ctx.memory.set('m1', 'free', '自由群的成员记忆');
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'free', messages: USER });
    expect(String(captured[2].messages[0].content)).toContain('自由群的成员记忆');
  });

  it('群共享视图自描述：成员读者非属主 → 不带 file 头（成员不写属主文件）；空群桶给属主维护提示', async () => {
    const root = tmpRoot();
    const { ctx } = await bootWithGroup(root, {
      team: { memoryOwner: 'own' },
      ghost: { memoryOwner: 'own' },
    });
    ctx.memory.set('own', 'team', '共享记忆');
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'team', messages: USER });
    const shared = String(captured[0].messages[0].content);
    expect(shared).toContain('<memory>\n共享记忆\n</memory>');
    expect(shared).not.toContain('file=');
    captured.length = 0;
    // 空群桶：成员视图 = 属主维护提示（同样无写路径）
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', conversationId: 'ghost', messages: USER });
    const empty = String(captured[0].messages[0].content);
    expect(empty).toContain('（本群暂无共享记忆，由记忆属主维护）');
    expect(empty).not.toContain('file=');
    captured.length = 0;
    // 属主本人看同桶 → 带写路径（属主维护）
    await ctx.agentLoop.run({ agent: 'own', model: 'mock-1', conversationId: 'team', messages: USER });
    expect(String(captured[0].messages[0].content)).toContain('file="memory/team.md"');
  });
});
