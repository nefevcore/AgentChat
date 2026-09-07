// ============================================================
// src/ac-client-ui-jobs/tests/jobs-row.test.ts —— 前端行验收（M27.1）
//
// 宿主半边：boot graph 声明 + 卸载级联（声明回收 → 前端 jobs 消费面
// 消失的服务端证据）+ 双向摘除（UI 行 ⇄ ac-jobs 后端行独立可摘）。
// client 半边（域投影 + ctx.jobBoard）验收见 webui/tests/clients-jobs。
// bootTree 全树 HTTP 面见 webui/tests/boot-graph-http.test.ts。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as uiJobsRow from '../src/index.ts';

/** 装载本行（namespace 插件形态——经类型垫片走 ctx.plugin） */
async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(uiJobsRow, undefined);
}

async function boot() {
  const ctx = new Context();
  // JobsService 构造零副作用（注册中心形态——producer 不在场即空表）
  const { WebUiService } = await import('ac-webui/src/service.ts');
  new WebUiService(ctx);
  return ctx;
}

/** 装载后端行（ac-jobs 无硬 inject——直挂 JobsService；跨包深路径仅供测试） */
async function loadBackendRow(ctx: Context): Promise<Fiber> {
  const backend = await import('ac-jobs/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(backend, undefined);
}

describe('M27.1 · ac-client-ui-jobs 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-jobs 条目（entry 为绝对路径）', async () => {
    const ctx = await boot();
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-jobs');
    const def = graph.find((g) => g.name === 'ui-jobs')!;
    expect(def.platform).toBe('web');
    expect(def.entry).toMatch(/ac-client-ui-jobs[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = await boot();
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-jobs');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-jobs');
    expect(changed.filter((n) => n === 'ui-jobs').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → boot graph 收缩，后端行照常在场（ctx.jobs 服务可调）', async () => {
    const ctx = await boot();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-jobs');
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-jobs');
    expect(ctx.get('jobs')).toBeDefined(); // 后端能力不受牵连（RPC 可调）
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常在场（boot graph 不收缩——RPC 失败空态归前端三态语义）', async () => {
    const ctx = await boot();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('jobs', false)).toBeUndefined(); // 后端能力同灭
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-jobs'); // UI 行不动
    await uiFiber.dispose();
  });
});
