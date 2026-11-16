// ============================================================
// packages/ac-client-ui-jobs/tests/jobs-row.test.ts —— 前端行验收（M27.1）
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
  // JobsService 构造零副作用（注册中心形态——producer 不在场即空表）
  return new Context();
}

/** 装载后端行（ac-jobs 无硬 inject——直挂 JobsService；跨包深路径仅供测试） */
async function loadBackendRow(ctx: Context): Promise<Fiber> {
  const backend = await import('ac-jobs/src/index.ts');
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(backend, undefined);
}

describe('M27.1 · ac-client-ui-jobs 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const ctx = new Context();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(uiJobsRow.extension.name).toBe(uiJobsRow.extension.name.trim());
    expect(uiJobsRow.extension.label.length).toBeGreaterThan(0);
    expect(uiJobsRow.extension.automatic).toBe(true);
  });
});

describe('M27.1 · 双向摘除（UI 行 ⇄ 后端行独立可摘）', () => {
  it('卸 UI 行 → 后端行照常在场（ctx.jobs 服务可调）', async () => {
    const ctx = await boot();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await uiFiber.dispose(); // 摘 UI 行
    expect(ctx.get('jobs')).toBeDefined(); // 后端能力不受牵连（RPC 可调）
    await backendFiber.dispose();
  });

  it('卸后端行 → UI 行照常可装载（RPC 失败空态归前端三态语义）', async () => {
    const ctx = await boot();
    const backendFiber = await loadBackendRow(ctx);
    const uiFiber = await loadRow(ctx);
    await backendFiber.dispose(); // 摘后端行
    expect(ctx.get('jobs', false)).toBeUndefined(); // 后端能力同灭
    await uiFiber.dispose(); // UI 行装载/卸载不受牵连
  });
});
