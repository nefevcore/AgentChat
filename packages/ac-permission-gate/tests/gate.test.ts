// ============================================================
// ac-permission-gate/tests/gate.test.ts —— 决策序全分支测试（cr-1066 批1b）
// 桩形态：真 ac-tools（注册/执行链）+ 真 ac-durable-interaction（memory
// 后端）+ 门行本体；convSettings/agents 软依赖用最小桩服务替代。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as diRow from 'ac-durable-interaction';
import { humanPresentOf } from 'ac-agents';
import * as gateRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** convSettings 桩（可写 Map——测会话键层）。effective = 决策面读口
 *  （cr-1083 conv-scope 批1——门读 effective，无人桶恒 {}——humanPresentOf
 *  同源真判定，D7 用例锁定的正是这一层语义） */
class ConvSettingsStub extends Service {
  store = new Map<string, Record<string, string>>();
  constructor(ctx: Context) { super(ctx, 'convSettings'); }
  get(id: string): Record<string, string> { return this.store.get(id) ?? {}; }
  effective(id: string): Record<string, string> {
    return humanPresentOf(id) ? (this.store.get(id) ?? {}) : {};
  }
}

/** agents 桩（settingsOf——测 Agent settings 层；cr-1082 起档位面消亡） */
class AgentsStub extends Service {
  settings: Record<string, Record<string, unknown>> = {};
  constructor(ctx: Context) { super(ctx, 'agents'); }
  get(_id: string): undefined {
    return undefined;
  }
  settingsOf(_id: string, name?: string): unknown {
    return name === undefined ? this.settings : this.settings[name];
  }
}

/** config 桩（全局层——测第三层；cr-1079 四层链） */
class ConfigStub extends Service {
  store: Record<string, unknown> = {};
  constructor(ctx: Context) { super(ctx, 'config'); }
  get<T>(key: string, fallback?: T): T | undefined {
    const v = key.split('.').reduce<unknown>((acc, part) =>
      acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined, this.store);
    return (v === undefined ? fallback : v) as T | undefined;
  }
}

