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
    // 形态断言（按 seq 序，settlement 切段——2026-11 journal 泛化）：
    // header + user 行 + 段行(steps:[step1]) + context 注入行 + 收束行
    const stepsOf = (r: Record<string, unknown>) => (Array.isArray(r.steps) ? (r.steps as Array<{ toolCalls?: Array<{ name?: string }> }>) : []);
    const segRow = rows.find((r) => stepsOf(r).length > 0 && stepsOf(r)[0]?.toolCalls?.[0]?.name === 'load_skill' && r.partial !== true);
    expect(segRow).toBeDefined(); // 段行携带 step1（load_skill 调用对，真实结果——settlement 时补行已并入）
    const ctxRow = rows.find((r) => r.role === 'context' && r.source === 'skill');
    expect(ctxRow).toBeDefined();
    // 顺序：段行 seq < 注入行 seq < 收束行 seq（journal 真序物化）
    const seq = (r: Record<string, unknown>) => r.seq as number;
    const finalRow = rows.filter((r) => r.role === 'agent' && r.run !== undefined).at(-1);
    expect(finalRow).toBeDefined();
    expect(seq(segRow!)).toBeLessThan(seq(ctxRow!));
    expect(seq(ctxRow!)).toBeLessThan(seq(finalRow!));
    // 段行的 load_skill 已带真实终值（settlement 在工具全部完成后物化——无 result:null 悬空）
    const segTc = stepsOf(segRow!)[0]?.toolCalls?.[0] as { result?: unknown } | undefined;
    expect(segTc?.result).toMatchObject({ ok: true, output: { name: 'pdf-export', status: 'injected' } });

    // 收束行退役（2026-11 裁决）：切分形态不落独立收束行——终文本在尾段末步；
    // settled 判别行在场（提交标记），段行携带 run 键（组存在性判定锚）
    expect(rows.some((r) => r.role === 'agent' && r.run !== undefined && !Array.isArray(r.steps) && (r.content ?? '') === '' && r.injected !== true)).toBe(false);
    expect(raw).toContain('"type":"run-settled"');
    expect(rows.filter((r) => r.role === 'agent' && Array.isArray(r.steps)).every((r) => typeof r.run === 'string')).toBe(true);
    // partials.jsonl 收束即清（journal 泛化——run 结束后无残留）；主文件零 partial/补行
    const partPath = join(tmp, 'sessions', 'a~user', 'partials.jsonl');
    let partRaw = '(不存在)';
    try { partRaw = readFileSync(partPath, 'utf-8'); } catch { /* 已清 = 语义正确 */ }
    expect(partRaw.replace(/[\r\n]+/g, '').replace(/^\{"type":"session-header".*\}$/, '')).toBe(''); // 空（仅头行或不存在）
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"type":"tool-result"');
  });
});
