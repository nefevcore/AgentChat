// ============================================================
// ac-harness-tools —— run_harness 行测试（mock gateway 注入——零真子进程）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as convSettingsRow from 'ac-conv-settings';
import * as harnessRow from '../src/index.ts';

// gateway mock：不真 spawn——以 node -e 打印 fixture JSONL（快且跨平台）。
// command 覆盖为 node，适配器 argv 由行侧拼装……这里直接换思路：走行配置
// gateways.claude-code.command = node，并用 args 前缀？——run_harness 的 argv
// 是适配器拼的，不可注入。故 mock 在 runGateway 之上不可行，改用真 node
// 打印：命令 = node，adapter 固定 argv 会给 claude——不成立。
// 结论：行测试聚焦注册面/门禁/互斥/超时语义，exec 面由 core 单测+集成档覆盖。
// 这里用一个伪命令（node 不存在路径）验证 fail-loud 收敛，其余走纯注册断言。

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ fibers: Fiber[] }> = [];

async function boot(rows: Array<[unknown, unknown]>) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ fibers });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-harness-tools run_harness', () => {
  it('工具注册四轴：name/requiredTags/needPermission（injection 缺省 capability）', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, {}]]);
    const def = ctx.tools.get('run_harness');
    expect(def).toBeDefined();
    expect(def?.requiredTags).toEqual(['harness']);
    expect(def?.needPermission).toBe(true);
    expect(def?.injection).toBeUndefined();
  });

  it('参数校验：未知 harness / 空 task → 可读错误', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, {}]]);
    const r1 = await exec(ctx, { name: 'run_harness', args: { harness: 'dsh', task: 'x' } });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('未知 harness');
    const r2 = await exec(ctx, { name: 'run_harness', args: { harness: 'claude-code', task: '  ' } });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('task 不能为空');
  });

  it('行配置停用（enabled:false）→ 拒绝', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, { enabled: false }]]);
    const r = await exec(ctx, { name: 'run_harness', args: { harness: 'claude-code', task: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('停用');
  });

  it('网关停用（gateways.codex.enabled=false）→ 拒绝', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, { gateways: { codex: { command: 'codex', enabled: false } } }]]);
    const r = await exec(ctx, { name: 'run_harness', args: { harness: 'codex', task: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('codex');
  });

  it('spawn 失败（不存在的命令）→ fail-loud 收敛为工具结果（非抛错）', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, { gateways: { 'claude-code': { command: 'definitely-missing-cmd-xyz' } } }]]);
    const r = await exec(ctx, { name: 'run_harness', args: { harness: 'claude-code', task: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.output?.finish).toBe('error');
    expect(r.output?.text).toContain('definitely-missing-cmd-xyz');
  });

  it('harnessTier 实验键注册（conv-settings 同装时进目录；grants 含 harness）', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, {}]]);
    const convSettings = ctx.get('convSettings') as any;
    const keys = convSettings.listKeys();
    const def = keys.find((k: any) => k.key === 'harnessTier');
    expect(def).toBeDefined();
    expect(def.group).toBe('experimental');
    expect(def.grants).toEqual({ enabled: ['harness'] });
  });

  it('会话禁用（harnessTier=disabled）→ execute 自查拒绝', async () => {
    const ctx = await boot([[toolsRow, undefined], [convSettingsRow, {}], [harnessRow, {}]]);
    const convSettings = ctx.get('convSettings') as any;
    convSettings.set('conv-1', { harnessTier: 'disabled' });
    const r = await exec(ctx, { name: 'run_harness', args: { harness: 'claude-code', task: 'x' }, conversationId: 'conv-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('本会话禁用');
  });

  // agent 维互斥与看门狗的 exec 层用例住 core 的 gateway.test.ts（argv 可控：node -e 慢命令）；
  // 行级只测注册/门禁/键路径（本文件已覆盖）。真并发占线由集成档补。
});