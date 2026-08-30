// ============================================================
// ac-agent-presets 测试：物化（preset 标志/软停用 settings）· 默认池模型
// 解析 + config/changed 热更新 · skip-if-present（用户实体优先）·
// 行卸载回收 · defaultPreset 选取
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as configRow from 'ac-config';
import * as presetsRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-presets-'));
  tmps.push(dir);
  return dir;
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(root?: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = root !== undefined ? [configRow, agentsRow, presetsRow] : [agentsRow, presetsRow];
  for (const row of rows) {
    const fiber = root !== undefined && row === configRow
      ? ctx.plugin(row as any, { root })
      : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

async function disposeAll() {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
}

afterEach(async () => {
  await disposeAll();
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('ac-agent-presets：物化与目录', () => {
  it('内置预设物化进 ctx.agents（preset 标志 + 无记忆软停用 settings + dsh-minimal 工具白名单）', async () => {
    const { ctx } = await boot();
    const std = ctx.agents.get('__standard__');
    expect(std?.preset).toBe(true);
    expect(std?.description).toBe('标准模式');
    // 无记忆语义：memory/skill/datetime 软停用（src allowlist 不含这些注入钩子）
    expect((std?.settings as Record<string, { enabled?: boolean }>).memory).toEqual({ enabled: false });
    expect((std?.settings as Record<string, { enabled?: boolean }>).skill).toEqual({ enabled: false });
    expect((std?.settings as Record<string, { enabled?: boolean }>).datetime).toEqual({ enabled: false });
    // 无 config 行 → 模型留空（router 层报"缺少 model"；会话级模型覆盖可用）
    expect(std?.model).toBeUndefined();

    const minimal = ctx.agents.get('__dsh_minimal__');
    expect(minimal?.preset).toBe(true);
    expect(minimal?.tools).toEqual({ include: ['view', 'create', 'str_replace', 'insert', 'bash'] });
    expect((minimal?.settings as Record<string, { enabled?: boolean }>)['system-prompt']).toEqual({ enabled: false });

    // 目录服务：list/defaultPreset（meta.default 优先）
    expect(ctx.agentPresets.list().map((d) => d.agent.id)).toEqual(['__standard__', '__dsh_minimal__']);
    expect(ctx.agentPresets.defaultPreset()?.agent.id).toBe('__standard__');
  });

  it('默认池模型解析：default:true 优先 → 物化带 model；config/changed 热更新（reassign）', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ llmProviders: { glm: { model: 'glm-5.3' }, ds: { model: 'deepseek-v4-flash', default: true } } }),
      'utf-8',
    );
    const { ctx } = await boot(root);
    // default:true 条目优先（无 default 时取第一条）
    expect(ctx.agents.get('__standard__')?.model).toBe('ds');

    // 池配置变更 → 默认条目切换 → 预设热更新（agents/updated 事件随之广播）
    const updated: string[] = [];
    ctx.on('agents/updated', (config) => updated.push(config.id));
    ctx.config.set('llmProviders', { glm: { model: 'glm-5.3', default: true } });
    expect(ctx.agents.get('__standard__')?.model).toBe('glm');
    expect(updated).toContain('__standard__');
  });

  it('skip-if-present：同 id 实体已注册（agents-dir 先物化场景）→ 预设不覆盖用户数据', async () => {
    const ctx = new Context();
    const agentsFiber = ctx.plugin(agentsRow as any);
    await agentsFiber;
    // 用户盘上实体先物化（同 id）
    ctx.agents.register({ id: '__standard__', description: '我的标准', model: 'm1' });
    const presetFiber = ctx.plugin(presetsRow as any);
    await presetFiber;
    booted.push({ ctx, fibers: [agentsFiber, presetFiber] });
    expect(ctx.agents.get('__standard__')?.description).toBe('我的标准');
    expect(ctx.agents.get('__standard__')?.preset).toBeUndefined(); // 用户实体无 preset 标志
    // 其余预设照常物化
    expect(ctx.agents.get('__dsh_minimal__')?.preset).toBe(true);
  });

  it('行卸载回收：摘 agent-presets 行 → 预设撤注册（普通 Agent 不受影响）', async () => {
    const { ctx, fibers } = await boot();
    ctx.agents.register({ id: 'plain', model: 'm' });
    const presetFiber = fibers[fibers.length - 1];
    await presetFiber.dispose();
    expect(ctx.agents.has('__standard__')).toBe(false);
    expect(ctx.agents.has('__dsh_minimal__')).toBe(false);
    expect(ctx.agents.has('plain')).toBe(true);
  });
});
