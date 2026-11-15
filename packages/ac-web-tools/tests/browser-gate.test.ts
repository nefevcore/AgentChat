// ============================================================
// ac-web-tools browser 分层门禁行为锁（cr-1092 grants 退役改直读的
// 回归锚点）：tier = max(Agent levels.browser 档位, 会话 browserTier 覆盖)——
// 并集只升不降；disabled 臂直读拦截；settings.browser 布尔回滚兼容线在。
// 放行例断言「错误不含门禁文案」：门禁放行后由下游 browser 执行面接管
//（无 CDP 环境即其错误，恰好证明门禁已过）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as webToolsRow from '../src/index.ts';
import * as agentsRow from 'ac-agents';
import * as convSettingsRow from 'ac-conv-settings';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-webtools-gate-'));
  tmps.push(dir);
  return dir;
}

async function boot() {
  const root = tmpRoot();
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [row, opts] of [
    [toolsRow, undefined],
    [llmRow, undefined],
    [loopRow, undefined],
    [agentsRow, { root }],
    [convSettingsRow, { root }],
    [webToolsRow, {}],
  ] as Array<[unknown, unknown]>) {
    fibers.push(ctx.plugin(row as any, opts));
  }
  await Promise.all(fibers);
  booted.push({ ctx, fibers });
  return ctx;
}

/** 执行 browser 工具（门禁在 tool/before-execute——execute 全链必过） */
function exec(ctx: Context, agentId: string, conversationId: string, action: string) {
  return ctx.tools.execute({ name: 'browser', args: { action }, agentId, conversationId });
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const f of fibers) if (f.uid !== null) await f.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('browser 分层门禁（cr-1092 直读：max(Agent 档位, 会话覆盖)）', () => {
  it('Agent observe 档 + click（需 manipulate）→ 拒；会话 browserTier=manipulate → 门禁放行', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'a1', model: 'm', levels: { browser: 'observe' } });
    // Agent 档位不足 → 门禁拒绝
    const blocked = await exec(ctx, 'a1', 'user~helper', 'click');
    expect(blocked.ok).toBe(false);
    expect(String((blocked as { error?: unknown }).error)).toMatch(/层级/);
    // 会话覆盖并入（并集只升不降）→ 门禁放行（下游 CDP 错误 ≠ 门禁文案）
    ctx.convSettings.set('user~helper', { browserTier: 'manipulate' });
    const allowed = await exec(ctx, 'a1', 'user~helper', 'click');
    expect(allowed.ok).toBe(false);
    expect(String((allowed as { error?: unknown }).error)).not.toMatch(/层级|禁用/);
  });

  it('只升不降：Agent manipulate 档 + 会话 observe 覆盖 → 仍放行 click', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'a2', model: 'm', levels: { browser: 'manipulate' } });
    ctx.convSettings.set('user~helper', { browserTier: 'observe' });
    const r = await exec(ctx, 'a2', 'user~helper', 'click');
    expect(r.ok).toBe(false);
    expect(String((r as { error?: unknown }).error)).not.toMatch(/层级|禁用/);
  });

  it('settings.browser 布尔回滚兼容线（cr-906 X1）：manipulate=true 档位仍在', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'a3', model: 'm', settings: { browser: { observe: true, manipulate: true } } });
    const r = await exec(ctx, 'a3', 'user~helper', 'click');
    expect(r.ok).toBe(false);
    expect(String((r as { error?: unknown }).error)).not.toMatch(/层级|禁用/);
  });

  it('会话 disabled → 直读拦截（优先于 Agent 档位）', async () => {
    const ctx = await boot();
    ctx.agents.register({ id: 'a4', model: 'm', levels: { browser: 'inject' } });
    ctx.convSettings.set('user~helper', { browserTier: 'disabled' });
    const r = await exec(ctx, 'a4', 'user~helper', 'open');
    expect(r.ok).toBe(false);
    expect(String((r as { error?: unknown }).error)).toMatch(/本会话禁用/);
  });
});