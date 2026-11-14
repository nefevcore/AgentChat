// ============================================================
// ac-permission-gate/tests/gate.test.ts —— 决策序全分支测试（cr-1066 批1b）
// 桩形态：真 ac-tools（注册/执行链）+ 真 ac-durable-interaction（memory
// 后端）+ 门行本体；convSettings/agents 软依赖用最小桩服务替代。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as diRow from 'ac-durable-interaction';
import * as gateRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** convSettings 桩（可写 Map——测会话键层） */
class ConvSettingsStub extends Service {
  store = new Map<string, Record<string, string>>();
  constructor(ctx: Context) { super(ctx, 'convSettings'); }
  get(id: string): Record<string, string> { return this.store.get(id) ?? {}; }
}

/** agents 桩（settingsOf——测 Agent settings 层；tiers——测 4.5 档位免审） */
class AgentsStub extends Service {
  settings: Record<string, Record<string, unknown>> = {};
  tiers: Record<string, string> = {};
  constructor(ctx: Context) { super(ctx, 'agents'); }
  get(id: string): { access?: string } | undefined {
    const t = this.tiers[id];
    return t === undefined ? undefined : { access: t };
  }
  settingsOf(_id: string, name?: string): unknown {
    return name === undefined ? this.settings : this.settings[name];
  }
}

interface BootOpts {
  gateConfig?: { onAsk?: 'allow' | 'ask' | 'deny'; riskGranted?: (owner: string) => boolean };
  convSettings?: Record<string, Record<string, string>>;
  agentSettings?: Record<string, Record<string, unknown>>;
  tiers?: Record<string, string>;
}

async function boot(opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const t = ctx.plugin(toolsRow as any); await t; fibers.push(t);
  const d = ctx.plugin(diRow as any, { backend: 'memory' }); await d; fibers.push(d);
  if (opts.convSettings !== undefined) {
    const f = ctx.plugin(ConvSettingsStub);
    await f; fibers.push(f);
    const svc = (ctx as any).convSettings as ConvSettingsStub;
    for (const [k, v] of Object.entries(opts.convSettings)) svc.store.set(k, v);
  }
  if (opts.agentSettings !== undefined) {
    const f = ctx.plugin(AgentsStub);
    await f; fibers.push(f);
    ((ctx as any).agents as AgentsStub).settings = opts.agentSettings;
  }
  if (opts.tiers !== undefined) {
    if (!(ctx as any).agents) {
      const f = ctx.plugin(AgentsStub);
      await f; fibers.push(f);
    }
    ((ctx as any).agents as AgentsStub).tiers = opts.tiers;
  }
  const g = ctx.plugin(gateRow as any, opts.gateConfig); await g; fibers.push(g);
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

/** 注册工具并返回「是否执行」探针——经具名插件行注册（owner = fiber 名，
 * 'ac-test-' 前缀落在信任面内；测不可信面用 evil-plugin 直挂对照） */
async function reg(ctx: Context, def: { name: string; needPermission?: boolean; risk?: (args: Record<string, unknown>) => 'allow' | 'ask' | 'deny' }) {
  let executed = 0;
  const f = ctx.plugin({
    name: 'ac-test-' + def.name,
    inject: ['tools'],
    apply(c: Context) {
      c.tools.register({
        name: def.name,
        ...(def.needPermission !== undefined ? { needPermission: def.needPermission } : {}),
        ...(def.risk !== undefined ? { risk: def.risk } : {}),
        execute: () => { executed += 1; return { ok: true }; },
      });
    },
  });
  await f;
  booted.at(-1)!.fibers.push(f);
  return { get executed() { return executed; } };
}

/** 执行（自动应答首张 approval 卡）——返回 {result, executed} */
async function runWithReply(ctx: Context, call: { name: string; args?: Record<string, unknown>; conversationId?: string; agentId?: string; runId?: string }, answer: unknown = { approved: true, scope: 'call' }) {
  const p = ctx.tools.execute(call);
  // 等审批卡出现
  for (let i = 0; i < 100; i++) {
    const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
    if (open.length > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const open = ctx.durableInteraction.listOpen({ kind: 'approval' });
  if (open.length > 0) ctx.durableInteraction.reply(open[0]!.id, answer as any);
  return await p;
}

describe('决策序 0：门视野外零开销放行', () => {
  it('无 risk 无 needPermission → 直通（不弹卡）', async () => {
    const { ctx } = await boot();
    const probe = await await reg(ctx, { name: 'plain' });
    const r = await ctx.tools.execute({ name: 'plain', args: {} });
    expect(r.ok).toBe(true);
    expect(probe.executed).toBe(1);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });
});

describe('决策序 1：信任面覆盖', () => {
  it('D11 risk 授予臂（cr-1074 批3）：grants 含 risk 的插件 → risk 自评采信（allow 直通）', async () => {
    const { ctx } = await boot({ gateConfig: { riskGranted: (owner) => owner === 'trusted-plugin' } });
    const f = ctx.plugin({ name: 'trusted-plugin', inject: ['tools'], apply(c: Context) {
      c.tools.register({
        name: 'granted-tool',
        risk: () => 'allow',
        execute: () => ({ ok: true }),
      });
    } });
    await f;
    const r = await ctx.tools.execute({ name: 'granted-tool', args: {} });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0); // 未弹卡——直通
  });

  it('D11 未授予臂：grants 不含该插件 → 建议被覆盖恒 ask（弹卡）', async () => {
    const { ctx } = await boot({ gateConfig: { riskGranted: () => false } });
    const f = ctx.plugin({ name: 'ungranted-plugin', inject: ['tools'], apply(c: Context) {
      c.tools.register({
        name: 'ungranted-tool',
        risk: () => 'allow',
        execute: () => ({ ok: true }),
      });
    } });
    await f;
    const r = await runWithReply(ctx, { name: 'ungranted-tool', args: {} });
    expect(r.ok).toBe(true); // 批准后放行——但弹卡了（覆盖生效）
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });

  it('不可信 risk=allow → 恒 ask（弹卡）', async () => {
    const { ctx } = await boot();
    // owner 非 ac- 前缀 = 不可信——用动态插件行注册（fiber 名 = 插件名）
    const f = ctx.plugin({ name: 'evil-plugin', inject: ['tools'], apply(c: Context) {
      c.tools.register({
        name: 'evil-allow',
        risk: () => 'allow',
        execute: () => ({ ok: true }),
      });
    } });
    await f;
    const r = await runWithReply(ctx, { name: 'evil-allow', args: {} });
    expect(r.ok).toBe(true); // 批准后放行
  });

  it('不可信 needPermission → 恒问（V4 等价映射 + 覆盖生效）', async () => {
    const { ctx } = await boot();
    const f = ctx.plugin({ name: 'evil-plugin', inject: ['tools'], apply(c: Context) {
      c.tools.register({
        name: 'evil-need',
        needPermission: true,
        execute: () => ({ ok: true }),
      });
    } });
    await f;
    const r = await runWithReply(ctx, { name: 'evil-need', args: {} });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });
});

describe('决策序 2/3/4：建议求值与直效直通', () => {
  it('可信 risk=deny → 拒（设置 allow 不豁免——自愿收紧不可放宽）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~alice': { approval: 'allow' } } });
    const probe = await await reg(ctx, { name: 'hard-deny', risk: () => 'deny' });
    const r = await ctx.tools.execute({ name: 'hard-deny', args: {}, conversationId: 'user~alice' });
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
  });

  it('可信 risk=allow → 直通（信任的收益——不弹卡不查设置）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~alice': { approval: 'deny' } } });
    const probe = await await reg(ctx, { name: 'safe-tool', risk: () => 'allow' });
    const r = await ctx.tools.execute({ name: 'safe-tool', args: {}, conversationId: 'user~alice' });
    expect(r.ok).toBe(true);
    expect(probe.executed).toBe(1);
  });

  it('risk throw → 按 ask（fail-closed 方向）', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'throwing', risk: () => { throw new Error('炸'); } });
    const r = await runWithReply(ctx, { name: 'throwing', args: {} });
    expect(r.ok).toBe(true); // 弹卡了（ask 路径）→ 批准放行
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });
});

