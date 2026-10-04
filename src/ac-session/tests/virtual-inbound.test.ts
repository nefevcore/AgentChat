// ============================================================
// tail() 末条口径回归（cr-194）：宿主注入行（context/event）不当发言展示
// —— admin~user 孤儿记忆快照行垫桶案例（原探针已收，留本回归锁定口径）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tail-orphan-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const fiber = ctx.plugin(sessionRow as any, { root });
  await fiber;
  fibers.push(fiber);
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tail() 末条口径（cr-194）', () => {
  it('孤儿 context 行垫桶 → tail 返回其前的末条真实发言', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('admin~user', 'user', { role: 'user', content: '真实发言' });
    await ctx.session.append('admin~user', 'admin', { role: 'user', content: '简报正文' });
    // 宿主注入行（与生产孤儿同形：recordContext 直落）
    (ctx.session as any).recordContext('admin~user', 'user', '（记忆时间线：4 条 · …）\n记忆基线 seq=4', { source: 'memory-snapshot', label: '长期记忆快照注入' });
    for (let i = 0; i < 100; i++) {
      const t = ctx.session.tail('admin~user');
      if (t?.content === '简报正文') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const t = ctx.session.tail('admin~user');
    expect(t?.content).toBe('简报正文');
    expect(t?.agent_id).toBe('admin');
  });
});
