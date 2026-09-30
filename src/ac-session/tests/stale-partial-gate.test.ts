// ============================================================
// ac-session：陈年未收束 partial 行防御（cr-44）
// 收束行丢失（09-25 双进程并发写事故/人工切分）后，孤儿 partial 行被
// 读侧活投为「中断恢复源」——超 7 天即无恢复价值，只喂幻觉（news 幻影
// 回放根因）。本文件钉住三条物化路径的统一闸门：主文件物化残留 /
// partials 旧形态尾部插回 / 新鲜对照（不误伤在途 run）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as loopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
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

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, agentsRow, loopRow, routerRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never);
    await fiber;
    fibers.push(fiber);
  }
  {
    const fiber = ctx.plugin(sessionRow, { root: tmp });
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  ctx.agents.register({ id: 'a', model: 'none' });
  return ctx;
}

const dir = () => join(tmp, 'sessions', 'a~user');
const header = JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString() });
// 陈年 = 8 天前；新鲜 = 1 小时前
const staleTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
const freshTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/** partial 行（工具结果齐全的中断形态；三个落点共用同构行） */
const partialLine = (run: string, ts: string, rc: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  role: 'agent', content: '', agent_id: 'a', message_id: 'm-' + run,
  timestamp: ts, seq: 2, reasoning_content: rc,
  steps: [{ content: '', reasoning: rc, toolCalls: [] }], partial: true, run, ...extra,
});

describe('陈年未收束 partial 行防御（cr-44）', () => {
  it('主文件物化残留：timestamp 超 7 天的 partial 行不投出（盘上保留）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-stale-'));
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'messages.jsonl'), [
      header,
      JSON.stringify({ role: 'agent', content: '问', agent_id: 'user', message_id: 'm1', timestamp: freshTs, seq: 1 }),
      partialLine('run-old', staleTs, '陈年孤儿思考'),
    ].join('\n') + '\n');
    const recs = await ctx.session.records('a~user');
    expect(recs.some((r) => (r.reasoning_content ?? '') === '陈年孤儿思考')).toBe(false);
    // 盘上不动（审计/迁移可见——闸门只作用于回放投影）
    expect(readFileSync(join(dir(), 'messages.jsonl'), 'utf-8')).toContain('陈年孤儿思考');
  });

  it('partials 旧形态插回：陈年孤儿不投出，新鲜孤儿照常投出（同文件两态对照）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-stale-'));
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'messages.jsonl'), header + '\n');
    writeFileSync(join(dir(), 'partials.jsonl'), [
      partialLine('run-old', staleTs, '陈年孤儿思考'),
      partialLine('run-new', freshTs, '新鲜未收束思考'),
    ].join('\n') + '\n');
    const recs = await ctx.session.records('a~user');
    expect(recs.some((r) => (r.reasoning_content ?? '') === '陈年孤儿思考')).toBe(false);
    expect(recs.some((r) => (r.reasoning_content ?? '') === '新鲜未收束思考')).toBe(true);
  });

  it('history() LLM 回放同口径：陈年孤儿不进上下文', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-stale-'));
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'messages.jsonl'), [
      header,
      partialLine('run-old', staleTs, '陈年孤儿思考', { content: '陈年孤儿正文' }),
    ].join('\n') + '\n');
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    expect(replay.some((m) => (m.content ?? '').includes('陈年孤儿'))).toBe(false);
  });

  it('无 timestamp 的 partial 行：无法判龄 → 宁投勿丢', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-stale-'));
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    const line = JSON.parse(partialLine('run-nots', staleTs, '无时间戳思考'));
    delete line.timestamp;
    writeFileSync(join(dir(), 'messages.jsonl'), [header, JSON.stringify(line)].join('\n') + '\n');
    const recs = await ctx.session.records('a~user');
    expect(recs.some((r) => (r.reasoning_content ?? '') === '无时间戳思考')).toBe(true);
  });
});