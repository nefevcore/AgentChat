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
    // partial 行与补行（直调 + 存量 subcall）剔除——主文件只剩会话事实
    expect(raw).not.toContain('"partial":true');
    expect(raw).not.toContain('"tool_call_id":"call-0"'); // 直调（run_code 宿主自身）补行剔除
    expect(raw).not.toContain('"tool_call_id":"call-0#1"'); // subcall 补行已迁 subcalls.jsonl
    // 会话事实保留：入站消息 + 收束行（steps 带结果）
    expect(raw).toContain('"content":"跑"');
    expect(raw).toContain('"content":"完成"');
    // subcalls.jsonl：子调用补行如实保留（UI 回放唯一数据源，不进主文件）
    const subFile = path.join(root, 'sessions', 'a~user', 'subcalls.jsonl');
    const subRaw = fs.readFileSync(subFile, 'utf-8');
    expect(subRaw).toContain('"tool_call_id":"call-0#1"');
    expect(subRaw).toContain('"tool_call_id":"call-0#2"');
    expect(subRaw).toContain('"subcall":true');
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
    // 如实记录（2026-09-20 截断废除）：5KB 结果全文在场，无截断标记
    expect((tcs[1].result as any).__truncated).toBeUndefined();
    expect((tcs[1].result as any).output).toBe('x'.repeat(5000));
    expect(tcs[2]).toMatchObject({ name: 'read', subcall: true, result: { ok: true, output: { path: 'b.ts' } } });
  });

  it('双文件分流：subcall 补行落 subcalls.jsonl 且如实不截断（2026-09-20 截断废除）', async () => {
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
    // subcall 全文如实落 subcalls.jsonl（无截断标记）
    const subFile = path.join(root, 'sessions', 'a~user', 'subcalls.jsonl');
    const subRaw = fs.readFileSync(subFile, 'utf-8');
    const sub = JSON.parse(subRaw.split('\n').find((l) => l.includes('call-0#1'))!);
    expect(sub.subcall).toBe(true);
    expect(typeof sub.seq).toBe('number'); // 行 seq（对齐 run_code 编排顺序）
    expect(sub.result.__truncated).toBeUndefined();
    expect(sub.result.output).toBe('y'.repeat(5000));
    // 直调不截断（KV 字节保真）；主文件无 subcall 行（直调补行在 partials.jsonl）
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('call-0#1');
    const partRaw = fs.readFileSync(path.join(root, 'sessions', 'a~user', 'partials.jsonl'), 'utf-8');
    const direct = JSON.parse(partRaw.split('\n').find((l) => l.includes('"tool_call_id":"call-1"'))!);
    expect(direct.result.output).toBe('z'.repeat(5000));
  });

  it('subcalls 行 seq：乱序到达（并行 Promise 完成序）→ 注入按落盘 seq（编排序）排', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '跑' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    // 模拟并行编排：提交序 #1 #2 #3，完成/落盘序乱（#3 先回、#1 后回）
    //（tool_call_id 尾段 = 程序内调用次序；行 seq = 到达落盘序——本用例
    // 验证注入排序采用 seq 而非尾段）
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#3', runCodeSubcall: true, args: { file_path: 'c.ts' } }, { ok: true, output: { path: 'c.ts' } }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#1', runCodeSubcall: true, args: { file_path: 'a.ts' } }, { ok: true, output: { path: 'a.ts' } }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#2', runCodeSubcall: true, args: { file_path: 'b.ts' } }, { ok: true, output: { path: 'b.ts' } }, undefined);
    // 正常收束（宿主 run_code 调用对在场 → 注入锚）
    ctx.emit('router/reply-completed', 'a', '完成', {
      steps: [{ index: 0, text: '', reasoning: '', ts: 1, toolCalls: [{ id: 'call-0', name: 'run_code', arguments: {} }], toolResults: [{ ok: true, output: {} }] }, { index: 1, text: '完成', reasoning: '', ts: 2, toolCalls: [], toolResults: [] }],
      finish: 'stop', usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~user', 'user', 'user');
    await new Promise((r) => setTimeout(r, 50));
    const recs = await ctx.session.records('a~user', { subcalls: true });
    // 无 partial 步行的 run → 收束行不带 run 键：按 run_code 调用对定位宿主记录
    const hostRec = recs.find((r) => r.steps?.some((s) => s.toolCalls?.some((t) => t.id === 'call-0')));
    const tcs = hostRec?.steps?.[0]?.toolCalls ?? [];
    // 注入序 = 行 seq（到达序 #3 #1 #2），非尾段序（#1 #2 #3）
    expect(tcs.map((t) => t.id)).toEqual(['call-0', 'call-0#3', 'call-0#1', 'call-0#2']);
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
