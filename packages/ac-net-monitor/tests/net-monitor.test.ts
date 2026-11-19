// ============================================================
// ac-net-monitor 单测（cr-1158）：服务探测循环（注入网卡/DNS/时钟）+
// 离线闸（online 放行 / offline 拒绝 / 本地端点豁免 / fail-open）。
// boot 形态照 ac-llm/tests：new Context() → 逐行 ctx.plugin → await。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import type { LlmProvider, LlmStreamChunk } from 'ac-llm';
import * as netRow from '../src/index.ts';
import { NetMonitorService } from '../src/service.ts';

const USER = [{ role: 'user' as const, content: 'hi' }];

/** 脚本化 provider 行（记录 stream 调用数；baseUrl 透出给闸门解析） */
function providerRow(name: string, baseUrl: string | undefined) {
  const calls = { stream: 0 };
  const row = {
    name: 'mock-' + name,
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(name, () => ({
        stream: async function* (): AsyncIterable<LlmStreamChunk> {
          calls.stream += 1;
          yield { delta: 'ok', finish: 'stop' };
        },
      } satisfies LlmProvider), { ...(baseUrl ? { baseUrl } : {}), models: ['m-1'] });
    },
  };
  return { row, calls };
}

/** 网络环境模拟器（注入服务 testProbe；可动态切换） */
function netSim(svc: NetMonitorService, init: { hasAddress: boolean; dnsOk: boolean }) {
  const env = { ...init };
  let t = 1_000_000;
  svc.testProbe = {
    interfaces: () => (env.hasAddress ? { names: ['以太网'], hasAddress: true } : { names: [], hasAddress: false }),
    dns: async () => (env.dnsOk ? 40 : undefined),
    now: () => (t += 3000),
  };
  return { env };
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
async function boot(rows: unknown[]) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = ctx.plugin(row as any);
    fibers.push(f);
  }
  await Promise.all(fibers);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-net-monitor 探测循环', () => {
  it('在线：网卡有信号即 online，零 DNS 探测', async () => {
    const { ctx } = await boot([llmRow, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: true, dnsOk: false }); // dnsOk=false 也不影响（不探测）
    await svc.tickOnce();
    expect(svc.status().online).toBe(true);
  });

  it('断网确认：连续 OFFLINE_CONFIRM 轮 + DNS 失败 → offline 事件', async () => {
    const events: string[] = [];
    const { ctx } = await boot([llmRow, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: false, dnsOk: false });
    ctx.on('net/offline', () => events.push('offline'));
    ctx.on('net/online', () => events.push('online'));
    await svc.tickOnce(); // 疑似：missStreak=1，wantDns=true（下轮探测）
    expect(svc.status().online).toBe(true);
    await svc.tickOnce(); // missStreak=2 = 阈值，DNS 失败 → 翻转
    expect(svc.status().online).toBe(false);
    expect(events).toEqual(['offline']);
  });

  it('恢复：网卡信号回来 → online 事件 + DNS 记账重置', async () => {
    const { ctx } = await boot([llmRow, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    const sim = netSim(svc, { hasAddress: false, dnsOk: false });
    await svc.tickOnce();
    await svc.tickOnce();
    expect(svc.status().online).toBe(false);
    sim.env.hasAddress = true;
    await svc.tickOnce();
    expect(svc.status().online).toBe(true);
    expect(svc.status().dnsDisabled).toBeUndefined();
  });
});

describe('ac-net-monitor 离线闸', () => {
  it('offline + 远程端点：拒绝（provider 不被调用），错误可读', async () => {
    const p = providerRow('remote', 'https://api.deepseek.com/v1');
    const { ctx } = await boot([llmRow, p.row, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: false, dnsOk: false });
    await svc.tickOnce();
    await svc.tickOnce();
    expect(svc.status().online).toBe(false);
    await expect(ctx.llm.chat({ provider: 'remote', model: 'm-1', messages: USER })).rejects.toThrow('net-monitor');
    expect(p.calls.stream).toBe(0); // dispatch 未执行
  });

  it('offline + 本地端点：放行（Ollama 豁免）', async () => {
    const p = providerRow('local', 'http://localhost:11434/v1');
    const { ctx } = await boot([llmRow, p.row, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: false, dnsOk: false });
    await svc.tickOnce();
    await svc.tickOnce();
    const r = await ctx.llm.chat({ provider: 'local', model: 'm-1', messages: USER });
    expect(r.text).toBe('ok');
    expect(p.calls.stream).toBe(1);
  });

  it('online：放行（正常调用不受影响）', async () => {
    const p = providerRow('remote2', 'https://api.deepseek.com/v1');
    const { ctx } = await boot([llmRow, p.row, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: true, dnsOk: true });
    await svc.tickOnce();
    const r = await ctx.llm.chat({ provider: 'remote2', model: 'm-1', messages: USER });
    expect(r.text).toBe('ok');
  });

  it('offline + 无 baseUrl 元数据：fail-open 放行', async () => {
    const p = providerRow('nourl', undefined);
    const { ctx } = await boot([llmRow, p.row, netRow]);
    const svc = ctx.netMonitor as NetMonitorService;
    netSim(svc, { hasAddress: false, dnsOk: false });
    await svc.tickOnce();
    await svc.tickOnce();
    const r = await ctx.llm.chat({ provider: 'nourl', model: 'm-1', messages: USER });
    expect(r.text).toBe('ok');
  });
});