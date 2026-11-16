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

describe('M28 P1 · ac-client-ui-skill 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const ctx = new Context();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(row.extension.name).toBe(row.extension.name.trim());
    expect(row.extension.label.length).toBeGreaterThan(0);
    expect(row.extension.automatic).toBe(true);
  });
});

describe('M28 P1 · skillsApi 数据面', () => {
  it('fetchSkills：RPC 失败（后端行摘除）→ null（技能区静默隐藏，不抛）', async () => {
    const { fetchSkills } = await import('../client/skillsApi.ts');
    const badRpc = {
      call() {
        return Promise.reject(new Error('method not found'));
      },
    };
    await expect(fetchSkills('a1', 'a1~user', badRpc)).resolves.toBeNull();
  });

  it('fetchSkills：成功路径——三源合成 + 缺字段归一空数组 + 参数形状（agentId/conversationId 缺省不传键）', async () => {
    const { fetchSkills } = await import('../client/skillsApi.ts');
    const seen: Array<{ method: string; params: unknown }> = [];
    const reply: unknown = {
      skills: {
        global: [{ name: 'agentchat-dev', description: 'd', dirName: 'agentchat-dev' }],
        own: [],
        workspace: [{ name: 'w1', description: 'd2', dirName: 'w1', dir: '.claude/skills', location: 'ws/.claude/skills' }],
      },
    };
    const rpc = {
      call<T>(method: string, params: unknown): Promise<T> {
        seen.push({ method, params });
        return Promise.resolve(reply as T);
      },
    };
    const r = await fetchSkills('a1', 'a1~user', rpc);
    expect(r).toEqual({
      global: [{ name: 'agentchat-dev', description: 'd', dirName: 'agentchat-dev' }],
      own: [],
      workspace: [{ name: 'w1', description: 'd2', dirName: 'w1', dir: '.claude/skills', location: 'ws/.claude/skills' }],
    });
    expect(seen).toEqual([
      { method: 'skills/list', params: { agentId: 'a1', conversationId: 'a1~user' } },
    ]);
  });

  it('fetchSkills：全缺省载荷（skills 字段缺席）→ 三源全归一空数组（非 null——行在场即有目录面）', async () => {
    const { fetchSkills } = await import('../client/skillsApi.ts');
    const rpc = {
      call<T>(): Promise<T> {
        return Promise.resolve({} as T);
      },
    };
    await expect(fetchSkills(undefined, undefined, rpc)).resolves.toEqual({ global: [], own: [], workspace: [] });
  });

  it('fetchSkills：agentId/conversationId 缺省时 params 不携带空键（全局目录口径）', async () => {
    const { fetchSkills } = await import('../client/skillsApi.ts');
    const seen: Array<{ method: string; params: unknown }> = [];
    const reply: unknown = { skills: {} };
    const rpc = {
      call<T>(method: string, params: unknown): Promise<T> {
        seen.push({ method, params });
        return Promise.resolve(reply as T);
      },
    };
    await fetchSkills(undefined, undefined, rpc);
    expect(seen).toEqual([{ method: 'skills/list', params: {} }]);
  });
});
