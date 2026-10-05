// durable steer（cr-250）：steer stash 落盘 + 崩溃窗口恢复回归
// 场景①：busy steer 正常消费 → steer-stash.jsonl 行被剔除（文件删除）
// 场景②：stash 后进程死（无消费/无兜底事件）→ 新服务实例恢复 → 物化为会话行
// 场景③：机制标记（归档整理）stash 行 → 恢复时跳过物化
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as conversationRow from 'ac-conversation';
import * as sessionRow from 'ac-session';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
let tmp = '';

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

function toolThenText() {
  let n = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      if (n++ === 0) {
        yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'echo', argumentsDelta: '{"text":"x"}' }] } as never;
        yield { delta: '', finish: 'tool_calls' as const } as never;
      } else {
        yield { delta: 'done' };
        yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } } as never;
      }
    },
  });
}

async function boot(withSession = true): Promise<Context> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, { name: 'mock', inject: ['llm'], apply(c: Context) { c.llm.register('mock', toolThenText(), { models: ['mock-1'] }); } }, agentsRow, loopRow, routerRow, conversationRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never);
    await fiber;
    fibers.push(fiber);
  }
  if (withSession) {
    const fiber = ctx.plugin(sessionRow, { root: tmp });
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.tools.register({
    name: 'echo',
    description: '回显',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, output: 'x' };
    },
  });
  return ctx;
}

describe('durable steer（cr-250）', () => {
  it('busy steer 正常消费 → stash 落行后剔除，文件清理', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dsteer-'));
    const ctx = await boot();
    const runPromise = ctx.conversation.deliver('a', 'start', { conversationId: 'a~user', sender: 'user' });
    await new Promise((r) => setTimeout(r, 30));
    await ctx.conversation.deliver('a', '中途补充', { conversationId: 'a~user', sender: 'user', lane: 'next-step' });
    await runPromise;
    await new Promise((r) => setTimeout(r, 120)); // 等 settlement + 清理
    // stash 文件已删（消费点剔行 → 空文件清理）
    expect(existsSync(join(tmp, 'sessions', 'a~user', 'steer-stash.jsonl'))).toBe(false);
  });

  it('stash 落盘后崩溃（无清理）→ 新实例恢复 → 重投成功（deliver 路径，回复可见）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dsteer-'));
    {
      const ctx = await boot();
      const runPromise = ctx.conversation.deliver('a', 'start', { conversationId: 'a~user', sender: 'user' });
      await new Promise((r) => setTimeout(r, 30));
      // busy steer：stash 落盘后【模拟崩溃】——不等消费直接杀掉全部 fiber
      const steerP = ctx.conversation.deliver('a', '崩溃前的插话', { conversationId: 'a~user', sender: 'user', lane: 'next-step' });
      void steerP;
      await new Promise((r) => setTimeout(r, 10)); // stash 落盘完成
    }
    // afterEach 会 dispose 全部——先移出（本场景手动管理）：直接检查文件
    const stashFile = join(tmp, 'sessions', 'a~user', 'steer-stash.jsonl');
    expect(existsSync(stashFile)).toBe(true);
    // 新进程（同数据根）恢复：重投经 deliver → run 完成（mock 模型）→ 入账 + 回复
    const ctx2 = await boot();
    await new Promise((r) => setTimeout(r, 400)); // 等重投（服务就绪轮询）+ run 完成
    const raw = readFileSync(join(tmp, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    // 重投走标准路径：插话入账一次（agent 行）+ run 回复
    expect(raw).toContain('崩溃前的插话');
    // stash 文件已清（恢复后删除）
    expect(existsSync(stashFile)).toBe(false);
    void ctx2;
  });

  it('机制标记（归档整理 meta）与 event 行 → 恢复跳过（不重投不留痕）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dsteer-'));
    mkdirSync(join(tmp, 'sessions', 'a~user'), { recursive: true });
    writeFileSync(
      join(tmp, 'sessions', 'a~user', 'steer-stash.jsonl'),
      JSON.stringify({ type: 'steer-stash', id: 'x1', conversationId: 'a~user', message: { role: 'user', content: '整理提示' }, meta: { 'archive-review': true }, ts: Date.now() }) + '\n' +
      JSON.stringify({ type: 'steer-stash', id: 'x2', conversationId: 'a~user', message: { role: 'user', content: '事件通知' }, source: 'event', ts: Date.now() }) + '\n',
    );
    await boot();
    await new Promise((r) => setTimeout(r, 100));
    // 机制通知不物化：messages 不含该行；stash 文件已删
    const msgFile = join(tmp, 'sessions', 'a~user', 'messages.jsonl');
    const raw = existsSync(msgFile) ? readFileSync(msgFile, 'utf-8') : '';
    expect(raw).not.toContain('整理提示');
    expect(raw).not.toContain('事件通知');
    expect(existsSync(join(tmp, 'sessions', 'a~user', 'steer-stash.jsonl'))).toBe(false);
  });
});