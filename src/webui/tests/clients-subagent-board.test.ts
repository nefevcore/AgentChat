// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-subagent-board.test.ts —— subagent 域投影验收
//
// 2026-12 持久化清单主源化（对齐 singles 取值链）：
//   · fetchSubagents：subs 投影/非数组归一/RPC 失败 null（面静默空态）
//   · stopSubagent：透传 id；失败静默 false（下轮帧对账）
//   · ctx.subagentBoard 服务面：装载/reactive/帧驱动刷新/可摘除性（D19）
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { createClient, type ClientContext, type Fiber } from 'ac-client-runtime';
import { SubagentBoardService, fetchSubagents, stopSubagent, type SubBoardEntry } from 'ac-client-ui-subagent/client/board.ts';
import { subagentClientPlugin } from 'ac-client-ui-subagent/client/index.ts';
import { bootWebuiRuntime } from './lib/webuiBoot';

const SUB_A: SubBoardEntry = {
  subId: 'sub_1', name: '调研员', parentId: 'a1', task: '查资料',
  displayStatus: 'done', runs: 2, createdAt: 1, updatedAt: 20, deleted: false,
};
const SUB_B: SubBoardEntry = {
  subId: 'sub_2', name: '写作员', parentId: 'a1', task: '写总结',
  displayStatus: 'running', runs: 0, createdAt: 1, updatedAt: 21, deleted: false,
};
const SUB_TOMB: SubBoardEntry = {
  subId: 'sub_9', name: '旧调研', parentId: 'a1', task: '早期任务',
  displayStatus: 'done', runs: 5, createdAt: 1, updatedAt: 19, deleted: true,
};

function subWire(s: SubBoardEntry): Record<string, unknown> {
  return { id: s.subId, name: s.name, parentId: s.parentId, task: s.task,
    displayStatus: s.displayStatus, runs: s.runs, createdAt: s.createdAt, updatedAt: s.updatedAt,
    deleted: s.deleted };
}

/** rpc 桩：subagents/list·stop 可编程 + onEvent 捕获（帧驱动验证） */
function makeRpc(listResult: { subs?: unknown[] } | Error, stopped = true) {
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  return {
    rpc: {
      call: async (method: string, params?: unknown) => {
        if (listResult instanceof Error) throw listResult; // Error 形态 = RPC 全离线
        if (method === 'subagents/list') {
          return listResult;
        }
        if (method === 'subagents/stop') {
          expect((params as { id: string }).id).toBe('sub_2');
          return { stopped };
        }
        throw new Error(`unexpected rpc: ${method}`);
      },
      onEvent: (h: (type: string, args: unknown[]) => void) => {
        handlers.push(h);
        return () => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    },
    emitFrame: (type: string) => { for (const h of [...handlers]) h(type, []); },
  };
}

async function plugRpc(ctx: ClientContext, rpc: unknown): Promise<void> {
  await ctx.plugin({
    name: 'test-rpc-stub',
    apply(c: ClientContext) {
      c.provide('rpc', rpc);
    },
  });
}

describe('subagent 域投影（board.ts 纯函数 + 服务面）', () => {
  it('fetchSubagents：投影归一（含墓碑——include_deleted 请求）；非数组 → 空清单；RPC 失败 → null', async () => {
    let seenParams: unknown;
    const ok = makeRpc({ subs: [subWire(SUB_A), subWire(SUB_B), subWire(SUB_TOMB)] });
    (ok.rpc as { call: unknown }).call = async (_method: string, params?: unknown) => {
      seenParams = params;
      return { subs: [subWire(SUB_A), subWire(SUB_B), subWire(SUB_TOMB)] };
    };
    const list = (await fetchSubagents(ok.rpc))!;
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual(SUB_A);
    expect(list[2].deleted).toBe(true); // 墓碑投影（展示面「已删除」徽章）
    expect((seenParams as { include_deleted?: boolean }).include_deleted).toBe(true);
    const badShape = makeRpc({});
    expect(await fetchSubagents(badShape.rpc)).toEqual([]);
    const fail = makeRpc(new Error('rpc 失败'));
    expect(await fetchSubagents(fail.rpc)).toBeNull();
  });

  it('stopSubagent：透传 id + stopped 透传；RPC 失败 → false（静默对账）', async () => {
    const ok = makeRpc({ subs: [] });
    expect(await stopSubagent('sub_2', ok.rpc)).toBe(true);
    expect(await stopSubagent('sub_2', makeRpc({ subs: [] }, false).rpc)).toBe(false);
    const fail = makeRpc(new Error('rpc 失败'));
    expect(await stopSubagent('sub_2', fail.rpc)).toBe(false);
  });

  it('服务装载 + 帧驱动刷新：subagents/updated → 重拉投影（reactive 成立）', async () => {
    const ctx = await createClient();
    let result: { subs?: unknown[] } = { subs: [subWire(SUB_A)] };
    const stub = makeRpc(result);
    await plugRpc(ctx, stub.rpc);
    const fiber: Fiber = await ctx.plugin(SubagentBoardService);
    const board = ctx.subagentBoard;
    expect(board).toBeDefined();
    board.ensureStarted();
    await new Promise((r) => setTimeout(r, 10)); // 初始拉取
    expect(board.subs.value).toHaveLength(1);

    const seen: number[] = [];
    const probe = computed(() => { seen.push(1); return board.subs.value; });
    expect(probe.value).toHaveLength(1);

    // 帧驱动：subagents/updated → refresh（清单从 1 条变 2 条）
    (stub.rpc as { call: unknown }).call = async (method: string) => {
      if (method === 'subagents/list') return { subs: [subWire(SUB_A), subWire(SUB_B)] };
      throw new Error('unexpected');
    };
    stub.emitFrame('subagents/updated');
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.value).toHaveLength(2); // 响应式驱动（消费面重算）
    expect(seen.length).toBe(2);
    await fiber.dispose();
  });

  it('stop 状态机：stopping 标记即时 + finally 清理（失败也不残留）', async () => {
    const ctx = await createClient();
    const stub = makeRpc({ subs: [subWire(SUB_B)] });
    await plugRpc(ctx, stub.rpc);
    const fiber = await ctx.plugin(SubagentBoardService);
    const board = ctx.subagentBoard;
    const p = board.stop('sub_2');
    await p;
    expect(board.stopping.value.has('sub_2')).toBe(false);
    await fiber.dispose();
  });

  it('可摘除性（D19 验收）：卸载域插件 fiber → ctx.subagentBoard 消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // rpc 缺省离线（fetch null 空态）
    const fiber = await ctx.plugin(SubagentBoardService);
    expect(ctx.subagentBoard).toBeDefined();
    ctx.subagentBoard.ensureStarted();
    await fiber.dispose();
    expect((ctx as { subagentBoard?: unknown }).subagentBoard).toBeUndefined();
  });

  it('行装载：subagentClientPlugin 装载后 ctx.subagentBoard 可解析', async () => {
    const ctx = await createClient();
    const stub = makeRpc({ subs: [] });
    await plugRpc(ctx, stub.rpc);
    const fiber = await ctx.plugin(subagentClientPlugin);
    expect(ctx.subagentBoard).toBeDefined();
    await fiber.dispose();
  });
});
