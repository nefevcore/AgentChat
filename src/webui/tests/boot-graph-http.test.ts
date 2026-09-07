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
});
