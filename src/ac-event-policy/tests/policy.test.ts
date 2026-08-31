// ============================================================
// ac-event-policy/tests/policy.test.ts —— M25 §3.4 / P2
//   · 吞注册语义：停用键命中 → 监听器从未进 _hooks（吞注册≠veto——
//     剩余监听器自动构链照常跑）
//   · 拦截时机：策略行就位后的一切注册；热更只影响后续注册
//   · boot 末清扫：_hooks 不含停用键条目；清扫幂等（重入 0）
//   · internal/* 自锁守卫：策略行自己的 seam 恒放行
//   · setPolicy 写 config events.disabled（键校验 fail-closed）
//   · bail 单链纪律：其余行注册 internal/listener → 红灯（源码静态断言）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber, type Plugin } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
import * as policyRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-policy-'));
  tmps.push(dir);
  return dir;
}

/** config 行插件对象（直构服务的行包装） */
function configRow(root: string): Plugin {
  return {
    name: 'ac-config',
    apply(c: Context) {
      c.plugin(ConfigService, { root });
    },
  } as Plugin;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers.reverse()) {
      if (fiber && fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 直读 _hooks（events/listeners RPC 过滤 internal/*——测试口径按 M25 规约） */
function hooksOf(ctx: Context): Record<string, Array<{ ctx?: { fiber?: { name?: string } } }>> {
  return (ctx.events as unknown as {
    _hooks: Record<string, Array<{ ctx?: { fiber?: { name?: string } } }>>;
  })._hooks;
}

function listenerCount(ctx: Context, owner: string, event: string): number {
  return (hooksOf(ctx)[event] ?? []).filter((h) => h?.ctx?.fiber?.name === owner).length;
}

/** 测试行（命名 fiber = owner；策略行按 fiber 名定位注册方） */
function rowOf(owner: string, apply: (c: Context) => void): Plugin {
  return { name: owner, apply } as Plugin;
}

/** 测试用事件目录声明（治理面测试词汇——声明合并进 Events） */
declare module '@agentchat/cordis' {
  interface Events {
    'demo/event'(): void;
  }
}

describe('ac-event-policy 吞注册（M25 §3.4）', () => {
  it('停用键命中 → 监听器从未进 _hooks；剩余监听器照常构链（吞注册≠veto）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const f1 = await ctx.plugin(configRow(root));
    // 预写停用键（boot 前的 config 即在盘上）
    ctx.config.set('events.disabled', ['observer-row::demo/event']);
    const f2 = await ctx.plugin(policyRow);
    booted.push({ ctx, fibers: [f1, f2] });

    let ran = 0;
    const target = await ctx.plugin(
      rowOf('observer-row', (c) => {
        c.on('demo/event', () => {
          ran++;
        });
      }),
    );
    const other = await ctx.plugin(
      rowOf('other-row', (c) => {
        c.on('demo/event', () => {
          ran += 10;
        });
      }),
    );
    expect(listenerCount(ctx, 'observer-row', 'demo/event')).toBe(0); // 被吞
    expect(listenerCount(ctx, 'other-row', 'demo/event')).toBe(1); // 其余照常
    ctx.emit('demo/event');
    expect(ran).toBe(10); // 只有 other-row 的监听器跑了
    await target.dispose();
    await other.dispose();
  });

  it('拦截只管就位后的注册：先注册后写停用键 → 逃逸（boot 末清扫收口）', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const f1 = await ctx.plugin(configRow(root));
    // 先注册（策略行未就位——逃逸）
    const early = await ctx.plugin(
      rowOf('early-row', (c) => {
        c.on('demo/event', () => undefined);
      }),
    );
    const f2 = await ctx.plugin(policyRow);
    booted.push({ ctx, fibers: [f1, f2] });
    expect(listenerCount(ctx, 'early-row', 'demo/event')).toBe(1); // 逃逸在册

    // 写停用键（热更只影响后续注册）→ 已注册条目仍在
    ctx.config.set('events.disabled', ['early-row::demo/event']);
    expect(listenerCount(ctx, 'early-row', 'demo/event')).toBe(1);

    // boot 末清扫（组合根认领点直调）→ 条目移除；幂等重入 = 0
    const removed = ctx.eventPolicy.sweep();
    expect(removed).toBe(1);
    expect(listenerCount(ctx, 'early-row', 'demo/event')).toBe(0);
    expect(ctx.eventPolicy.sweep()).toBe(0); // 幂等
    // 后续新注册被拦截吃掉
    const again = await ctx.plugin(
      rowOf('early-row', (c) => {
        c.on('demo/event', () => undefined);
      }),
    );
    expect(listenerCount(ctx, 'early-row', 'demo/event')).toBe(0);
    await early.dispose();
    await again.dispose();
  });

  it('internal/* 恒放行（自锁守卫）+ setPolicy 键校验 fail-closed', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const f1 = await ctx.plugin(configRow(root));
    const f2 = await ctx.plugin(policyRow);
    booted.push({ ctx, fibers: [f1, f2] });

    // internal/listener 是本策略行自己的 seam——不可被停（自锁守卫，写侧拒绝）
    await expect(ctx.eventPolicy.setPolicy('ac-event-policy::internal/listener', true)).rejects.toThrow(/internal\/\* 事件不可治理/);
    // 合法键写入 config
    const next = await ctx.eventPolicy.setPolicy('some-owner::loop/after-run', true);
    expect(next).toEqual(['some-owner::loop/after-run']);
    expect(ctx.config.get<string[]>('events.disabled')).toEqual(['some-owner::loop/after-run']);
    await ctx.eventPolicy.setPolicy('some-owner::loop/after-run', false);
    expect(ctx.config.get<string[]>('events.disabled')).toEqual([]);
  });

  it('bail 单链纪律：其余行不注册 internal/listener（源码静态断言）', () => {
    const trackDir = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // vendor = cordis 框架本体（internal/listener 的定义方），非本轨行
          if (e.name === 'tests' || e.name === 'node_modules' || e.name === 'dist' || e.name === 'vendor') continue;
          walk(full);
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf-8');
          if (text.includes("'internal/listener'") && !full.includes(path.join('ac-event-policy', 'src'))) {
            offenders.push(path.relative(trackDir, full));
          }
        }
      }
    };
    walk(trackDir);
    expect(offenders).toEqual([]);
  });
});
