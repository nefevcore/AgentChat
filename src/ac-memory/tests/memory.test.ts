// ============================================================
// ac-memory/tests/memory.test.ts —— 长期记忆（M14 扩展）
//
// · 键 = conversationId（缺省 agent = 1v1 桶；群 = 组 id）
// · <memory> 块注入 system 末尾；token 预算截断（尾部保留）
// · 文件后端：<root>/memory/<key>.md 原子写 + 重启回读
// · settings['memory'].enabled / maxTokens per-Agent 管控
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

describe('ac-memory 注入（键 = conversationId ?? agent）', () => {
  it('1v1：agent 键（conversationId 缺省回退）注入 <memory> 块', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', '用户偏好简洁回答');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({
      role: 'system',
      content: 'BASE\n\n<memory>\n用户偏好简洁回答\n</memory>',
    });
  });

  it('conversationId 优先于 agent（群桶：两个成员共享组记忆、各自 1v1 独立）', async () => {
    const { ctx } = await boot();
    ctx.memory.set('team', '群共享记忆');
    ctx.memory.set('g1', 'g1 的 1v1 记忆');
    await ctx.agentLoop.run({
      agent: 'g1',
      model: 'mock-1',
      conversationId: 'team',
      messages: USER,
    });
    expect(String(captured[0].messages[0].content)).toContain('群共享记忆');
    expect(String(captured[0].messages[0].content)).not.toContain('g1 的 1v1 记忆');
  });

  it('键全空（子 Agent / loop 直连）→ 不注入', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', '有记忆');
    await ctx.agentLoop.run({ model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('remove 后不再注入；append 追加', async () => {
    const { ctx } = await boot();
    ctx.memory.set('a1', '临时记忆');
    ctx.memory.append('a1', '第二行');
    expect(ctx.memory.get('a1')).toBe('临时记忆\n第二行');
    ctx.memory.remove('a1');
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});

describe('ac-memory 预算截断（ac-memory-core）', () => {
  it('超预算 → 尾部保留 + 截断标记', async () => {
    const { ctx } = await boot({ memoryConfig: { persist: false, maxTokens: 80 } });
    ctx.memory.set(
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
    ctx.memory.set('m1', long);
    ctx.memory.set('m2', long);
    await ctx.agentLoop.run({ agent: 'm1', model: 'mock-1', messages: USER });
    const s1 = String(captured[0].messages[0].content);
    expect(s1).toContain('（更早的记忆已按预算截断）');
    captured.length = 0;
    await ctx.agentLoop.run({ agent: 'm2', model: 'mock-1', system: 'BASE', messages: USER });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });
});

describe('ac-memory 文件后端（ADR-5：本服务拥有记忆存储）', () => {
  it('set 原子落盘 <root>/memory/<key>.md；重启回读（跨重启恢复）', async () => {
    const root = tmpRoot();
    const first = await boot({ memoryConfig: { root } });
    first.ctx.memory.set('a1', '持久记忆');
    const file = join(root, 'memory', 'a1.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('持久记忆');

    const second = await boot({ memoryConfig: { root } });
    expect(second.ctx.memory.get('a1')).toBe('持久记忆');
    expect(second.ctx.memory.ids()).toContain('a1');
  });

  it('会话键校验：路径分隔/遍历字符抛错', async () => {
    const { ctx } = await boot();
    expect(() => ctx.memory.set('../evil', 'x')).toThrow(/非法/);
    expect(() => ctx.memory.set('a/b', 'x')).toThrow(/非法/);
  });
});

describe('ac-memory 工具面（LLM 侧写口，M20 补 memory_rewrite）', () => {
  it('memory_append 追加 / memory_rewrite 全量重写（键 = conversationId ?? agentId）', async () => {
    const { ctx } = await boot();
    const names = ctx.tools.list().map((t) => t.name);
    expect(names).toContain('memory_append');
    expect(names).toContain('memory_rewrite');
    // append 累积写
    const r1 = await ctx.tools.execute({
      name: 'memory_append',
      args: { line: '用户偏好简洁回答' },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    expect(r1.ok).toBe(true);
    const r2 = await ctx.tools.execute({
      name: 'memory_append',
      args: { line: '每周五例会' },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    expect(r2.ok).toBe(true);
    expect(ctx.memory.get('a1~user')).toBe('用户偏好简洁回答\n每周五例会');
    // rewrite 全量替换（归档整理："合并重复、删除过时，不要只追加"）
    const r3 = await ctx.tools.execute({
      name: 'memory_rewrite',
      args: { content: '用户偏好简洁回答（合并后唯一有效条目）' },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    expect(r3.ok).toBe(true);
    expect(ctx.memory.get('a1~user')).toBe('用户偏好简洁回答（合并后唯一有效条目）');
    // 空 content 拒绝（误清空防护）
    const r4 = await ctx.tools.execute({
      name: 'memory_rewrite',
      args: { content: '   ' },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    expect(r4.ok).toBe(false);
    expect(ctx.memory.get('a1~user')).toBe('用户偏好简洁回答（合并后唯一有效条目）');
  });
});
