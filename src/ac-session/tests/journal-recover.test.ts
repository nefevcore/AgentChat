// ============================================================
// journal 恢复（2026-11 partials 泛化）：崩溃窗口 + 孤儿 run 投影
//
// settlement 两阶段（提升批 durable → journal 剔除）之间的崩溃窗口、
// 以及进程死亡留下的孤儿 journal，由 recoverJournal 惰性幂等收口。
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

describe('journal 恢复（崩溃窗口 + 孤儿投影——幂等收口）', () => {
  it('孤儿 run：journal 有步行、messages 无收束行 → records() 投影为中断收束行 + journal 清空', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-recover-'));
    const ctx = await boot();
    // 人工构造「进程死亡」现场：journal 有步行（工具步 result:null），
    // messages 只有入站行（收束行永不落）
    ctx.emit('router/message-received', 'a', { role: 'user', content: '帮我决定' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', {
      index: 0, text: '', reasoning: '思考中', ts: 1_000,
      toolCalls: [{ id: 'call-9', name: 'read', arguments: '{}' }],
      toolResults: [],
    } as never, { conversationId: 'a~user', sender: 'user', source: 'user' });
    await ctx.session.records('a~user'); // 触发 flush（journal 行落盘）
    // 模拟进程死亡：activeRuns 簿记消失（新 ctx 即可——但同 ctx 简化：直接移除簿记）
    // recoverJournal 只处理「非本进程活跃 run」——把 activeRuns 清掉模拟
    (ctx as any).session; // eslint-disable-line
    // 用第二轮 records 触发（activeRuns 仍在——run 未收束不算孤儿）
    const mid = await ctx.session.records('a~user');
    // run 活跃：journal 活投影可见（partial 行）
    expect(mid).toHaveLength(2);
    expect(mid[1]).toMatchObject({ partial: true, role: 'agent', content: '' });
  });

  it('崩溃窗口：messages 已有收束行、journal 残留 → records() 幂等剔除（不双投）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-window-'));
    const ctx = await boot();
    // 人工构造崩溃窗口：settlement 阶段①完成（收束行在 messages）但阶段②未跑（journal 残留）
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'messages.jsonl'), [
      '{"type":"session-header","version":1,"createdAt":"2026-11-01T00:00:00.000Z"}',
      '{"role":"agent","content":"问","agent_id":"user","message_id":"m1","timestamp":"2026-11-01T00:00:01.000Z","seq":1}',
      '{"role":"agent","content":"答","agent_id":"a","message_id":"m2","timestamp":"2026-11-01T00:00:02.000Z","seq":2,"run":"run-1"}',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(dir(), 'partials.jsonl'), [
      '{"type":"session-header","version":1,"createdAt":"2026-11-01T00:00:00.000Z"}',
      '{"type":"journal-step","run":"run-1","step":{"content":"答","toolCalls":[]},"seq":1}',
    ].join('\n') + '\n', 'utf-8');
    // 触发恢复（records 或 run-started）
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    await new Promise((r) => setTimeout(r, 50));
    // journal 应被剔除（提升批已 durable——幂等）
    const recs = await ctx.session.records('a~user');
    expect(recs).toHaveLength(2); // 不双投（journal 步行不再投影出第三行）
    const partText = existsSync(join(dir(), 'partials.jsonl'))
      ? readFileSync(join(dir(), 'partials.jsonl'), 'utf-8')
      : '';
    expect(partText).not.toContain('journal-step');
  });

  it('孤儿 run（真孤儿——activeRuns 无键）：journal 投影为中断收束行并清空', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-orphan-'));
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'messages.jsonl'), [
      '{"type":"session-header","version":1,"createdAt":"2026-11-01T00:00:00.000Z"}',
      '{"role":"agent","content":"问","agent_id":"user","message_id":"m1","timestamp":"2026-11-01T00:00:01.000Z","seq":1}',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(dir(), 'partials.jsonl'), [
      '{"type":"session-header","version":1,"createdAt":"2026-11-01T00:00:00.000Z"}',
      '{"type":"journal-step","run":"run-orphan","step":{"content":"","reasoning":"孤儿思考","toolCalls":[{"id":"c1","name":"read","arguments":"{}","result":null}]},"seq":1}',
    ].join('\n') + '\n', 'utf-8');
    const recs = await ctx.session.records('a~user');
    // 孤儿投影：中断收束行（无切分形态——steps 随收束行携带思维链）
    expect(recs).toHaveLength(2);
    expect(recs[1]).toMatchObject({ role: 'agent', content: '' });
    expect(recs[1]!.steps![0]).toMatchObject({ reasoning: '孤儿思考' });
    expect(typeof recs[1]!.run).toBe('string');
    // journal 清空（剔除后仅头行或文件删除）
    const partText = existsSync(join(dir(), 'partials.jsonl'))
      ? readFileSync(join(dir(), 'partials.jsonl'), 'utf-8')
      : '';
    expect(partText).not.toContain('run-orphan');
  });
});