describe('决策序 5：ask → 设置链 → 审批', () => {
  it('等价映射：needPermission=true 无 risk → ask（V6 存量语义）', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'legacy-need', needPermission: true });
    const r = await runWithReply(ctx, { name: 'legacy-need', args: {} });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });

  it('会话键 allow → 不弹卡直过；deny → 拒（V3）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~alice': { approval: 'allow' }, 'user~bob': { approval: 'deny' } } });
    await reg(ctx, { name: 'asker', risk: () => 'ask' });
    const rA = await ctx.tools.execute({ name: 'asker', args: {}, conversationId: 'user~alice' });
    expect(rA.ok).toBe(true);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
    const rB = await ctx.tools.execute({ name: 'asker', args: {}, conversationId: 'user~bob' });
    expect(rB.ok).toBe(false);
  });

  it('Agent settings 层：会话键缺席时 settings onAsk 生效', async () => {
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'deny' } } });
    await reg(ctx, { name: 'asker2', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker2', args: {}, conversationId: 'user~x', agentId: 'alice' });
    expect(r.ok).toBe(false);
  });

  it('行 config 缺省层：无会话键无 settings → config onAsk', async () => {
    const { ctx } = await boot({ gateConfig: { onAsk: 'deny' } });
    await reg(ctx, { name: 'asker3', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker3', args: {}, conversationId: 'user~x' });
    expect(r.ok).toBe(false);
  });

  it('拒绝 → 拒绝执行；拒绝 answer 形状 false', async () => {
    const { ctx } = await boot();
    const probe = await await reg(ctx, { name: 'asked', risk: () => 'ask' });
    const r = await runWithReply(ctx, { name: 'asked', args: {} }, false);
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
  });
});

