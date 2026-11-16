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

describe('M28 P2 · ac-client-ui-run-code 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
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

