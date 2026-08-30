// ============================================================
// ac-gate-core/tests/gate.test.ts —— agentGate 六形态（M25 §3.3/P1）
//   · waterfall 停用 = return next()（链继续、inner 不执行）
//   · waterfall 启用 = inner 执行（next 透传）
//   · emit 停用 = 跳过；emit 启用 = inner 执行
//   · 无身份（agentOf → undefined）→ fail-open
//   · 无 agents 服务（ctx.get → undefined）→ 恒放行
//   · facet 子键覆盖回落行为级（redact.enabled ?? enabled）
//   · 无配置 / 非对象配置形状 = 启用
// ============================================================
import { describe, it, expect } from 'vitest';
import { agentGate, type GateContext } from '../src/index.ts';

/** 结构性 agents 桩（settingsOf 可脚本化） */
function ctxOf(settingsOf?: (id: string, name?: string) => unknown): GateContext {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined;
      return settingsOf ? { settingsOf } : undefined;
    },
  };
}

describe('agentGate（M25 §3.3）', () => {
  it('waterfall 停用 = return next()：inner 不执行、链继续（吞注册≠veto）', async () => {
    const ctx = ctxOf(() => ({ enabled: false }));
    let innerRan = false;
    const gated = agentGate(
      ctx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => {
        innerRan = true;
        return next();
      },
    );
    const downstream = await gated({ agent: 'a' }, async () => 'downstream-ok');
    expect(innerRan).toBe(false); // inner 被吞
    expect(downstream).toBe('downstream-ok'); // next() 机械放行
  });

  it('waterfall 启用 = inner 执行（next 透传；返回值原样）', async () => {
    const ctx = ctxOf(() => ({ enabled: true }));
    const gated = agentGate(
      ctx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => `inner(${await next()})`,
    );
    expect(await gated({ agent: 'a' }, async () => 'next')).toBe('inner(next)');
  });

  it('emit 停用 = 跳过（undefined）；emit 启用 = inner 执行', () => {
    const offCtx = ctxOf(() => ({ enabled: false }));
    let ran = 0;
    const gatedOff = agentGate(
      offCtx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      (payload: { agent?: string }) => {
        ran++;
        return 'ran';
      },
    );
    expect(gatedOff({ agent: 'a' })).toBeUndefined();
    expect(ran).toBe(0);

    const onCtx = ctxOf(() => undefined); // 无配置 = 启用
    const gatedOn = agentGate(
      onCtx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      (payload: { agent?: string }) => {
        ran++;
        return 'ran';
      },
    );
    expect(gatedOn({ agent: 'a' })).toBe('ran');
    expect(ran).toBe(1);
  });

  it('无身份（agentOf → undefined）→ fail-open；无 agents 服务 → 恒放行', async () => {
    const ctx = ctxOf(() => ({ enabled: false })); // 即使全员停用
    const gated = agentGate(
      ctx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => `inner(${await next()})`,
    );
    expect(await gated({}, async () => 'n')).toBe('inner(n)'); // 无身份放行

    const gatedNoService = agentGate(
      ctxOf(), // get('agents') → undefined
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => `inner(${await next()})`,
    );
    expect(await gatedNoService({ agent: 'a' }, async () => 'n')).toBe('inner(n)');
  });

  it('facet 子键覆盖回落行为级：redact.enabled ?? enabled', async () => {
    const table: Record<string, Record<string, unknown>> = {
      'a|gate-demo': { enabled: false, redact: { enabled: true } }, // 子键开、行为级关
      'b|gate-demo': { enabled: true, redact: { enabled: false } }, // 子键关、行为级开
      'c|gate-demo': { enabled: false }, // 无子键 → 回落行为级
    };
    const ctx = ctxOf((id, name) => table[`${id}|${name}`]);
    const gated = agentGate(
      ctx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => `inner(${await next()})`,
      { facet: 'redact' },
    );
    expect(await gated({ agent: 'a' }, async () => 'n')).toBe('inner(n)'); // 子键覆盖开
    expect(await gated({ agent: 'b' }, async () => 'n')).toBe('n'); // 子键覆盖关（next 机械放行）
    expect(await gated({ agent: 'c' }, async () => 'n')).toBe('n'); // 回落行为级关
  });

  it('settingsOf 返回非对象差异层值（旧 string 形状等）= 启用', async () => {
    const ctx = ctxOf(() => 'legacy-string');
    const gated = agentGate(
      ctx,
      'gate-demo',
      (first: { agent?: string }) => first.agent,
      async (payload: { agent?: string }, next: () => Promise<string>) => `inner(${await next()})`,
    );
    expect(await gated({ agent: 'a' }, async () => 'n')).toBe('inner(n)');
  });
});
