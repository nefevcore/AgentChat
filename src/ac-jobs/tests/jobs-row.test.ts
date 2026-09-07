// ============================================================
// src/ac-jobs/tests/jobs-row.test.ts —— 行包双半边验收（M27 S3-1b/D19）
//
// 宿主半边：boot graph 声明 + 卸载级联（ac-jobs 行装载即声明 client
// 半边——前端消费面随行走）。bootTree 全树 HTTP 面见 webui/tests/
// boot-graph-http.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as jobsRow from '../src/index.ts';

/** 装载本行（namespace 插件形态——经类型垫片走 ctx.plugin） */
async function loadRow(ctx: Context, options?: Record<string, unknown>): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(jobsRow, options);
}

async function boot() {
  const ctx = new Context();
  // JobsService 构造零副作用（注册中心形态——producer 不在场即空表）
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  return ctx;
}

describe('S3-1b · ac-jobs 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 jobs 条目（entry 为绝对路径）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('jobs');
    const def = graph.find((g) => g.name === 'jobs')!;
    expect(def.platform).toBe('web');
    expect(def.entry).toMatch(/ac-jobs[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = await boot();
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('jobs');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('jobs');
    expect(changed.filter((n) => n === 'jobs').length).toBeGreaterThanOrEqual(2);
    off();
  });
});
