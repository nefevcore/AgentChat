// ============================================================
// ac-client-ui-skill/tests/skill-row.test.ts —— 前端行验收
//（M28 P1 §4.1：数据面行——boot graph 声明 + 卸载级联回收 + 纯函数）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P1 · ac-client-ui-skill 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-skill（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-skill');
    const def = graph.find((g) => g.name === 'ui-skill')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-skill[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-skill');
    expect(changed.filter((n) => n === 'ui-skill').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M28 P1 · skillsApi 数据面（RPC 失败三态静默）', () => {
  it('fetchSkills：RPC 失败（后端行摘除）→ null（技能区静默隐藏，不抛）', async () => {
    const { fetchSkills } = await import('../client/skillsApi.ts');
    const badRpc = {
      call() {
        return Promise.reject(new Error('method not found'));
      },
    };
    await expect(fetchSkills('a1', 'a1~user', badRpc)).resolves.toBeNull();
  });
});
