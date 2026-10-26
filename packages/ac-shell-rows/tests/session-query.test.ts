// ============================================================
// 会话查询行单测（cr-544：D10 收敛为 agent 只搜自己）
// 覆盖：回放投影（summary 头 / viewer / 机制行不入回放）、grep 截断与上限、
// read 分页、越域与非法键 fail-loud。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import { makeSessionQueryRow } from '../src/session-query.ts';

const ROOT = path.join('sandbox', 'test-session-query-' + process.pid);
/** 本 agent 域（agents/<id>/） */
const AGENT_DIR = path.join(ROOT, 'agents', 'alpha');
const SELF = 'alpha';
const PEER = 'beta';
const CONV = 'alpha~beta';

interface ToolHandler {
  name: string;
  execute(args: Record<string, unknown>, call: { conversationId?: string; agentId?: string }): Promise<unknown>;
}

/** tools 基座桩：只承载本行用到的 register 契约面 */
class StubTools extends Service {
  readonly tools = new Map<string, ToolHandler>();
  constructor(ctx: Context) {
    super(ctx, 'tools');
  }
  register(tool: ToolHandler) {
    if (this.tools.has(tool.name)) throw new Error('工具已注册: ' + tool.name);
    this.tools.set(tool.name, tool);
    return this.ctx.fiber.effect(() => {
      this.tools.set(tool.name, tool);
      return () => { this.tools.delete(tool.name); };
    }, 'tools.register(' + tool.name + ')');
  }
  async call(name: string, args: Record<string, unknown>, call: { conversationId?: string; agentId?: string }) {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error('工具未注册: ' + name);
    return tool.execute(args, call);
  }
}

/** 写一份会话账本（header + 行 + 可选概要） */
function writeConversation(
  dataRoot: string,
  agentId: string,
  conversationId: string,
  rows: Array<{ role: 'agent' | 'context'; agent_id: string; content: string }>,
  summary?: string,
): string {
  const dir = path.join(dataRoot, 'agents', agentId, 'sessions', conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [JSON.stringify({
    type: 'session-header', version: 1, createdAt: '2026-10-19T00:00:00.000Z',
    participants: conversationId.split('~'), kind: 'agent-pair',
  })];
  rows.forEach((row, i) => {
    lines.push(JSON.stringify({
      role: row.role, content: row.content, message_id: 'm' + (i + 1),
      timestamp: '2026-10-19T00:00:0' + i + '.000Z', agent_id: row.agent_id, seq: i + 1,
    }));
  });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf-8');
  if (summary !== undefined) fs.writeFileSync(path.join(dir, 'summary.md'), summary + '\n', 'utf-8');
  return dir;
}

let fibers: Fiber[] = [];
beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  writeConversation(ROOT, SELF, CONV, [
    { role: 'agent', agent_id: PEER, content: '请帮我查一下构建日志' },
    { role: 'context', agent_id: SELF, content: '机制材料：定时唤醒' },
    { role: 'agent', agent_id: SELF, content: '构建日志里有一条 timeout 错误，其余正常' },
  ], '# 概要\n本会话讨论了构建日志。');
  // 其他 agent 的账本（只搜自己：本行不得读取）
  writeConversation(ROOT, PEER, 'beta~gamma', [
    { role: 'agent', agent_id: PEER, content: '这是别的 agent 的会话内容' },
  ]);
});
afterEach(async () => {
  for (const fiber of [...fibers].reverse()) if (fiber.uid !== null) await fiber.dispose();
  fibers = [];
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function boot() {
  const ctx = new Context();
  const toolsFiber = ctx.plugin(class extends StubTools { constructor(c: Context) { super(c); } });
  await toolsFiber;
  const rowFiber = ctx.plugin(makeSessionQueryRow({ agentDir: AGENT_DIR, agentId: SELF }));
  await rowFiber;
  fibers.push(toolsFiber, rowFiber);
  return { tools: (ctx as unknown as { tools: StubTools }).tools };
}

describe('session-query 行（只搜自己）', () => {
  it('回放投影：summary 头 system + 自己 assistant / 对端 user（带 name）+ 机制行不入回放', async () => {
    const h = await boot();
    expect([...h.tools.tools.keys()].sort()).toEqual(['grep_history', 'read_history']);
    const r = await h.tools.call('read_history', {}, { conversationId: CONV, agentId: SELF }) as {
      ok: boolean; output: { total: number; messages: Array<{ index: number; role: string; name?: string; content: string }> };
    };
    expect(r.ok).toBe(true);
    expect(r.output.total).toBe(3); // summary + 两行真实发言（context 行不入回放）
    expect(r.output.messages[0]).toMatchObject({ index: 1, role: 'system' });
    expect(r.output.messages[1]).toMatchObject({ index: 2, role: 'user', name: PEER });
    expect(r.output.messages[2]).toMatchObject({ index: 3, role: 'assistant', content: expect.stringContaining('timeout') });
    expect(r.output.messages[2].name).toBeUndefined();
  });

  it('grep_history：正则命中 + 缺省当前会话 + 无命中空集', async () => {
    const h = await boot();
    const hit = await h.tools.call('grep_history', { pattern: 'timeout' }, { conversationId: CONV, agentId: SELF }) as {
      ok: boolean; output: { count: number; matches: Array<{ index: number; role: string; name?: string }> };
    };
    expect(hit.output.count).toBe(1);
    expect(hit.output.matches[0]).toMatchObject({ index: 3, role: 'assistant' });
    const miss = await h.tools.call('grep_history', { pattern: '不存在的东西' }, { conversationId: CONV, agentId: SELF }) as {
      ok: boolean; output: { count: number };
    };
    expect(miss.output.count).toBe(0);
  });

  it('read_history 分页：offset/limit + truncated/next_offset', async () => {
    const h = await boot();
    const page = await h.tools.call('read_history', { offset: 2, limit: 1 }, { conversationId: CONV, agentId: SELF }) as {
      output: { count: number; truncated?: boolean; next_offset?: number; messages: Array<{ index: number }> };
    };
    expect(page.output.count).toBe(1);
    expect(page.output.messages[0].index).toBe(2);
    expect(page.output.truncated).toBe(true);
    expect(page.output.next_offset).toBe(3);
  });

  it('只搜自己：他域会话 / 非法键 / 空 pattern 全 fail-loud（不静默空集）', async () => {
    const h = await boot();
    // 他 agent 的会话键：本域无该会话 → 明确报错（不越域读 beta~gamma）
    const other = await h.tools.call('read_history', { conversation_id: 'beta~gamma' }, { agentId: SELF }) as {
      ok: boolean; error: string;
    };
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/只搜自己/);
    // 路径穿越键被词法闸拦
    const escape = await h.tools.call('grep_history', { pattern: '.', conversation_id: '../../beta' }, { agentId: SELF }) as {
      ok: boolean; error: string;
    };
    expect(escape.ok).toBe(false);
    expect(escape.error).toMatch(/会话键非法/);
    // 空 pattern / 无效正则
    const empty = await h.tools.call('grep_history', { pattern: '  ' }, { conversationId: CONV, agentId: SELF }) as { ok: boolean };
    expect(empty.ok).toBe(false);
    const bad = await h.tools.call('grep_history', { pattern: '(' }, { conversationId: CONV, agentId: SELF }) as {
      ok: boolean; error: string;
    };
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/无效的正则/);
    // 无会话上下文
    const noctx = await h.tools.call('read_history', {}, {}) as { ok: boolean; error: string };
    expect(noctx.ok).toBe(false);
    expect(noctx.error).toMatch(/缺少会话上下文/);
  });
});
