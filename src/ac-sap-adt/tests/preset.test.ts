// ============================================================
// ac-sap-adt/src/preset.ts 的测试：ABAP 开发模式预设子行
//   · 注入预设目录 + 物化形状（tags 即工具面——与标准模式同构，
//     不写 tools 白名单；门禁轴单一事实源）
//   · tags 解锁语义：sap-adt 标签解锁全部 adt_*（全装配实测）
//   · 行卸载回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import { capabilitySetOf, toolAllowedFor } from 'ac-agents';
import * as presetsRow from 'ac-agent-presets';
import * as toolsRow from 'ac-tools';
import * as jobsRow from 'ac-jobs';
import * as shellToolsRow from 'ac-shell-tools';
import * as webToolsRow from 'ac-web-tools';
import * as sapAdtRow from '../src/index.ts';
import * as presetRow from '../src/preset.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, agentsRow, presetsRow, presetRow]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

/** 完整装配（含 sap-adt 主行 + shell/web 工具行——tags 解锁面三轴齐备） */
async function bootFull() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [jobsRow, undefined],
    [agentsRow, undefined],
    [presetsRow, undefined],
    [shellToolsRow, undefined],
    [webToolsRow, undefined],
    [sapAdtRow, { demo: true, demoPort: 0 }],
    [presetRow, undefined],
  ];
  for (const [row, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
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

describe('ac-sap-adt/preset：ABAP 开发模式预设', () => {
  it('注入预设目录并物化（preset 标志 + tags 即工具面 + 无记忆 settings）', async () => {
    const { ctx } = await boot();
    const dev = ctx.agents.get('__abap_dev__');
    expect(dev?.preset).toBe(true);
    expect(dev?.name).toBe('ABAP开发模式');
    // 能力声明面：sap-adt 门禁词 + shell + web——与标准模式同构
    // （只写 tags，不写 tools 白名单：门禁轴单一事实源）
    expect(dev?.tags).toEqual(['sap-adt', 'shell', 'web']);
    expect(dev?.tools).toBeUndefined();
    // 无记忆语义（与标准/极简同款软停用）
    expect((dev?.settings as Record<string, { enabled?: boolean }>).memory).toEqual({ enabled: false });
    // 目录条目（agents/presets RPC 可见）
    expect(ctx.agentPresets.get('__abap_dev__')?.meta.label).toBe('ABAP开发模式');
    // 本 harness 无其他预设 → defaultPreset 落在本条
    expect(ctx.agentPresets.defaultPreset()?.agent.id).toBe('__abap_dev__');
  });

  it('tags 解锁语义：sap-adt 标签解锁全部 adt_*（工具集变化自动跟随）', async () => {
    const { ctx } = await bootFull();
    const dev = ctx.agents.get('__abap_dev__');
    expect(dev?.tags).toContain('sap-adt');
    // 门禁轴直接验证：capabilitySetOf × toolAllowedFor（router 同款单源）
    const caps = capabilitySetOf(ctx, '__abap_dev__');
    const visible = ctx.tools.list().filter((t) => toolAllowedFor(t, caps)).map((t) => t.name);
    // 主行注册面（demo 引擎完整目录）全部解锁（0.10 实测 32——0.9 起整合
    // 批次收敛：调试器五件套→adt_debug、ATC/dumps/transports→单工具）
    const registeredAdt = ctx.tools.list().map((t) => t.name).filter((n) => n.startsWith('adt_'));
    expect(registeredAdt.length).toBeGreaterThanOrEqual(32);
    for (const name of registeredAdt) expect(visible).toContain(name);
    // bash（shell）/ web_search（web）也解锁
    expect(visible).toContain('bash');
    expect(visible).toContain('web_search');

    // 跟随性证明：再注册一个带 sap-adt 标签的工具 → 无需改预设即解锁
    ctx.tools.register({
      name: 'adt_probe_extra',
      description: 'probe',
      requiredTags: ['sap-adt'],
      execute: () => ({ ok: true }),
    } as never);
    const caps2 = capabilitySetOf(ctx, '__abap_dev__');
    const probe = ctx.tools.get('adt_probe_extra')!;
    expect(toolAllowedFor(probe, caps2)).toBe(true);
  });

  it('行卸载回收：摘 preset 子行 → 目录 + 物化撤注册', async () => {
    const { ctx, fibers } = await boot();
    const presetFiber = fibers[fibers.length - 1];
    await presetFiber.dispose();
    expect(ctx.agentPresets.get('__abap_dev__')).toBeUndefined();
    expect(ctx.agents.has('__abap_dev__')).toBe(false);
  });
});
