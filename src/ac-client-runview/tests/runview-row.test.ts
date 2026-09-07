// ============================================================
// src/ac-client-runview/tests/runview-row.test.ts —— client-only 行验收
//
// S3/D19：宿主半边（boot graph 声明）+ 卸载级联（声明回收 → 前端
// 消费面消失的服务端证据）。bootTree 全树 HTTP 面见 webui/tests/
// boot-graph-http.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as runviewRow from '../src/index.ts';

/** 装载本行（namespace 插件形态——经类型垫片走 ctx.plugin） */
async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(runviewRow, undefined);
}

async function boot() {
  const ctx = new Context();
  // webui 服务直构（行内单测不拉整树——webui 服务面足够）
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  return ctx;
}

describe('S3 · ac-client-runview 宿主半边（boot graph 声明）', () => {
  it('行装载 → ctx.webui boot graph 含 runview 条目（entry 为绝对路径）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('runview');
    const def = graph.find((g) => g.name === 'runview')!;
    expect(def.platform).toBe('web');
    expect(def.entry).toMatch(/ac-client-runview[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩（前端消费面消失的服务端证据）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('runview');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('runview');
  });
});
