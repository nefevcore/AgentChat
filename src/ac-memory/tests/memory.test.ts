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
import { Context, type Fiber } from '@agentchat/cordis';
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

interface BootOpts {
  memoryConfig?: Record<string, unknown>;
  withAgents?: boolean;
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

describe('ac-memory 注入（键 = conversationId ?? agent；记忆归 Agent 本人）', () => {
  it('1v1：agent 键（conversationId 缺省回退）注入 <memory> 块', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', 'a1', '用户偏好简洁回答');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: 'BASE\n\n<memory>\n用户偏好简洁回答\n</memory>',
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

  it('remove 后不再注入；append 追加', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', 'a1', '临时记忆');
    ctx.memory.append('a1', 'a1', '第二行');
    expect(ctx.memory.get('a1', 'a1')).toBe('临时记忆\n第二行');
    ctx.memory.remove('a1', 'a1');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
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
    expect(system).toContain('<memory>');
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
