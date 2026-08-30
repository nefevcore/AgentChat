// ============================================================
// ac-agents/tests/settings-of.test.ts —— M24 A1 全局默认层合成口
//   · settingsOf 合并语义：对象递归 / 数组整体替换 / 差异层键优先
//   · preset / 未知 id：回落全局层
//   · get() 保持差异层原样
//   · 冻结坑守卫：settingsOf 合成 → get-config → update-config 回写后
//     差异层不出现仅存在于全局层的键（GET 展开回写冻结池引用同款坑）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index';
import * as configRow from 'ac-config';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-settings-of-'));
  tmps.push(dir);
  return dir;
}

async function boot(root: string) {
  const ctx = new Context();
  const f1 = ctx.plugin(configRow, { root });
  await f1;
  const f2 = ctx.plugin(agentsRow);
  await f2;
  booted.push({ ctx, fibers: [f1, f2] });
  return { ctx };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AgentsService.settingsOf（M24 A1）', () => {
  it('合并语义：对象递归 / 数组整体替换 / 差异层键优先；未给 name = 全图合并', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.config.set('settings', {
      persona: { text: '全局默认', tags: ['a', 'b'], enabled: true },
      memory: { maxTokens: 4000 },
    });
    ctx.agents.register({
      id: 'a',
      model: 'm',
      settings: { persona: { text: 'Agent 覆盖', tags: ['x'] } },
    });

    // 对象递归：persona.tags 差异层整体替换（数组）；enabled 继承全局层
    expect(ctx.agents.settingsOf('a', 'persona')).toEqual({
      text: 'Agent 覆盖',
      tags: ['x'],
      enabled: true,
    });
    // 差异层未给的 name：纯全局层
    expect(ctx.agents.settingsOf('a', 'memory')).toEqual({ maxTokens: 4000 });
    // 两层皆空：{}
    expect(ctx.agents.settingsOf('a', 'nobody')).toEqual({});
    // 未给 name：全图合并（persona 差异层 + memory 全局层）
    expect(ctx.agents.settingsOf('a')).toEqual({
      persona: { text: 'Agent 覆盖', tags: ['x'], enabled: true },
      memory: { maxTokens: 4000 },
    });
  });

  it('preset / 未知 id：回落全局层；get() 保持差异层原样', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.config.set('settings', { datetime: { enabled: false } });
    ctx.agents.register({ id: 'p', model: 'm', preset: true, settings: { skill: { enabled: false } } });

    expect(ctx.agents.settingsOf('p', 'datetime')).toEqual({ enabled: false }); // 差异层缺该键 → 全局层
    expect(ctx.agents.settingsOf('ghost', 'datetime')).toEqual({ enabled: false }); // 未知 id 回落全局层
    expect(ctx.agents.settingsOf('ghost', 'nope')).toEqual({});
    // get() 恒差异层（不合成——冻结坑守卫的前半）
    expect(ctx.agents.get('p')?.settings).toEqual({ skill: { enabled: false } });
  });

  it('冻结坑守卫：合成 → get-config → update-config 回写后差异层不出现仅存于全局层的键', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.config.set('settings', { persona: { text: '全局默认' }, memory: { maxTokens: 4000 } });
    ctx.agents.register({ id: 'a', model: 'm', settings: { persona: { text: '本 Agent 覆盖' } } });

    // 守卫链：① 读合成口（消费侧视角）
    const effective = ctx.agents.settingsOf('a', 'persona');
    expect(effective).toEqual({ text: '本 Agent 覆盖' });
    // ② get-config（agents/assembly GET 的 configs 面）恒返回差异层
    const diffView = ctx.agents.get('a')?.settings ?? {};
    expect(diffView).toEqual({ persona: { text: '本 Agent 覆盖' } });
    // ③ 模拟前端把「差异层原样」回写（update-config / assembly/update）：
    //    回写差异层后，差异层不得混入仅存于全局层的键（memory/maxTokens）
    ctx.agents.reassign({
      id: 'a',
      model: 'm',
      settings: JSON.parse(JSON.stringify(diffView)) as Record<string, unknown>,
    });
    const after = ctx.agents.get('a')?.settings ?? {};
    expect(after.memory).toBeUndefined();
    expect(after).toEqual({ persona: { text: '本 Agent 覆盖' } });
  });

  it('未装 config 行的组合：settingsOf 退化为差异层直读（接口同形）', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(agentsRow);
    await fiber;
    booted.push({ ctx, fibers: [fiber] });
    ctx.agents.register({ id: 'a', model: 'm', settings: { persona: { text: 'X' } } });
    expect(ctx.agents.settingsOf('a', 'persona')).toEqual({ text: 'X' });
    expect(ctx.agents.settingsOf('a', 'memory')).toEqual({});
  });
});
