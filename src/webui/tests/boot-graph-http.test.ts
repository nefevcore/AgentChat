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
    expect(graph.map((g) => g.name)).toContain('runview');
    // S3-1a：ac-todo 行包双半边——后端行声明 client 半边（随行走 D19）
    expect(graph.map((g) => g.name)).toContain('todo');
    // HTTP 面（真路由注册）
    const port = await tree.ctx.webServer.ready();
    const res = await fetch(`http://127.0.0.1:${port}/api/ui/boot-graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<{ name: string }> };
    expect(body.clients.map((c) => c.name)).toContain('runview');
    for (const fiber of [...tree.fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('重启径：cordis.patch.yml 停用 todo 行（bootDist skip 集）→ boot graph 不含 todo（后端 + 前端消费面一并消失）', { timeout: 30_000 }, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'ac-bootgraph-'));
    const { bootTree } = await import('../../ac-app/src/index.ts');
    // bootDist 读 <dataRoot>/cordis.patch.yml {id: todo, disabled: true} 后
    // 正是传此 skip 集进 bootTree（patch 文件解析归 bootstrap.test 覆盖）
    const tree = await bootTree(
      {
        session: { root: dataRoot },
        group: { root: dataRoot },
        conversation: { root: dataRoot },
        usage: { root: dataRoot },
        credentials: { root: dataRoot },
        config: { root: dataRoot },
      },
      new Set(['todo']),
    );
    const names = tree.ctx.webui.listBootGraph().map((g) => g.name);
    expect(names).not.toContain('todo');
    expect(names).toContain('runview'); // 其余行不受牵连（宿主不残废）
    expect(tree.ctx.get('todos', false)).toBeUndefined(); // 后端能力同灭
    for (const fiber of [...tree.fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });
});
