// 乱序激活回归（cr-280 根因锁定）：loader 并发激活下行序 ≠ 激活序——
// harness 行先创建、conv-settings 后到，inject 依赖等待保证 registerKey 不漏。
import { describe, it, expect } from 'vitest';
import { Context } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as convSettingsRow from 'ac-conv-settings';
import * as harnessRow from '../src/index.ts';

describe('乱序激活（loader 语义）', () => {
  it('harness 行先创建、conv-settings 后到 → harnessTier 仍注册（inject 依赖等待）', async () => {
    const ctx = new Context();
    const f1 = ctx.plugin(harnessRow, {}); // 先 harness（软取时代在此漏注册）
    const f2 = ctx.plugin(convSettingsRow, {});
    const f3 = ctx.plugin(toolsRow, undefined);
    const fibers = await Promise.all([f1, f2, f3]);
    try {
      const keys = ctx.convSettings.listKeys().map((k) => k.key);
      expect(keys).toContain('harnessTier');
    } finally {
      for (const fiber of [...fibers].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
    }
  });
});