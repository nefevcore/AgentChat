// ============================================================
// ac-session：journal 步行落账即时可见性（2026-09-21 前端反馈 #2）
//
// 背景 bug：after-step 的 journalStep 只进内存队列，落盘依赖下一个
// tool/before-execute checkpoint 或 after-run settlement——纯文本步后的
// 窗口（下一步 LLM 流式期间可达数十秒）内 records() 读不到该步，前端
// 流式运行中刷新「前面 steps 丢失」。修复 = 落账即 flushBestEffort。
//
// 本文件钉住：run 进行中（run-started 后无 after-run），after-step 落账的
// 步行在 records()/history 立即可见。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-jstep-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [agentsRow, sessionRow] as any[]) {
    const fiber = ctx.plugin(row, { root });
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

describe('journal 步行即时可见（run 进行中刷新可恢复 steps）', () => {
  it('after-step 落账后（无后续 checkpoint/收束）records() 立即含该步', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'alpha', model: 'none' });
    const conv = 'alpha~user';
    const env = { conversationId: conv, sender: 'user' };

    // run 开始 + 两步完成（纯文本步——修复前落账后不 flush，下一个事件是
    // 下一步 LLM 流式期间到达的 delta，无 checkpoint）
    ctx.emit('loop/run-started', { agent: 'alpha', conversationId: conv, sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'alpha', {
      index: 0, text: '第一步正文', reasoning: '第一步思考', toolCalls: [], toolResults: [],
    } as never, env);
    ctx.emit('loop/after-step', 'alpha', {
      index: 1, text: '第二步正文', reasoning: '第二步思考', toolCalls: [], toolResults: [],
    } as never, env);

    // 不发 after-run（run 仍在途——模拟 LLM 第三步流式中用户刷新）。
    // 等待 flushBestEffort（fire-and-forget 微任务）落盘
    await new Promise((r) => setTimeout(r, 30));

    const records = await ctx.session.records(conv);
    const stepRows = records.filter((r: any) => Array.isArray(r.steps) && r.partial === true);
    expect(stepRows.length).toBeGreaterThanOrEqual(2);
    const bodies = stepRows.map((r: any) => `${r.steps[0]?.reasoning ?? ''}|${r.steps[0]?.content ?? ''}`);
    expect(bodies).toContain('第一步思考|第一步正文');
    expect(bodies).toContain('第二步思考|第二步正文');
    // agent_id 修复面：步行投影的 agent_id 必须是 run 的 Agent（对桶键
    // 'alpha~user' 字典序 alpha 在前——旧推导 split('~')[0] 此例侥幸正确，
    // 但 'user~zeta' 形恒错；此处断言行内 agentId 直传生效）
    expect(stepRows.every((r: any) => r.agent_id === 'alpha')).toBe(true);
  });

  it('对桶键 viewer 在前（如 user~zeta）：步行投影 agent_id 仍是 Agent（非 viewer）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'zeta', model: 'none' });
    const conv = 'user~zeta'; // 字典序 u < z → split('~')[0] = 'user'（viewer）
    ctx.emit('loop/run-started', { agent: 'zeta', conversationId: conv, sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'zeta', {
      index: 0, text: '答', reasoning: '思', toolCalls: [], toolResults: [],
    } as never, { conversationId: conv, sender: 'user' });
    await new Promise((r) => setTimeout(r, 30));

    const records = await ctx.session.records(conv);
    const stepRows = records.filter((r: any) => Array.isArray(r.steps) && r.partial === true);
    expect(stepRows.length).toBeGreaterThanOrEqual(1);
    // 修复前：agent_id = 'user'（viewer）→ 前端渲染成用户气泡/链断裂
    expect(stepRows[0].agent_id).toBe('zeta');
  });
});
