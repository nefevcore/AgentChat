// ============================================================
// ac-dev-tools / ac-restart / ac-session-query：
// 日志环形缓冲 + 语义化中断三件套 + 会话查询门面
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as devRow from 'ac-dev-tools';
import * as restartRow from 'ac-restart';
import * as queryRow from 'ac-session-query';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-devq-'));
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
    [devRow, undefined],
    [restartRow, undefined],
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
  delete process.env.AGENTCHAT_SUPERVISED;
});

describe('ac-dev-tools', () => {
  it('read_logs：环形缓冲收集 ctx.logger 输出；级别/关键词/条数过滤', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.logger.info('启动完成 port=3000');
    ctx.logger.warn('磁盘水位偏高');
    ctx.logger.error('连接失败');
    const r = await exec(ctx, { name: 'read_logs', args: {} });
    expect(r.ok).toBe(true);
    expect(r.output.count).toBeGreaterThanOrEqual(3);
    expect(r.output.logs.join('\n')).toContain('启动完成 port=3000');
    const warnOnly = await exec(ctx, { name: 'read_logs', args: { level: 'warn' } });
    expect(warnOnly.output.logs.join('\n')).not.toContain('启动完成');
    expect(warnOnly.output.logs.join('\n')).toContain('磁盘水位偏高');
    const kw = await exec(ctx, { name: 'read_logs', args: { keyword: '连接' } });
    expect(kw.output.count).toBeGreaterThanOrEqual(1);
    expect(kw.output.logs.join('\n')).toContain('连接失败');
  });

  it('read_logs clear 清空缓冲', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.logger.info('x', 'before-clear');
    await exec(ctx, { name: 'read_logs', args: { clear: true } });
    ctx.logger.info('x', 'after-clear');
    const r = await exec(ctx, { name: 'read_logs', args: {} });
    expect(r.output.logs.join('\n')).toContain('after-clear');
    expect(r.output.logs.join('\n')).not.toContain('before-clear');
  });

  it('reload / reload_modules：语义化中断（interrupt 字段，不执行宿主级行为）', async () => {
    const { ctx } = await boot(tmpRoot());
    const r = await exec(ctx, { name: 'reload', args: { scope: 'global' } });
    expect(r.ok).toBe(true);
    expect(r.interrupt).toMatchObject({ type: 'reload', reason: 'scope=global' });
    const r2 = await exec(ctx, { name: 'reload_modules', args: { paths: ['a.ts'] } });
    expect(r2.interrupt).toMatchObject({ type: 'reload-modules', paths: ['a.ts'] });
  });
});

describe('ac-restart', () => {
  it('非 Supervisor 模式拒绝', async () => {
    const { ctx } = await boot(tmpRoot());
    delete process.env.AGENTCHAT_SUPERVISED;
    const r = await exec(ctx, { name: 'system_restart', args: { reason: 'test' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Supervisor');
  });

  it('Supervisor 模式：语义化中断 system-restart', async () => {
    const { ctx } = await boot(tmpRoot());
    process.env.AGENTCHAT_SUPERVISED = '1';
    const r = await exec(ctx, { name: 'system_restart', args: { reason: '升级依赖' } });
    expect(r.ok).toBe(true);
    expect(r.interrupt).toMatchObject({ type: 'system-restart', reason: '升级依赖' });
  });
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

  it('# 会话引用约定：生效工具集含 read_history 才注入（owner 行条件安装）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);

    async function runWithTools(tools?: string[]): Promise<string | undefined> {
      const call = { request: { tools, messages: [] as unknown[] } };
      await ctx.waterfall('loop/before-run', call as never, async () => ({ finish: 'stop' }) as never);
      return (call.request as { system?: string }).system;
    }

    const withHistory = await runWithTools(['read_history', 'grep_history']);
    expect(withHistory).toContain('[引用约定]');
    expect(withHistory).toContain('#<标题>(<会话 id>)');
    expect(withHistory).toContain('conversation_id');
    // 白名单不含 read_history → 不注入
    const without = await runWithTools(['grep_history']);
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
});
