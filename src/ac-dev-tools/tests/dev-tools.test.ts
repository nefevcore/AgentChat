// ============================================================
// ac-dev-tools：reload / reload_modules 宿主半边
// （loop/after-run 消费 toolInterrupt → 执行热重载 + 回投续跑通知）
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

async function boot(opts: { hmr?: boolean; conversation?: boolean } = {}) {
  reloadedUrls = [];
  discovered = [];
  delivered = [];
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    toolsRow,
    ...(opts.hmr === false ? [] : [FakeHmrService]),
    ...(opts.conversation === false ? [] : [FakeConversationService]),
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