interface BootOpts {
  gateConfig?: { riskGranted?: (owner: string) => boolean };
  convSettings?: Record<string, Record<string, string>>;
  agentSettings?: Record<string, Record<string, unknown>>;
  globalConfig?: Record<string, unknown>;
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
  // 环境缺省 = 全局 onAsk 'ask'（与 cr-1256 起四层缺省同值——既有弹卡路径
  // 测试零改）；四层缺省用例显式传 {} 排空验证
  const store = opts.globalConfig ?? { settings: { 'permission-gate': { onAsk: 'ask' as const } } };
  if (store !== null) {
    const f = ctx.plugin(ConfigStub);
    await f; fibers.push(f);
    ((ctx as any).config as ConfigStub).store = store;
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

/** 执行（自动应答首张 approval 卡）——返回 {result, executed}。
 *  缺省 conversationId 'user~probe'：弹卡流程用例需有人桶（cr-1079 无人
 *  语义下裸调用 = 无人桶走 fail-closed，测不到审批卡面）。 */
async function runWithReply(ctx: Context, call: { name: string; args?: Record<string, unknown>; conversationId?: string; agentId?: string; runId?: string }, answer: unknown = { approved: true, scope: 'call' }) {
  const p = ctx.tools.execute({ ...call, conversationId: call.conversationId ?? 'user~probe' });
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

  it('会话键 allow → 不弹卡直过且注入 sandbox-access（cr-1248「知情通过即 full」——预授权保留沙箱检查）；deny → 拒（V3）', async () => {
    const accesses: unknown[] = [];
    const { ctx } = await boot({ convSettings: { 'user~alice': { approval: 'allow' }, 'user~bob': { approval: 'deny' } } });
    const f = ctx.plugin({ name: 'ac-test-asker', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'asker', risk: () => 'ask', execute: (_a, call) => { accesses.push(call.access); return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    const rA = await ctx.tools.execute({ name: 'asker', args: {}, conversationId: 'user~alice' });
    expect(rA.ok).toBe(true);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
    expect(accesses).toEqual(['sandbox-access']); // 设置链 allow = 预授权 → sandbox 注入（cr-1248）
    const rB = await ctx.tools.execute({ name: 'asker', args: {}, conversationId: 'user~bob' });
    expect(rB.ok).toBe(false);
  });

  it('Agent settings 层 allow → 同款 sandbox 注入（三层同权——cr-1248 后预授权统一 sandbox）', async () => {
    const accesses: unknown[] = [];
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'allow' } } });
    const f = ctx.plugin({ name: 'ac-test-allow-inject', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'allow-inject', risk: () => 'ask', execute: (_a, call) => { accesses.push(call.access); return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    // 无人桶（news~news）+ Agent settings allow = news 现场形态
    const r = await ctx.tools.execute({ name: 'allow-inject', args: {}, conversationId: 'news~news', agentId: 'news' });
    expect(r.ok).toBe(true);
    expect(accesses).toEqual(['sandbox-access']);
  });

  it('全局 config 层 allow → 同款 sandbox 注入', async () => {
    const accesses: unknown[] = [];
    const { ctx } = await boot({ globalConfig: { settings: { 'permission-gate': { onAsk: 'allow' } } } });
    const f = ctx.plugin({ name: 'ac-test-global-inject', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'global-inject', risk: () => 'ask', execute: (_a, call) => { accesses.push(call.access); return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    const r = await ctx.tools.execute({ name: 'global-inject', args: {}, conversationId: 'g-abc~news' });
    expect(r.ok).toBe(true);
    expect(accesses).toEqual(['sandbox-access']);
  });

  it('Agent settings 层：会话键缺席时 settings onAsk 生效', async () => {
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'deny' } } });
    await reg(ctx, { name: 'asker2', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker2', args: {}, conversationId: 'user~x', agentId: 'alice' });
    expect(r.ok).toBe(false);
  });

  it('全局 config 层：无会话键无 settings → config[permission-gate].onAsk（cr-1079 第三层）', async () => {
    const { ctx } = await boot({ globalConfig: { settings: { 'permission-gate': { onAsk: 'deny' } } } });
    await reg(ctx, { name: 'asker3', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker3', args: {}, conversationId: 'user~x' });
    expect(r.ok).toBe(false);
  });

  it('四层缺省：有人会话全无设置 → 弹卡问人（cr-1256 缺省 ask——翻转 cr-1079/cr-1218 的链尾 deny）；批准放行', async () => {
    const { ctx } = await boot({ globalConfig: {} });
    await reg(ctx, { name: 'asker4', risk: () => 'ask' });
    const r = await runWithReply(ctx, { name: 'asker4', args: {}, conversationId: 'user~probe' });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' })).toHaveLength(1); // 弹卡了
  });

  it('四层缺省：无人会话全无设置 → 拒（D7 fail-closed 格）；文案归因到缺省层（cr-1217 面3）', async () => {
    const { ctx } = await boot({ globalConfig: {} });
    await reg(ctx, { name: 'asker5', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker5', args: {}, conversationId: 'alice~alice' });
    expect(r.ok).toBe(false);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0); // 无人桶不弹卡
    expect(r.error).toContain('缺省（四层均未配置）'); // 归因：缺省层落的 ask
    expect(r.error).toContain('无人类参与'); // D7 fail-closed 语义
  });

  it('Agent settings 层 deny → 文案点名该层与单元文件路径（cr-1217 面3）', async () => {
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'deny' } } });
    await reg(ctx, { name: 'asker-layer', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'asker-layer', args: {}, conversationId: 'user~x', agentId: 'bob' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('agents/bob/permission-gate.json');
  });

  it('拒绝 → 拒绝执行；拒绝 answer 形状 false', async () => {
    const { ctx } = await boot();
    const probe = await await reg(ctx, { name: 'asked', risk: () => 'ask' });
    const r = await runWithReply(ctx, { name: 'asked', args: {} }, false);
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
  });
});

describe('守护（cr-1070 锚定 → cr-1082 改锚）：full 只来自门——Agent 档位概念随 access 轴消亡，ask 恒走设置链', () => {
  it('ask 建议走设置链弹卡（有人桶缺省 ask）——无「档位免审」旁路', async () => {
    const { ctx } = await boot();
    const probe = await reg(ctx, { name: 'tiered-tool', needPermission: true });
    const r = await runWithReply(ctx, { name: 'tiered-tool', args: {}, conversationId: 'user~a', agentId: 'alice' });
    expect(r.ok).toBe(true);
    expect(probe.executed).toBe(1);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1); // 弹卡了
  });

  it('full 注入只来自门路径：弹卡批准（cr-1071 唯一 full 注入点；设置链 allow 注 sandbox——cr-1248 分级）', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'full-tool', needPermission: true });
    const r = await runWithReply(ctx, { name: 'full-tool', args: {}, conversationId: 'user~a', agentId: 'alice' });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });

  it('会话键 deny 压一切（设置链优先）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~a': { approval: 'deny' } } });
    const probe = await reg(ctx, { name: 'full-deny-key', needPermission: true });
    const r = await ctx.tools.execute({ name: 'full-deny-key', args: {}, conversationId: 'user~a', agentId: 'alice' });
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });
});

