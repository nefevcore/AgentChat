// ============================================================
// ac-dev-tools：宿主半边（loop/after-run 消费 toolInterrupt →
// 执行热重载 + 回投续跑）+ 工具体（read_logs / reload / reload_modules）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as devRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

/** 假 HMR：记录 reloadFiles 调用 */
let reloadedUrls: string[] = [];
let discovered: string[] = [];
class FakeHmrService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'hmr');
  }
  async reloadFiles(urls: string[]): Promise<{ ok: boolean; reloaded: string[] }> {
    reloadedUrls = urls;
    return { ok: true, reloaded: urls };
  }
  async changedSinceWatermark(): Promise<string[]> {
    return discovered;
  }
}

/** 假 conversation：记录投递 */
let delivered: Array<{ agent: string; message: string; options: Record<string, unknown> }> = [];
class FakeConversationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }
  deliver(agent: string, message: string, options: Record<string, unknown> = {}) {
    delivered.push({ agent, message, options });
    return Promise.resolve({ kind: 'run' as const });
  }
}

/** 假 loader：entries() 返回带 refresh/filename 的 include 子树 */
let includeRefreshed: string[] = [];
class FakeLoaderService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'loader');
  }
  entries() {
    return [{
      subtree: {
        filename: 'cordis.yml',
        refresh: async () => {
          includeRefreshed.push('cordis.yml');
        },
      },
    }];
  }
}

async function boot(opts: { hmr?: boolean; conversation?: boolean; loader?: boolean } = {}) {
  reloadedUrls = [];
  discovered = [];
  delivered = [];
  includeRefreshed = [];
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    toolsRow,
    ...(opts.hmr === false ? [] : [FakeHmrService]),
    ...(opts.conversation === false ? [] : [FakeConversationService]),
    ...(opts.loader ? [FakeLoaderService] : []),
    devRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools) break;
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
});

type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

describe('ac-dev-tools 宿主半边（reload 意图执行 + 回投续跑）', () => {
  it('reload-modules（显式 paths）→ hmr.reloadFiles 收到 file URL + 原会话回投 [系统通知] 续跑', async () => {
    const { ctx } = await boot();
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user', source: 'user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'reload-modules', paths: ['src/x.ts'] } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadedUrls).toHaveLength(1);
    expect(reloadedUrls[0]).toMatch(/[/\\]src[/\\]x\.ts$/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ agent: 'dev' });
    expect(delivered[0].message).toContain('[系统通知]');
    expect(delivered[0].message).toContain('模块热重载完成');
    expect(delivered[0].message).toContain('可继续刚才的任务');
    expect(delivered[0].options).toMatchObject({ sender: 'dev', source: 'event', conversationId: 'dev~user' });
  });

  it('reload-modules（无 paths）→ 水位线发现驱动 reloadFiles；HMR 缺席 → 如实报告仍回投', async () => {
    const { ctx } = await boot();
    discovered = ['file:///repo/src/y.ts'];
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'reload-modules' } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadedUrls).toEqual(['file:///repo/src/y.ts']);

    const noHmr = await boot({ hmr: false });
    noHmr.ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'reload-modules' } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadedUrls).toEqual([]); // 未执行
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toContain('HMR 未启用');
  });

  it('reload（含 include 子树）→ include.refresh 执行 + 回投「配置热重载完成」', async () => {
    const { ctx } = await boot({ loader: true });
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'reload' } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(includeRefreshed).toEqual(['cordis.yml']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toContain('配置热重载完成');
    expect(delivered[0].message).toContain('可继续刚才的任务');
  });

  it('reload（无 include 子树——非 yml 驱动 boot 形态）→ 如实报告未执行，仍回投', async () => {
    const { ctx } = await boot();
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'reload' } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(includeRefreshed).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toContain('未找到 include 配置子树');
  });

  it('非 reload 意图的中断收束 → 不触发（system-restart 等归各自宿主半边）', async () => {
    const { ctx } = await boot();
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      {
        steps: [], text: '', finish: 'interrupted',
        interruptReason: { type: 'tool-interrupt', toolInterrupt: { type: 'system-restart' } },
        usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
      } as never,
    );
    ctx.emit('loop/after-run',
      { agent: 'dev', conversationId: 'dev~user' } as never,
      { steps: [], text: '正常收束', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadedUrls).toEqual([]);
    expect(delivered).toEqual([]);
  });
});

// ---- 工具体面：工具只发语义化中断 / 只读缓冲，宿主级行为不在此触发 ----
describe('ac-dev-tools 工具体', () => {
  it('read_logs：环形缓冲收集 ctx.logger 输出；级别/关键词过滤；clear 清空', async () => {
    const { ctx } = await boot();
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
    // limit 钳位：0/非数 → 100 缺省、>500 → 500（clamp 锁定）
    const clamped = await exec(ctx, { name: 'read_logs', args: { limit: 99999 } });
    expect(clamped.output.count).toBeLessThanOrEqual(500);
    await exec(ctx, { name: 'read_logs', args: { clear: true } });
    ctx.logger.info('after-clear');
    const after = await exec(ctx, { name: 'read_logs', args: {} });
    expect(after.output.logs.join('\n')).toContain('after-clear');
    expect(after.output.logs.join('\n')).not.toContain('启动完成');
  });

  it('reload / reload_modules：语义化中断（interrupt 字段，不执行宿主级行为）', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'reload', args: {} });
    expect(r.ok).toBe(true);
    expect(r.interrupt).toMatchObject({ type: 'reload' });
    const r2 = await exec(ctx, { name: 'reload_modules', args: { paths: ['a.ts'] } });
    expect(r2.interrupt).toMatchObject({ type: 'reload-modules', paths: ['a.ts'] });
  });
});
