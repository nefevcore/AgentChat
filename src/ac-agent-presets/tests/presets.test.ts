// ============================================================
// ac-agent-presets 测试（目录服务）：注册面（插件注入）· 物化（preset
// 标志/软停用 settings）· 默认池模型解析 + config/changed 热更新 ·
// skip-if-present（用户实体优先）· 行卸载回收 · defaultPreset 选取
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as configRow from 'ac-config';
import * as presetsRow from '../src/index.ts';
import type { AgentPresetDefinition } from '../src/index.ts';

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

/** 任意模式（模拟第三方插件注入） */
const CUSTOM: AgentPresetDefinition = {
  meta: { label: '夜间模式', description: '测试注入', order: 9 },
  agent: {
    id: '__night__',
    name: '夜间模式',
    preset: true,
    tags: ['shell'],
    settings: { memory: { enabled: false } },
  },
};

describe('ac-agent-presets：目录注册面', () => {
  it('register 注入即物化（preset 标志 + settings 透传）；list 按 order 排序、defaultPreset 选取', async () => {
    const { ctx } = await boot();
    ctx.agentPresets.register(CUSTOM);
    const night = ctx.agents.get('__night__');
    expect(night?.preset).toBe(true);
    expect(night?.name).toBe('夜间模式');
    expect((night?.settings as Record<string, { enabled?: boolean }>).memory).toEqual({ enabled: false });
    // 无 config 行 → 模型留空（router 层报"缺少 model"；会话级模型覆盖可用）
    expect(night?.model).toBeUndefined();

    // 目录：list 注册序 + order 排序；defaultPreset 缺省取第一个
    expect(ctx.agentPresets.list().map((d) => d.agent.id)).toEqual(['__night__']);
    expect(ctx.agentPresets.defaultPreset()?.agent.id).toBe('__night__');
    // get 目录条目
    expect(ctx.agentPresets.get('__night__')?.meta.label).toBe('夜间模式');
    expect(ctx.agentPresets.get('__none__')).toBeUndefined();
    // 空目录（无注入）→ defaultPreset null
    expect(ctx.agentPresets.list()).toHaveLength(1);
  });

  it('重名注册抛错（同 id 二次注入）', async () => {
    const { ctx } = await boot();
    ctx.agentPresets.register(CUSTOM);
    expect(() => ctx.agentPresets.register(CUSTOM)).toThrowError(/已注册/);
  });

  it('default 标记优先于 order（多模式注入的默认选取）', async () => {
    const { ctx } = await boot();
    ctx.agentPresets.register({ ...CUSTOM, meta: { ...CUSTOM.meta, order: 5 } });
    ctx.agentPresets.register({
      meta: { label: '甲模式', default: true, order: 3 },
      agent: { id: '__alpha__', preset: true },
    });
    const ids = ctx.agentPresets.list().map((d) => d.agent.id);
    expect(ids).toEqual(['__alpha__', '__night__']); // order 3 < 5
    expect(ctx.agentPresets.defaultPreset()?.agent.id).toBe('__alpha__');
  });

  it('默认池连接解析（P5 口径统一）：default:true 优先 → 物化 provider+model；config/changed 热更新', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        llmProviders: {
          glm: { defaultModel: 'glm-5.3' },
          myds: { base_url: 'https://my.example/v1', defaultModel: 'my-1', default: true },
        },
      }),
      'utf-8',
    );
    const { ctx } = await boot(root);
    ctx.agentPresets.register(CUSTOM);
    // default:true 条目优先（无 default 时取第一条）：provider = 条目名
    expect(ctx.agents.get('__night__')).toMatchObject({ model: 'my-1', provider: 'myds' });

    // 池配置变更 → 默认条目切换 → 预设热更新（agents/updated 事件随之广播）
    const updated: string[] = [];
    ctx.on('agents/updated', (config) => updated.push(config.id));
    ctx.config.set('llmProviders', { glm: { defaultModel: 'glm-5.3', default: true } });
    expect(ctx.agents.get('__night__')).toMatchObject({ model: 'glm-5.3', provider: 'glm' });
    expect(updated).toContain('__night__');
  });

  it('旧别名条目容错：provider+model 形态物化为 entry.provider + entry.model', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ llmProviders: { ds: { provider: 'deepseek', model: 'deepseek-v4-flash', default: true } } }),
      'utf-8',
    );
    const { ctx } = await boot(root);
    ctx.agentPresets.register(CUSTOM);
    expect(ctx.agents.get('__night__')).toMatchObject({
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    });
  });

  it('skip-if-present：同 id 实体已注册（agents-dir 先物化场景）→ 目录照记、物化跳过（用户数据优先）', async () => {
    const ctx = new Context();
    const agentsFiber = ctx.plugin(agentsRow as any);
    await agentsFiber;
    // 用户盘上实体先物化（同 id）
    ctx.agents.register({ id: '__night__', description: '我的夜间', model: 'm1' });
    const presetFiber = ctx.plugin(presetsRow as any);
    await presetFiber;
    ctx.agentPresets.register(CUSTOM);
    booted.push({ ctx, fibers: [agentsFiber, presetFiber] });
    expect(ctx.agents.get('__night__')?.description).toBe('我的夜间');
    expect(ctx.agents.get('__night__')?.preset).toBeUndefined(); // 用户实体无 preset 标志
    // 目录仍含该条目（agents/presets RPC 可见）
    expect(ctx.agentPresets.get('__night__')?.meta.label).toBe('夜间模式');
  });

  it('注册行卸载回收：撤注册（目录 + 物化）自动联动；普通 Agent 不受影响', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'plain', model: 'm' });
    const dispose = ctx.agentPresets.register(CUSTOM);
    expect(ctx.agents.has('__night__')).toBe(true);
    dispose();
    expect(ctx.agentPresets.get('__night__')).toBeUndefined();
    expect(ctx.agents.has('__night__')).toBe(false);
    expect(ctx.agents.has('plain')).toBe(true);
  });
});
