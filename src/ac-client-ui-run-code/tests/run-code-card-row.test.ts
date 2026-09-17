// ============================================================
// ac-client-ui-run-code/tests/run-code-card-row.test.ts —— 程序卡行验收
//（M28 P2 §2.2：boot graph 声明 + 卸载级联回收；席位贡献见
// webui/tests/clients-tool-cards）
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M28 P2 · ac-client-ui-run-code 宿主半边（boot graph 声明）', () => {
  it('行装载 → boot graph 含 ui-run-code（phase=domain，entry 绝对路径）；卸载 → 级联回收 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-run-code');
    const def = graph.find((g) => g.name === 'ui-run-code')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('domain');
    expect(def.entry).toMatch(/ac-client-ui-run-code[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-run-code');
    expect(changed.filter((n) => n === 'ui-run-code').length).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe('卡片数据面 · run_code 参数层并入（实测复盘 4cd1a90d：收束后程序体消失）', () => {
  // ToolMessage.resultData 的归一逻辑镜像：完成态 = { ...args, ...resultData }
  // （结果字段优先）。run_code 结果不含程序体（上下文纪律——只有 programHash），
  // 程序体在 arguments.code——不并入则收束/刷新后程序段 v-if="code" 直接消失。
  function mergeResultData(args: Record<string, unknown>, parsed: unknown): Record<string, unknown> {
    return { ...args, ...(parsed as Record<string, unknown>) };
  }

  it('run_code 完成态：arguments.code 并入后仍在（程序体不因收束丢失）', () => {
    const args = { code: 'const r = await tools.read({ file_path: "a" });\nreturn r;' };
    const resultData = { summary: { calls: 1 }, programHash: 'e9868bd6', value: { ok: true } };
    const merged = mergeResultData(args, resultData);
    expect(merged.code).toBe(args.code);
    expect(merged.programHash).toBe('e9868bd6');
  });

  it('结果字段优先：结果含同名键时参数层被覆盖（read 的 path 等不漂移）', () => {
    const merged = mergeResultData({ file_path: 'a.ts', note: '参数预览' }, { path: 'a.ts', content: '1:x' });
    expect(merged.path).toBe('a.ts');
    expect(merged.note).toBe('参数预览');
    expect(merged.content).toBe('1:x');
  });
});