describe('D7（cr-1079 修订）：无人桶 = 无人类参与（self/agent~agent/g~member）——预授权放行、缺省拒', () => {
  it('self 会话无预授权 ask 建议 → 拒（fail-closed，缺省链尾 deny）', async () => {
    const { ctx } = await boot();
    const probe = await await reg(ctx, { name: 'selftool', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'selftool', args: {}, conversationId: 'alice~alice' });
    expect(r.ok).toBe(false);
    expect(probe.executed).toBe(0);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });

  it('self 会话：会话键不参与（cr-1079 续记——无人桶跳过第一层），Agent settings allow 才是解锁位', async () => {
    // 会话键 allow 写在无人桶上 = 被无视（残值不压 Agent 设置）
    const { ctx } = await boot({ convSettings: { 'alice~alice': { approval: 'allow' } } });
    const probe = await await reg(ctx, { name: 'selftool2', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'selftool2', args: {}, conversationId: 'alice~alice' });
    expect(r.ok).toBe(false); // 无 Agent 设置 → 链尾 deny（会话键 allow 未生效）
    expect(probe.executed).toBe(0);
    const { ctx: ctx2 } = await boot({
      convSettings: { 'alice~alice': { approval: 'deny' } }, // 残值 deny 同样无视
      agentSettings: { 'permission-gate': { onAsk: 'allow' } },
    });
    const probe2 = await reg(ctx2, { name: 'selftool3', risk: () => 'ask' });
    const r2v = await ctx2.tools.execute({ name: 'selftool3', args: {}, conversationId: 'alice~alice' });
    expect(r2v.ok).toBe(true); // Agent settings allow 放行——无人桶唯一预授权位
    expect(probe2.executed).toBe(1);
  });

  it('news 现场：self 桶（news~news）+ Agent settings onAsk=allow → 放行（机制轮巡恢复）', async () => {
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'allow' } } });
    const probe = await reg(ctx, { name: 'news-patrol', risk: () => 'ask' });
    const r = await ctx.tools.execute({ name: 'news-patrol', args: {}, conversationId: 'news~news', agentId: 'news' });
    expect(r.ok).toBe(true); // cr-1079 修复目标：旧序此格恒拒
    expect(probe.executed).toBe(1);
    expect(ctx.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0); // 无人桶不弹卡
  });

  it('agent~agent 会话（非 self）→ 恒无人：无预授权拒，Agent settings allow 放行', async () => {
    const { ctx } = await boot({ agentSettings: { 'permission-gate': { onAsk: 'allow' } } });
    await reg(ctx, { name: 'p2p-ask', risk: () => 'ask' });
    const r1v = await ctx.tools.execute({ name: 'p2p-ask', args: {}, conversationId: 'alice~bob' });
    // Agent settings allow = 预授权 → 放行（不弹卡）
    expect(r1v.ok).toBe(true);
    const { ctx: ctx2 } = await boot();
    await reg(ctx2, { name: 'p2p-ask', risk: () => 'ask' });
    const r2v = await ctx2.tools.execute({ name: 'p2p-ask', args: {}, conversationId: 'alice~bob' });
    expect(r2v.ok).toBe(false); // 无预授权 → 无人桶 fail-closed
    expect(ctx2.durableInteraction.listOpen({ kind: 'approval' })).toHaveLength(0);
  });

  it('群会话 g-<gid>~member → 恒无人：无预授权拒，全局 config allow 放行', async () => {
    const { ctx } = await boot({ globalConfig: { settings: { 'permission-gate': { onAsk: 'allow' } } } });
    await reg(ctx, { name: 'grp-ask', risk: () => 'ask' });
    const r1v = await ctx.tools.execute({ name: 'grp-ask', args: {}, conversationId: 'g-abc~news' });
    expect(r1v.ok).toBe(true); // 全局预授权 → 放行
    const { ctx: ctx2 } = await boot();
    await reg(ctx2, { name: 'grp-ask', risk: () => 'ask' });
    const r2v = await ctx2.tools.execute({ name: 'grp-ask', args: {}, conversationId: 'g-abc~news' });
    expect(r2v.ok).toBe(false); // 缺省 deny → 拒
  });

  it('有人桶（user~agent）缺省 ask 仍弹卡（cr-1079 不改有人桶语义）', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'human-ask', risk: () => 'ask' });
    const r = await runWithReply(ctx, { name: 'human-ask', args: {}, conversationId: 'alice~user' });
    expect(r.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
  });
});

