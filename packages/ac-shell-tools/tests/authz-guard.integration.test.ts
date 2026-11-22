// ============================================================
// authz-guard.integration.test.ts —— 授权工件命令通道拦截（cr-1217 面2）
//
// 语义锚：授权工件（permission-gate.json / auth.json）是审批信任根，
// 任何档位（含 full-access）都拦——与 hostKillViolation 同款；预授权
// 注入的 full 不得成为改写自己授权文件的通道（ISSUE-20 自签事故）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { exec, tmpRoot, boot } from './helpers.ts';
import { CMD_TOOL } from './helpers.ts';

describe('授权工件命令通道拦截（cr-1217 面2）', () => {
  const cases = [
    ['permission-gate.json', 'agents/__creator__/permission-gate.json'],
    ['auth.json', 'agents/__creator__/auth.json'],
  ] as const;

  for (const [label, target] of cases) {
    it(`非 full 档：命令文本含 ${label} → 拒（不许经 shell 读改授权文件）`, async () => {
      const root = tmpRoot();
      const { ctx } = await boot(root);
      const r = await exec(ctx, { name: CMD_TOOL, args: { command: `cat ${target}` } });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('授权工件');
    });

    it(`full-access 档：同样拒（信任根不随档位跳过——预授权 full 不得改写自己的授权文件）`, async () => {
      const root = tmpRoot();
      const { ctx } = await boot(root);
      const r = await exec(ctx, {
        name: CMD_TOOL,
        args: { command: `cat ${target}` },
        access: 'full-access',
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('授权工件');
    });
  }

  it('无关命令不受影响（拦截面 = 授权工件文件名，不误伤普通文件）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: 'echo probe-ok' } });
    expect(r.error ?? '').not.toContain('授权工件');
  });
});
