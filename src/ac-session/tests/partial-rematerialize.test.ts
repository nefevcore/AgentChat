// ============================================================
// partial 行物化防御（2026-09-23 思考重复卡修复）三层回归：
//   层1 rewriteMessages 过滤 partial 行（compact/deleteMessage/truncateAfter）
//   层2 records() 插回前双源去重（messages 已物化 → partials 不再插回）
//   层3 迁移 v4 partial-rematerialize-purge（存量物化行清除，幂等）
// 背景：归档 run 调 records()（投影含未收束 run 的 partial 行）→ keep 集物化
// 写回 messages.jsonl → 此后双源同读恒两份 → UI 同一思考内容两张卡。
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

/** 未收束 run 的 partial 行（模拟旧版落盘 / journal 活投影物化形态） */
const partialLine = (run: string, seq: number, rc: string, mid: string) => JSON.stringify({
  role: 'agent', content: '', agent_id: 'a', message_id: mid,
  timestamp: '2026-09-17T05:10:35.321Z', seq, reasoning_content: rc,
  steps: [{ content: '', reasoning: rc }], partial: true, run,
});

describe('partial 行物化防御（思考重复卡修复）', () => {
  it('层2：messages 已物化的 partial 行 → partials 同行不再插回（无双份投影）', async () => {
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    const rc = '用户报告了一个 UI 显示 BUG：思考内容卡片重复出现';
    // messages.jsonl：正常收束行 + 物化 partial 行（09-22 归档事故形态）
    writeFileSync(join(dir(), 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      JSON.stringify({ role: 'agent', content: '问', agent_id: 'user', message_id: 'm1', timestamp: '2026-09-17T05:09:00.000Z', seq: 1 }),
      partialLine('run-x', 2, rc, 'msg-p1'),
    ].join('\n') + '\n');
    // partials.jsonl：同一行的原版（双源）
    writeFileSync(join(dir(), 'partials.jsonl'), partialLine('run-x', 2, rc, 'msg-p1') + '\n');
    const recs = await ctx.session.records('a~user');
    const hits = recs.filter(r => (r.reasoning_content ?? '') === rc);
    expect(hits.length).toBe(1); // 物化行在场 → 插回行去重
  });

  it('层2 兜底：messages 无物化行时 partials 原行照常投出（不误伤）', async () => {
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    const rc = '正常未收束 run 的思考';
    writeFileSync(join(dir(), 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
    ].join('\n') + '\n');
    writeFileSync(join(dir(), 'partials.jsonl'), partialLine('run-y', 2, rc, 'msg-p2') + '\n');
    const recs = await ctx.session.records('a~user');
    expect(recs.filter(r => (r.reasoning_content ?? '') === rc).length).toBe(1);
  });

  it('层1：compact 的 keep 含投影 partial 行 → 重写后 messages 无物化行', async () => {
    const ctx = await boot();
    mkdirSync(dir(), { recursive: true });
    const rc = '归档时刻未收束的思考';
    writeFileSync(join(dir(), 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      JSON.stringify({ role: 'agent', content: '问', agent_id: 'user', message_id: 'm1', timestamp: '2026-09-20T00:00:00.000Z', seq: 1 }),
    ].join('\n') + '\n');
    writeFileSync(join(dir(), 'partials.jsonl'), partialLine('run-z', 2, rc, 'msg-p3') + '\n');
    // 模拟归档：records()（投影含 partial 行）全量作 keep 传 compact
    const snapshot = await ctx.session.records('a~user');
    await ctx.session.compact('a~user', { keep: snapshot, baselineSeq: 3 });
    const rewritten = readFileSync(join(dir(), 'messages.jsonl'), 'utf-8');
    expect(rewritten).not.toContain('"partial":true'); // 投影行未物化
    expect(rewritten).toContain('问'); // 正常行保留
    // partials.jsonl 原行不动 → 思考仍可恢复
    expect(readFileSync(join(dir(), 'partials.jsonl'), 'utf-8')).toContain(rc);
  });

  it('层3：迁移 v4 清除主文件物化 partial 行（幂等：重跑不重复）', async () => {
    const { SESSION_MIGRATIONS } = await import('ac-session/src/migrations.ts');
    const v4 = SESSION_MIGRATIONS.find(m => m.id === 'partial-rematerialize-purge');
    expect(v4).toBeTruthy();
    expect(v4!.version).toBe(4);
    mkdirSync(join(tmp, 'sessions', 'b~user'), { recursive: true });
    const rc = '旧物化残留思考';
    const line = partialLine('run-w', 5, rc, 'msg-p4');
    writeFileSync(join(tmp, 'sessions', 'b~user', 'messages.jsonl'), [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      line,
    ].join('\n') + '\n');
    v4!.apply(tmp);
    const msgs = readFileSync(join(tmp, 'sessions', 'b~user', 'messages.jsonl'), 'utf-8');
    expect(msgs).not.toContain('"partial":true');
    // 幂等：再跑一次不产生重复（身份剔除）
    v4!.apply(tmp);
    const partLines = readFileSync(join(tmp, 'sessions', 'b~user', 'partials.jsonl'), 'utf-8')
      .split('\n').filter(x => x.trim());
    expect(partLines.filter(l => l.includes('msg-p4')).length).toBe(1);
  });
});

