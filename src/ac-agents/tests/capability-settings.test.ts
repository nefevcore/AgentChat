// ============================================================
// ac-agents/tests/capability-settings.test.ts —— ◐a 行内档位
// settings 合成（cr-691）：capabilitySetOf = tags ∪ settings 合成词
//   · settings.browser.{observe,manipulate,inject} 层级布尔 → web+层级词
//     （高层含低层——与 conv-settings browserTier grants 同形）
//   · settings.collab.admin === true → admin
//   · settings['dev-tools'].enabled === true → dev
//   · 并集语义：旧 tags 词仍生效（未迁移数据回滚线兼容）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from '../src/index';
import * as configRow from 'ac-config';
import { capabilitySetOf, toolAllowedFor } from '../src/index';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cap-settings-'));
  tmps.push(dir);
  return dir;
}

async function boot(root: string) {
  const ctx = new Context();
  const f1 = ctx.plugin(configRow, { root });
  await f1;
  const f2 = ctx.plugin(agentsRow);
  await f2;
  booted.push({ ctx, fibers: [f1, f2] });
  return { ctx };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('capabilitySetOf 行内档位 settings 合成（◐a cr-691）', () => {
  it('settings.browser 层级布尔 → web + 层级词（高层含低层）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({
      id: 'b1',
      model: 'm',
      settings: { browser: { observe: true } },
    });
    ctx.agents.register({
      id: 'b3',
      model: 'm',
      settings: { browser: { observe: true, manipulate: true, inject: true } },
    });
    const c1 = capabilitySetOf(ctx, 'b1');
    expect(c1.has('web')).toBe(true);
    expect(c1.has('observe')).toBe(true);
    expect(c1.has('manipulate')).toBe(false);
    expect(toolAllowedFor({ requiredTags: ['web', 'observe'] }, c1)).toBe(true);
    const c3 = capabilitySetOf(ctx, 'b3');
    for (const t of ['web', 'observe', 'manipulate', 'inject']) expect(c3.has(t)).toBe(true);
  });

  it('settings.collab.admin / dev-tools.enabled → admin / dev；并集语义旧 tags 词仍生效', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({
      id: 's1',
      model: 'm',
      settings: { collab: { admin: true }, 'dev-tools': { enabled: true } },
    });
    ctx.agents.register({
      id: 's2',
      model: 'm',
      tags: ['admin'],
    });
    const c1 = capabilitySetOf(ctx, 's1');
    expect(c1.has('admin')).toBe(true);
    expect(c1.has('dev')).toBe(true);
    const c2 = capabilitySetOf(ctx, 's2');
    expect(c2.has('admin')).toBe(true);
  });

  it('全 false / 缺席 browser = 无合成词（不误授）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({
      id: 'b0',
      model: 'm',
      settings: { browser: { observe: false, manipulate: false, inject: false } },
    });
    const c0 = capabilitySetOf(ctx, 'b0');
    expect(c0.has('web')).toBe(false);
    expect(c0.has('observe')).toBe(false);
  });
});
