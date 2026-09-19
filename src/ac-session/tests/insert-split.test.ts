// ============================================================
// ac-session/tests/insert-split.test.ts —— 插入切分（变体乙）
//
// skill-injection-and-storage-vocab §6：run 进行中插入消息（steer /
// 技能 context）到达消费点时切分——关闭行（吸收切分前步）→ 插入行 →
// 新 run 键。自然顺序即回放序（KV 前缀保真）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
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

/** 两步脚本：首步 load_skill 工具调用 → 次步文本收束 */
function loadThenTextProvider() {
  let n = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      if (n++ === 0) {
        yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'load_skill', argumentsDelta: '{"name":"pdf-export"}' }] } as never;
        yield { delta: '', finish: 'tool_calls' as const } as never;
      } else {
        yield { delta: 'done' };
        yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } };
      }
    },
  });
}

async function boot(provider: () => { stream: (input: LlmChatInput) => AsyncIterable<LlmStreamChunk> }) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, { name: 'mock', inject: ['llm'], apply(c: Context) { c.llm.register('mock', provider, { models: ['mock-1'] }); } }, agentsRow, loopRow] as unknown[]) {
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
  return ctx;
}

describe('插入切分（变体乙：run 中插入 → 关闭行 + 插入行 + 新 run 键）', () => {
  it('run_code 子调用 load_skill → 落盘序：user → 关闭行(step1) → context → run 行(step2)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-split-'));
    const ctx = await boot(loadThenTextProvider());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // load_skill 工具体模拟 run_code 子调用形态（runCodeSubcall）
    let loaded = false;
    ctx.tools.register({
      name: 'load_skill',
      description: 'test',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execute: (_args, call) => {
        loaded = true;
        // 触发技能行同款落账路径：session.recordContext(split) —— 由 after-execute 模拟
        const session = ctx.get('session') as { recordContext(cid: string, aid: string, content: string, extra: { source: string; label?: string; split?: boolean }): string } | undefined;
        if (session && !loaded) return { ok: true, output: {} };
        if (session) {
          session.recordContext('a~user', 'a', '<skill_content name="pdf-export"># 正文</skill_content>', { source: 'skill', label: '已加载技能 pdf-export', split: true });
        }
        return { ok: true, output: { name: 'pdf-export', status: 'injected' } };
      },
    });
    const result = await ctx.agentLoop.run({
      agent: 'a',
      model: 'mock-1',
      conversationId: 'a~user',
      messages: [{ role: 'user', content: 'load pdf' }],
    });
    // 直调 agentLoop 无 router——手动发 reply-completed 触发收束入账（与 session.integration.test 同款）
    ctx.emit('router/reply-completed', 'a', result.text, result, 'a~user', 'user', 'user');
    await new Promise((resolve) => setTimeout(resolve, 50)); // flush 窗口
    const raw = readFileSync(join(tmp, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    const rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    // 形态断言（按 seq 序）：
    // 1 header + 2 user 消息 + 3 关闭行（partial 吸收后的 steps:[step1]）+ 4 context + 5 收束行（steps 只含 step2）
    const stepsOf = (r: Record<string, unknown>) => (Array.isArray(r.steps) ? (r.steps as Array<{ toolCalls?: Array<{ name?: string }> }>) : []);
    const closed = rows.find((r) => stepsOf(r).length > 0 && stepsOf(r)[0]?.toolCalls?.[0]?.name === 'load_skill' && r.partial !== true);
    expect(closed).toBeDefined(); // 关闭行携带 step1（load_skill 调用对，真实结果）
    const ctxRow = rows.find((r) => r.role === 'context' && r.source === 'skill');
    expect(ctxRow).toBeDefined();
    // 顺序：关闭行 seq < context seq < 收束行 seq
    const seq = (r: Record<string, unknown>) => r.seq as number;
    const finalRow = rows.filter((r) => r.role === 'agent' && r.steps !== undefined && r.partial !== true).at(-1);
    expect(finalRow).toBeDefined();
    expect(seq(closed!)).toBeLessThan(seq(ctxRow!));
    expect(seq(ctxRow!)).toBeLessThan(seq(finalRow!));
    // 收束行不含 load_skill 步（已被关闭行吸收）
    const finalSteps = (finalRow!.steps as Array<{ toolCalls?: Array<{ name: string }> }>);
    expect(finalSteps.every((s) => !(s.toolCalls ?? []).some((tc) => tc.name === 'load_skill'))).toBe(true);
    // 【核心验收】关闭行 result 经 partials 补行覆盖为真实终值（读侧 records()）：
    // raw 文件中关闭行 result:null 恒存在（摘除档案如实保留），覆盖发生在读取投影
    let partDbg = '(缺失)';
    try { partDbg = readFileSync(join(tmp, 'sessions', 'a~user', 'partials.jsonl'), 'utf-8'); } catch { partDbg = '(不存在)'; }
    console.log('PARTIALS rows=' + partDbg.split('\n').filter((x) => x.trim()).length + ' supplement=' + partDbg.includes('tool-result') + ' loadSkill=' + partDbg.includes('load_skill') + ' first120=' + partDbg.replace(/[\r\n]+/g, '||').substring(0, 200));
    const recs = await ctx.session.records('a~user');
    console.log('RECS:', recs.map((r) => (r.role ?? '?') + ':run=' + (r.run ?? '-') + ':partial=' + String(r.partial === true) + ':results=' + JSON.stringify((r.steps ?? []).flatMap((s) => (s.toolCalls ?? []).map((tc) => tc.name + '=' + JSON.stringify(tc.result).slice(0, 40))))).join(' || '));
    const closedRec = recs.find((r) => r.run !== undefined && r.partial !== true && (r.steps ?? []).some((s) => (s.toolCalls ?? []).some((tc) => tc.name === 'load_skill' && tc.result !== null && tc.result !== undefined)));
    expect(closedRec).toBeDefined(); // 关闭行的 load_skill 调用已带真实结果
    // partials.jsonl 存在且含补行（终值档案）；主文件无 partial/补行（零死重）
    let partRaw = '(不存在)';
    try { partRaw = readFileSync(join(tmp, 'sessions', 'a~user', 'partials.jsonl'), 'utf-8'); } catch { partRaw = '(缺失)'; }
    console.log('PARTIALS:', partRaw.split('\n').filter((x) => x.trim()).length, '行; 含补行:', partRaw.includes('tool-result'));
    expect(partRaw).toContain('"type":"tool-result"');
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"type":"tool-result"');
  });
});
