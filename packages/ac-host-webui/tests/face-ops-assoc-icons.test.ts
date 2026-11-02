// ============================================================
// ac-host-webui/tests/face-ops-assoc-icons.test.ts —— workspace/assoc-icons
// RPC 行为面（cr-833）：ext 白名单拒键注入、批量形状、全 null 下限。
// 真机关联决议/提取由 file-assoc-icons.test.ts + 开发期人工点验覆盖。
// ============================================================
import { describe, it, expect } from 'vitest';
import { registerOpsFace } from '../src/face-ops.ts';
import type { Context } from '@agentchat/cordis';

function captureRpc(): (method: string, params: unknown) => Promise<Record<string, unknown>> {
  const handlers = new Map<string, (params: unknown) => unknown>();
  registerOpsFace(
    { registerRpc: (m: string, h: (params: unknown) => unknown) => { handlers.set(m, h); } },
    {} as Context,
    { dataRoot: 'sandbox' },
  );
  return (method, params) => Promise.resolve(handlers.get(method)!(params) as Promise<Record<string, unknown>>);
}

describe('workspace/assoc-icons（cr-833）', () => {
  it('ext 白名单：非法 ext（注入形态/超长）被拒；合法 ext 形状为 Record<ext, dataURL|null>', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/assoc-icons', { exts: ['md', 'TS', 'bad/ext', 'x'.repeat(20), 42, null, 'md'] });
    const icons = r.icons as Record<string, unknown>;
    expect(Object.keys(icons).sort()).toEqual(['md', 'ts']); // 大写归一 + 非法剔除 + 去重
  });

  it('空清单/非数组入参 → 空 icons（不炸）', async () => {
    const rpc = captureRpc();
    const r1 = await rpc('workspace/assoc-icons', {});
    const r2 = await rpc('workspace/assoc-icons', { exts: 'md' });
    expect(r1.icons).toEqual({});
    expect(r2.icons).toEqual({});
  });

  it('批量形状：多 ext 并发返回（值 = dataURL 或 null）+ dirIcon 附带', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/assoc-icons', { exts: ['md', 'txt', 'zzqqxx'] });
    const icons = r.icons as Record<string, unknown>;
    expect(Object.keys(icons).length).toBe(3);
    for (const v of Object.values(icons)) {
      expect(v === null || (typeof v === 'string' && v.startsWith('data:image/png;base64,'))).toBe(true);
    }
    expect(r.dirIcon === null || (typeof r.dirIcon === 'string' && (r.dirIcon as string).startsWith('data:image/png;base64,'))).toBe(true);
  });
});