describe('run 级批准缓存（V2）', () => {
  it('scope=run 批准后本轮第二次 ask 免问；before-run 后失效', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'twice', risk: () => 'ask' });
    const r1 = await runWithReply(ctx, { name: 'twice', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // 第二次：同 run——免问直过
    const r2 = await ctx.tools.execute({ name: 'twice', args: {}, conversationId: 'user~a', runId: 'run-1' });
    expect(r2.ok).toBe(true);
    // before-run 清缓存：模拟新 run
    let afterRun: (() => Promise<unknown>) | null = null;
    ctx.on('loop/before-run', (c, n) => { afterRun = n; return n(); }, { description: 'test' });
    await (ctx as any).waterfall('loop/before-run', {}, async () => ({}));
    const r3 = await runWithReply(ctx, { name: 'twice', args: {}, conversationId: 'user~a', runId: 'run-2' }, { approved: true, scope: 'run' });
    expect(r3.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(2); // 两张卡（run-1 + run-2）
  });

  it('scope=call 批准仅本次——第二次同 run 仍问', async () => {
    const { ctx } = await boot();
    await reg(ctx, { name: 'callscope', risk: () => 'ask' });
    const r1 = await runWithReply(ctx, { name: 'callscope', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'call' });
    expect(r1.ok).toBe(true);
    const r2 = await runWithReply(ctx, { name: 'callscope', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'call' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(2);
  });

  it('run 缓存命中注入 sandbox-access（cr-1248：免问 ≠ 免检）；首批准弹卡仍 full', async () => {
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
    const r1 = await runWithReply(ctx, { name: 'runscope-probe', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // 第二次同 run：免问直过（无新卡）但注入 sandbox-access（cr-1248——后续
    // 命令人未逐条看过，边界检查照跑；首条是弹卡批准的知情 full）
    const r2 = await ctx.tools.execute({ name: 'runscope-probe', args: {}, conversationId: 'user~a', runId: 'run-1' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
    expect(accesses).toEqual(['full-access', 'sandbox-access']);
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

describe('注入分级（cr-1248）：预授权 ≠ 解除检查——倒挂回归锚', () => {
  it('预授权（会话键 allow）下 ask 工具拿 sandbox-access：isFullAccessCall 判 false——executor 命令扫描/写白名单照拦', async () => {
    const { ctx } = await boot({ convSettings: { 'user~attacker': { approval: 'allow' } } });
    let seenAccess: unknown;
    const f = ctx.plugin({ name: 'ac-test-varprobe', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'varprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    const r = await ctx.tools.execute({ name: 'varprobe', args: {}, conversationId: 'user~attacker' });
    expect(r.ok).toBe(true);
    expect(seenAccess).toBe('sandbox-access'); // 倒挂现场：变量拼接命令（risk 恒 ask）预授权下不再拿 full 免检
  });

  it('弹卡批准仍是 full（知情授权）——预授权与弹卡分级存在', async () => {
    const { ctx } = await boot();
    let seenAccess: unknown;
    const f = ctx.plugin({ name: 'ac-test-cardprobe', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'cardprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    const r = await runWithReply(ctx, { name: 'cardprobe', args: {}, conversationId: 'user~a' });
    expect(r.ok).toBe(true);
    expect(seenAccess).toBe('full-access');
  });
});

describe('per-step 生效（cr-1259）：会话键 approval 选择即写 → 门下一调用即见', () => {
  // 生产链路：门 onAskOf 逐 tool call 读 effective（无缓存）+ 服务/shim 现读
  // 文件——选择即写落盘即生效。本组用 ConvSettingsStub 可写 Map 模拟
  // mid-run 改值（与 ConvSettingsService 现读不缓存同构）。
  it('mid-run 改 deny：下一个 tool call 立即被拒（不等待 run 边界）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~a': {} } });
    await reg(ctx, { name: 'perstep', risk: () => 'ask' });
    // 首调用：无覆盖 → 默认 ask → 弹卡批准（scope=run——本轮全免）
    const r1 = await runWithReply(ctx, { name: 'perstep', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // mid-run：用户改 approval=deny（选择即写落盘）
    ((ctx as any).convSettings as ConvSettingsStub).store.set('user~a', { approval: 'deny' });
    // 下一个 tool call（同 run——runApproved 缓存在场）：设置链在缓存检查
    // **之前**求值 → deny 立即压过 run 缓存，工具被拒
    const r2 = await ctx.tools.execute({ name: 'perstep', args: {}, conversationId: 'user~a', runId: 'run-1' });
    expect(r2.ok).toBe(false);
    expect((r2 as { error?: string }).error).toMatch(/设置拒绝/);
  });

  it('mid-run 改 allow：下一个 tool call 免弹卡直通（sandbox-access——预授权分级）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~a': {} } });
    let seenAccess: unknown;
    const f = ctx.plugin({ name: 'ac-test-allowprobe', inject: ['tools'], apply(c: Context) {
      c.tools.register({ name: 'allowprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
    } });
    await f; booted.at(-1)!.fibers.push(f);
    const r1 = await runWithReply(ctx, { name: 'allowprobe', args: {}, conversationId: 'user~a', runId: 'run-1' }, { approved: true, scope: 'call' });
    expect(r1.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1);
    // mid-run：用户改 approval=allow（选择即写落盘）
    ((ctx as any).convSettings as ConvSettingsStub).store.set('user~a', { approval: 'allow' });
    // 下一个 tool call：免弹卡直通 + sandbox-access（cr-1248 预授权分级）
    const r2 = await ctx.tools.execute({ name: 'allowprobe', args: {}, conversationId: 'user~a', runId: 'run-1' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1); // 无新卡
    expect(seenAccess).toBe('sandbox-access');
  });

  it('cr-1261 四档：allow-full 免卡注 full-access；allow-sandbox/存量 allow 注 sandbox-access', async () => {
    // allow-full：免弹卡 + full（越沙箱——工具体可见 access 档）
    {
      const { ctx } = await boot({ convSettings: { 'user~a': { approval: 'allow-full' } } });
      let seenAccess: unknown;
      const f = ctx.plugin({ name: 'ac-test-fullprobe', inject: ['tools'], apply(c: Context) {
        c.tools.register({ name: 'fullprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
      } });
      await f; booted.at(-1)!.fibers.push(f);
      const r = await ctx.tools.execute({ name: 'fullprobe', args: {}, conversationId: 'user~a' });
      expect(r.ok).toBe(true);
      expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(0); // 无卡
      expect(seenAccess).toBe('full-access');
    }
    // allow-sandbox（新词）：免弹卡 + sandbox 档
    {
      const { ctx } = await boot({ convSettings: { 'user~a': { approval: 'allow-sandbox' } } });
      let seenAccess: unknown;
      const f = ctx.plugin({ name: 'ac-test-sbprobe', inject: ['tools'], apply(c: Context) {
        c.tools.register({ name: 'sbprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
      } });
      await f; booted.at(-1)!.fibers.push(f);
      const r = await ctx.tools.execute({ name: 'sbprobe', args: {}, conversationId: 'user~a' });
      expect(r.ok).toBe(true);
      expect(seenAccess).toBe('sandbox-access');
    }
    // 存量 'allow'（旧前端/历史落盘）：读侧映射 allow-sandbox——保守兼容
    {
      const { ctx } = await boot({ convSettings: { 'user~a': { approval: 'allow' } } });
      let seenAccess: unknown;
      const f = ctx.plugin({ name: 'ac-test-legacyprobe', inject: ['tools'], apply(c: Context) {
        c.tools.register({ name: 'legacyprobe', risk: () => 'ask', execute: (_a, call) => { seenAccess = call.access; return { ok: true }; } });
      } });
      await f; booted.at(-1)!.fibers.push(f);
      const r = await ctx.tools.execute({ name: 'legacyprobe', args: {}, conversationId: 'user~a' });
      expect(r.ok).toBe(true);
      expect(seenAccess).toBe('sandbox-access'); // 不是 full——存量会话不一夜全权
    }
  });

  it('run 缓存不读设置链——scope=run 批准后改回 ask：仍免问（正交共存）', async () => {
    const { ctx } = await boot({ convSettings: { 'user~a': {} } });
    await reg(ctx, { name: 'orth', risk: () => 'ask' });
    const r1 = await runWithReply(ctx, { name: 'orth', args: {}, conversationId: 'user~a', runId: 'r1' }, { approved: true, scope: 'run' });
    expect(r1.ok).toBe(true);
    // mid-run：用户改 approval=ask（既非 allow 也非 deny——回默认弹卡面）
    ((ctx as any).convSettings as ConvSettingsStub).store.set('user~a', { approval: 'ask' });
    // 同 run 下一调用：onAskOf 返回 ask → 进入缓存检查 → 命中 → 免问直过
    const r2 = await ctx.tools.execute({ name: 'orth', args: {}, conversationId: 'user~a', runId: 'r1' });
    expect(r2.ok).toBe(true);
    expect(ctx.durableInteraction.list({ kind: 'approval' }).length).toBe(1); // 无新卡
  });
});
