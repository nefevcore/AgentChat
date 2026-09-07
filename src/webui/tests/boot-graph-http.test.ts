// ============================================================
// webui/tests/boot-graph-http.test.ts —— S3 /api/ui/boot-graph
// HTTP 面验收（node 环境：bootTree 真树 + 真路由 + fetch）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('S3 · /api/ui/boot-graph（bootTree 真树 HTTP 面）', () => {
  it('全树 boot → graph 含 runview 条目（服务面 + HTTP 路由）', { timeout: 30_000 }, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'ac-bootgraph-'));
    const { bootTree } = await import('../../ac-app/src/index.ts');
    const tree = await bootTree({
      session: { root: dataRoot },
      group: { root: dataRoot },
      conversation: { root: dataRoot },
      usage: { root: dataRoot },
      credentials: { root: dataRoot },
      config: { root: dataRoot },
    });
    const graph = tree.ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-runview');
    // M27.1：todo 前端行独立（ac-client-ui-todo——boot graph 键 ui-todo；
    // 后端行 ac-todo 回归纯后端，两行经 RPC 契约面解耦）
    expect(graph.map((g) => g.name)).toContain('ui-todo');
    // S3-1b→M27.1：域前端行独立（jobs/todo 已拆 ac-client-ui-*；
    // groups/singles/workspaces/roster 仍随后端行——逐域拆包进行中）
    // M27.1：六域前端行全部独立（todo/jobs/workspace/singles/groups/agents
    // ——ac-client-ui-* 全族；boot graph 键 = 派生名 ui-<域>）
    for (const name of ['ui-jobs', 'ui-group', 'ui-singles', 'ui-workspace', 'ui-agents']) {
      expect(graph.map((g) => g.name)).toContain(name);
    }
    // M27.2：基础件出包首件（phase:'base'——封印前批次）
    const themeDef = graph.find((g) => g.name === 'ui-theme');
    expect(themeDef).toBeDefined();
    expect(themeDef!.phase).toBe('base');
    // HTTP 面（真路由注册）
    const port = await tree.ctx.webServer.ready();
    const res = await fetch(`http://127.0.0.1:${port}/api/ui/boot-graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<{ name: string }> };
    expect(body.clients.map((c) => c.name)).toContain('ui-runview');
    for (const fiber of [...tree.fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('M27.1 双向摘除（真树）：停 ui-todo 前端行 → graph 收缩后端在；停 todo 后端行 → 后端同灭 UI 行在', { timeout: 30_000 }, async () => {
    const bootOverrides = async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), 'ac-bootgraph-'));
      return {
        root: dataRoot,
        configs: {
          session: { root: dataRoot },
          group: { root: dataRoot },
          conversation: { root: dataRoot },
          usage: { root: dataRoot },
          credentials: { root: dataRoot },
          config: { root: dataRoot },
        } as Record<string, unknown>,
      };
    };
    const { bootTree: bootTree1 } = await import('../../ac-app/src/index.ts');
    // ① 停 UI 行（bootDist skip 集——cordis.patch.yml 停用 ui-todo 行等价）：
    //    前端消费面消失，后端能力不受牵连
    {
      const { root, configs } = await bootOverrides();
      const tree = await bootTree1(configs, new Set(['ui-todo']));
      const names = tree.ctx.webui.listBootGraph().map((g) => g.name);
      expect(names).not.toContain('ui-todo');
      expect(tree.ctx.get('todos')).toBeDefined(); // 后端行照常（RPC 可调）
      for (const fiber of [...tree.fibers.values()].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
      rmSync(root, { recursive: true, force: true });
    }
    // ② 停后端行：ctx.todos 同灭，UI 行照常在图（RPC 失败 → 前端三态空态）
    const { bootTree: bootTree2 } = await import('../../ac-app/src/index.ts');
    {
      const { root, configs } = await bootOverrides();
      const tree = await bootTree2(configs, new Set(['todo']));
      const names = tree.ctx.webui.listBootGraph().map((g) => g.name);
      expect(tree.ctx.get('todos', false)).toBeUndefined(); // 后端能力同灭
      expect(names).toContain('ui-todo'); // UI 行不动（宿主不残废）
      expect(names).toContain('ui-runview'); // 其余行不受牵连
      for (const fiber of [...tree.fibers.values()].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