describe('守护（cr-1070）：档位不参与审批决策——免审正路是 risk 自评与设置链，非调用方档位', () => {
  it('sandbox 档 Agent 的 ask 建议仍走设置链（旧「sandbox+ 档自由」语义已废）', async () => {
    const { ctx } = await boot({ tiers: { alice: 'sandbox-access' } });
    const probe = await reg(ctx, { name: 'tiered-tool', needPermission: true });
    const r = await runWithReply(ctx, { name: 'tiered-tool', args: {}, conversationId: 'u~a', agentId: 'alice' });
    expect(r.ok).toBe(true);
    expect(probe.executed).toBe(1);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1); // 弹卡了
  });

  it('full 档 Agent 的 ask 建议同样走设置链（弹卡）', async () => {
    const { ctx } = await boot({ tiers: { alice: 'full-access' } });
    await reg(ctx, { name: 'full-tool', needPermission: true });
    const r = await runWithReply(ctx, { name: 'full-tool', args: {}, conversationId: 'u~a', agentId: 'alice' });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });

  it('会话键 deny 对任意档位生效（设置链优先于一切档位语义）', async () => {
    const { ctx } = await boot({ tiers: { alice: 'full-access' }, convSettings: { 'u~a': { approval: 'deny' } } });
    const probe = await reg(ctx, { name: 'full-deny-key', needPermission: true });
    const r = await ctx.tools.execute({ name: 'full-deny-key', args: {}, conversationId: 'u~a', agentId: 'alice' });
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });
});

describe('D7：无人桶恒拒（even 设置 allow）', () => {
  it('self 会话 ask 建议 → 拒（fail-closed），会话键 allow 也不豁免', async () => {
    const { ctx } = await boot({ convSettings: { 'alice~alice': { approval: 'allow' } } });
    const probe = await await reg(ctx, { name: 'selftool', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'selftool', args: {}, conversationId: 'alice~alice' });
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });
});

describe('run 级批准缓存（V2）', () => {
  it('scope=run 批准后本轮第二次 ask 免问；before-run 后失效', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'twice', risk: () => 'ask' });
    const r1 = await runWithReply(ctx, { name: 'twice', args: {}, conversationId: 'u~a', runId: 'run-1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // 第二次：同 run——免问直过
    const r2 = await ctx.tools.execute({ name: 'twice', args: {}, conversationId: 'u~a', runId: 'run-1' });
    expect(r2.ok).toBe(true);
    // before-run 清缓存：模拟新 run
    let afterRun: (() => Promise<unknown>) | null = null;
    ctx.on('loop/before-run', (c, n) => { afterRun = n; return n(); }, { description: 'test' });
    await (ctx as any).waterfall('loop/before-run', {}, async () => ({}));
    const r3 = await runWithReply(ctx, { name: 'twice', args: {}, conversationId: 'u~a', runId: 'run-2' }, { approved: true, scope: 'run' });
    expect(r3.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(2); // 两张卡（run-1 + run-2）
  });

  it('scope=call 批准仅本次——第二次同 run 仍问', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'callscope', risk: () => 'ask' });
    const r1 = await runWithReply(ctx, { name: 'callscope', args: {}, conversationId: 'u~a', runId: 'run-1' }, { approved: true, scope: 'call' });
    expect(r1.ok).toBe(true);
    const r2 = await runWithReply(ctx, { name: 'callscope', args: {}, conversationId: 'u~a', runId: 'run-1' }, { approved: true, scope: 'call' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(2);
  });

  it('run 缓存命中 = 与首批准同权 full-access（cr-1071——免问不撞沙箱墙）', async () => {
    const { ctx } = await boot();
    const accesses: unknown[] = [];
    const f = ctx.plugin({ name: 'ac-test-runscope-probe', inject: ['tools'], apply(c: Context) {
      c.tools.register({
        name: 'runscope-probe',
        needPermission: true,
        execute: (_args, call) => { accesses.push(call.access); return { ok: true }; },
      });
    } });
    await f;
    booted.at(-1)!.fibers.push(f);
    const r1 = await runWithReply(ctx, { name: 'runscope-probe', args: {}, conversationId: 'u~a', runId: 'run-1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // 第二次同 run：免问直过（无新卡）且同权注入 full-access
    const r2 = await ctx.tools.execute({ name: 'runscope-probe', args: {}, conversationId: 'u~a', runId: 'run-1' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
    expect(accesses).toEqual(['full-access', 'full-access']);
  });
});

describe('提权注入：批准 = 单次按 full 执行', () => {
  it('批准后 execution.call.access = full-access（工具体可见）', async () => {
    const { ctx } = await boot();
    let seenAccess: unknown;
    ctx.tools.register({
      name: 'elev',
      needPermission: true,
      execute: (_args, call) => { seenAccess = call.access; return { ok: true }; },
    });
    const r = await runWithReply(ctx, { name: 'elev', args: {} });
    expect(r.ok).toBe(true);
    expect(seenAccess).toBe('full-access');
  });
});
