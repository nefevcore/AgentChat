// ============================================================
// ac-session-query：会话查询门面（grep_history / read_history
// + # 会话引用指引 owner 行条件注入；跨会话 # 引用后端实证）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as queryRow from '../src/index.ts';

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-query-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [sessionRow, { root }],
    [queryRow, undefined],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).session) break;
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

describe('ac-session-query', () => {
  it('grep_history / read_history：执行身份定会话；正典 conversation_id 优先', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 经事件通道入账（message-received 只入账；reply-completed 落盘）
    ctx.emit('router/message-received', 'a', { role: 'user', content: '第一个问题：香槟怎么开' }, 'a');
    ctx.emit('router/message-received', 'a', { role: 'user', content: '第二个问题：红酒怎么醒' }, 'a');
    ctx.emit('router/reply-completed', 'a', '开香槟先摇十下', {
      steps: [], text: '开香槟先摇十下', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    }, 'a');
    await new Promise((r) => setTimeout(r, 100));

    const g = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: '香槟' },
      conversationId: 'a',
    });
    expect(g.ok).toBe(true);
    expect(g.output.count).toBe(2); // 问题 + 回复
    expect(g.output.matches[0]).toMatchObject({ role: 'user' });

    // 无身份 → 缺会话上下文错误
    const noId = await exec(ctx, { name: 'grep_history', args: { pattern: 'x' } });
    expect(noId.ok).toBe(false);
    expect(noId.error).toContain('会话上下文');

    const page = await exec(ctx, {
      name: 'read_history',
      args: { offset: 2, limit: 1 },
      conversationId: 'a',
    });
    expect(page.output.total).toBe(3);
    expect(page.output.messages[0]).toMatchObject({ index: 2, role: 'user' });
  });

  it('# 会话引用指引：历史工具或文件读取能力在场其一即注入（owner 行条件安装）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);

    async function runWithTools(tools?: string[]): Promise<string | undefined> {
      const call = { request: { tools, messages: [] as unknown[] } };
      await ctx.waterfall('loop/before-run', call as never, async () => ({ finish: 'stop' }) as never);
      return (call.request as { system?: string }).system;
    }

    // 历史工具在场 → 注入（教 conversation_id 用法 + 磁盘回退）
    const withHistory = await runWithTools(['read_history', 'grep_history']);
    expect(withHistory).toContain('[引用约定]');
    expect(withHistory).toContain('#<标题>(<会话 id>)');
    expect(withHistory).toContain('conversation_id');
    // 文件工具在场（无历史工具——标准预设形态）→ 仍注入（教磁盘路径分析）
    const fileOnly = await runWithTools(['read', 'grep', 'pwsh']);
    expect(fileOnly).toContain('[引用约定]');
    expect(fileOnly).toContain('sessions/<conversation_id>/messages.jsonl');
    // 无历史工具也无文件读取能力 → 不注入
    const without = await runWithTools(['ask_questions']);
    expect(without).toBeUndefined();
    // 缺省 = 全部已注册工具（本行注册了 read_history）→ 注入
    expect(await runWithTools(undefined)).toContain('[引用约定]');
  });

  it('跨会话查询（# 引用后端能力实证）：conversation_id 指向他会话 → 返回该会话内容', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 会话 target-sid：用户问 + Agent 答（属主 p1）。emit 签名 =
    // (agentId, message/payload, conversationId)——对桶键第三参
    ctx.emit('router/message-received', 'p1', { role: 'user', content: '周报里定的方案是什么' }, 'target-sid');
    ctx.emit('router/reply-completed', 'p1', '方案是分三步上线', {
      steps: [], text: '方案是分三步上线', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    }, 'target-sid');
    await new Promise((r) => setTimeout(r, 100));

    // 另一会话（cur-sid）的执行身份下，显式传 conversation_id 读 target-sid
    const page = await exec(ctx, {
      name: 'read_history',
      args: { conversation_id: 'target-sid' },
      conversationId: 'cur-sid',
      agentId: 'a',
    });
    expect(page.ok).toBe(true);
    expect(page.output.total).toBe(2);
    expect(page.output.messages.map((m: { content: string }) => m.content).join('\n')).toContain('分三步');

    const grep = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: '周报', conversation_id: 'target-sid' },
      conversationId: 'cur-sid',
      agentId: 'a',
    });
    expect(grep.ok).toBe(true);
    expect(grep.output.count).toBeGreaterThanOrEqual(1);
  });

  it('参数边界：无效正则 → 结构化报错；limit 越界钳制到 250 并给 note', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const bad = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: '(unclosed' },
      conversationId: 'a',
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('无效的正则表达式');

    // 260 条命中 > limit 上限 250（schema 声明 maximum: 250，实现同值钳制）
    for (let i = 0; i < 260; i++) {
      ctx.emit('router/message-received', 'a', { role: 'user', content: `SQBULK 批量 ${i}` }, 'a');
    }
    ctx.emit('router/reply-completed', 'a', '收工', {
      steps: [], text: '收工', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    }, 'a');
    await new Promise((r) => setTimeout(r, 100));
    const r = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: 'SQBULK', limit: 999 },
      conversationId: 'a',
    });
    expect(r.ok).toBe(true);
    expect(r.output.count).toBe(250);
    expect(r.output.note).toBe('已达返回上限 250 条（收窄 pattern）');
  });
});
