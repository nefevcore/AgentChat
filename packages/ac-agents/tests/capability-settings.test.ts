// ============================================================
// ac-agents/tests/capability-settings.test.ts —— 行内档位合成
// （cr-953：tags 轴退役——capabilitySetOf = levels 行内档位单源 +
// settings 回滚兼容线）
//   · levels.browser.{observe,manipulate,inject} 档位词 → web+层级词
//     （高层含低层——与 conv-settings browserTier grants 同形）
//   · levels.collab === 'admin' → admin；levels['dev-tools'] === true → dev
//   · settings.* 同键形状 = 回滚兼容线（levels 赢）
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

  it('settings.collab.admin / dev-tools.enabled → admin / dev（回滚兼容线）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({
      id: 's1',
      model: 'm',
      settings: { collab: { admin: true }, 'dev-tools': { enabled: true } },
    });
    const c1 = capabilitySetOf(ctx, 's1');
    expect(c1.has('admin')).toBe(true);
    expect(c1.has('dev')).toBe(true);
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

describe('levels 档位归装配（cr-906 批4 切片四 / X1 回滚：levels 赢）', () => {
  it('levels.browser 档位词 → web + 层级词（高层含低层）；levels 赢过 settings 同键', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({
      id: 'L1',
      model: 'm',
      levels: { browser: 'manipulate' },
      settings: { browser: { observe: true } }, // levels 赢：manipulate 档（非 observe 档）
    });
    const c = capabilitySetOf(ctx, 'L1');
    expect(c.has('web')).toBe(true);
    expect(c.has('observe')).toBe(true);
    expect(c.has('manipulate')).toBe(true);
    expect(c.has('inject')).toBe(false);
  });

  it('levels.collab admin / dev-tools 布尔；settings 行内档位回滚线仍生效（无 levels 时）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.agents.register({ id: 'L2', model: 'm', levels: { collab: 'admin', 'dev-tools': true } });
    const c2 = capabilitySetOf(ctx, 'L2');
    expect(c2.has('admin')).toBe(true);
    expect(c2.has('dev')).toBe(true);
    ctx.agents.register({ id: 'L3', model: 'm', settings: { collab: { admin: true } } }); // 旧线
    expect(capabilitySetOf(ctx, 'L3').has('admin')).toBe(true);
  });
});
