// ============================================================
// ac-session：程序化模式性能修复（2026-09-19）——收束 vacuum /
// subcall result 截断 / tail 增量小窗
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-perf-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [agentsRow, sessionRow];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, { root });
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).agents && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('程序化模式性能修复', () => {
  it('收束 vacuum：run 正常收束后 partial 行与 subcall/直调补行被物理剔除（读侧零变化）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    // 活跃 run：用户消息 + partial 步行 + 直调补行 + 2 条 subcall 补行
    ctx.emit('router/message-received', 'a', { role: 'user', content: '跑' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', {
      text: '', reasoning: '编排',
      toolCalls: [{ id: 'call-0', name: 'run_code', arguments: { code: 'return 1;' } }],
    } as never, { conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('tool/after-execute', { name: 'run_code', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0' }, { ok: true, output: { summary: {} } }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#1', runCodeSubcall: true, args: { file_path: 'a.ts' } }, { ok: true, output: 'x'.repeat(5000) }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#2', runCodeSubcall: true, args: { file_path: 'b.ts' } }, { ok: true, output: { path: 'b.ts' } }, undefined);
    // 正常收束（带同 run 键——吸收 partial）
    ctx.emit('router/reply-completed', 'a', '完成', {
      steps: [{
        index: 0, text: '', reasoning: '编排', ts: 1,
        toolCalls: [{ id: 'call-0', name: 'run_code', arguments: { code: 'return 1;' } }],
        toolResults: [{ ok: true, output: { summary: {} } }],
      }, { index: 1, text: '完成', reasoning: '', ts: 2, toolCalls: [], toolResults: [] }],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~user', 'user', 'user');
    // vacuum 经 flush 微任务链异步发生——等它落定
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    // partial 行与模型直调补行剔除（真死重）
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"tool_call_id":"call-0"'); // 直调（run_code 宿主自身）补行剔除
    // subcall 补行保留——子调用卡片唯一数据源（UI 回放依赖）
    expect(raw).toContain('"tool_call_id":"call-0#1"');
    expect(raw).toContain('"tool_call_id":"call-0#2"');
    // 会话事实保留：入站消息 + 收束行（steps 带结果）
    expect(raw).toContain('"content":"跑"');
    expect(raw).toContain('"content":"完成"');
    // 读侧零变化：records = 入站 + 收束两条，steps 结果齐全
    const recs = await ctx.session.records('a~user', { subcalls: true });
    expect(recs).toHaveLength(2);
    expect(recs[1].steps![0].toolCalls![0].result).toEqual({ ok: true, output: { summary: {} } });
    // subcalls 投影：收束行注入仍可用（子调用平铺进宿主 run_code 调用后）
    const withSubs = await ctx.session.records('a~user', { subcalls: true });
    expect(withSubs).toHaveLength(2);
    const settled = withSubs.find((r) => r.run !== undefined && r.partial !== true);
    const tcs = settled?.steps?.[0]?.toolCalls ?? [];
    expect(tcs.map((t) => t.id)).toEqual(['call-0', 'call-0#1', 'call-0#2']);
    expect(tcs[1]).toMatchObject({ name: 'read', subcall: true });
    // 截断形结果（5KB > 2KB 阈值）
    expect((tcs[1].result as any).__truncated).toBe(true);
    expect(tcs[2]).toMatchObject({ name: 'read', subcall: true, result: { ok: true, output: { path: 'b.ts' } } });
  });

  it('subcall 补行 result 截断：超 2KB 的结果落盘为截断标记形（直调补行不截断）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '跑' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    // 未收束 run：subcall 补行落盘（run 中断场景）
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#1', runCodeSubcall: true, args: { file_path: 'big.ts' } }, { ok: true, output: 'y'.repeat(5000) }, undefined);
    // 直调补行（大结果）——不截断（部分行覆盖源，KV 字节保真）
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-1' }, { ok: true, output: 'z'.repeat(5000) }, undefined);
    await new Promise((r) => setTimeout(r, 30));
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    const sub = JSON.parse(raw.split('\n').find((l) => l.includes('call-0#1'))!);
    expect(sub.result.__truncated).toBe(true);
    expect(sub.result.bytes).toBeGreaterThan(5000);
    expect(typeof sub.result.head).toBe('string');
    const direct = JSON.parse(raw.split('\n').find((l) => l.includes('"tool_call_id":"call-1"'))!);
    expect(direct.result.output).toBe('z'.repeat(5000)); // 直调不截断
  });

  it('tail 增量小窗：多轮小 append 后 tail 仍正确（小窗试探路径）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 预置一条普通消息 + 首次 tail（建立基线）
    await ctx.session.append('a~user', 'user', { role: 'user', content: '第一条' });
    expect(ctx.session.tail('a~user')?.content).toBe('第一条');
    // run 活跃期多轮小 append（模拟步级 checkpoint + 消息）
    for (let i = 0; i < 8; i++) {
      await ctx.session.append('a~user', 'user', { role: 'user', content: '增量' + i });
      const t = ctx.session.tail('a~user');
      expect(t?.content).toBe('增量' + i);
    }
    // 大段新增（超小窗）——回落大窗路径仍正确
    await ctx.session.append('a~user', 'user', { role: 'user', content: '大段'.repeat(30000) });
    expect(ctx.session.tail('a~user')?.content).toContain('大段');
  });
});
