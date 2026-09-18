// ============================================================
// ac-agent-presets-builtin 测试：内置模式数据行（标准/极简）注入预设
// 目录 + 物化形状（原 ac-agent-presets 内置清单断言迁移）· 行卸载回收
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as presetsRow from 'ac-agent-presets';
import * as builtinRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [agentsRow, presetsRow, builtinRow]) {
    const fiber = ctx.plugin(row as any);
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

describe('ac-agent-presets-builtin：内置模式注入', () => {
  it('标准/极简物化进 ctx.agents（preset 标志 + 无记忆软停用 settings + dsh-minimal 工具白名单）', async () => {
    const { ctx } = await boot();
    const std = ctx.agents.get('__standard__');
    expect(std?.preset).toBe(true);
    expect(std?.name).toBe('标准模式');
    // 无记忆语义：memory/skill/datetime 软停用（src allowlist 不含这些注入钩子）
    expect((std?.settings as Record<string, { enabled?: boolean }>).memory).toEqual({ enabled: false });
    expect((std?.settings as Record<string, { enabled?: boolean }>).skill).toEqual({ enabled: false });
    expect((std?.settings as Record<string, { enabled?: boolean }>).datetime).toEqual({ enabled: false });
    // 工具门禁标签（全量标签化 2026-09-16：tags 即工具面；2026-09-17
    // 精简——collab 协作族与 history 会话回放族出局，单会话通用对话不载。
    // run_code 随 infra 族（2026-09-17 优化裁决：tc-* 纯模式词——程序化
    // 是会话形态选择，无需预配标签）
    expect(std?.tags).toEqual(['fs', 'infra', 'shell', 'web', 'delegation']);

    // 无 config 行 → 模型留空（router 层报"缺少 model"；会话级模型覆盖可用）
    expect(std?.model).toBeUndefined();

    const minimal = ctx.agents.get('__dsh_minimal__');
    expect(minimal?.preset).toBe(true);
    // str_replace_editor 挂 fs_minimal 门禁（2026-09 移出默认工具面）——
    // 本预设显式授权。预设数据用 'tag:shell' 占位（平台无关），物化层
    // 解析为当平台字面名（Windows pwsh / Unix bash，2026-09-16 工具拆分）
    const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash';
    expect(minimal?.tools).toEqual({ include: ['str_replace_editor', shellTool] });
    expect(minimal?.tags).toEqual(['fs', 'shell', 'infra', 'fs_minimal']);
    expect((minimal?.settings as Record<string, { enabled?: boolean }>)['system-prompt']).toEqual({ enabled: false });

    // 目录服务：list/defaultPreset（meta.default 优先）——程序化模式已随
    // ac-run-code 走（preset.ts 子行，独立插件拆分 2026-09-17），本行两预设
    expect(ctx.agentPresets.list().map((d) => d.agent.id)).toEqual(['__standard__', '__dsh_minimal__']);
    expect(ctx.agentPresets.defaultPreset()?.agent.id).toBe('__standard__');
  });

  it('行卸载回收：摘 preset-builtin 行 → 撤注册（目录 + agents 物化，普通 Agent 不受影响）', async () => {
    const { ctx, fibers } = await boot();
    ctx.agents.register({ id: 'plain', model: 'm' });
    const builtinFiber = fibers[fibers.length - 1];
    await builtinFiber.dispose();
    expect(ctx.agentPresets.list()).toEqual([]); // 目录清空（仅本行注入）
    expect(ctx.agents.has('__standard__')).toBe(false);
    expect(ctx.agents.has('__dsh_minimal__')).toBe(false);
    expect(ctx.agents.has('plain')).toBe(true);
  });
});
