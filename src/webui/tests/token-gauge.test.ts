// @vitest-environment jsdom
// ============================================================
// webui/tests/token-gauge.test.ts —— Token 仪表占用比例含固定开销
//
// 2026-09-18 前端反馈：统计占用比例时应加上工具定义与系统提示词——
// 会话头环形与弹层环形的占比/档位由净占用（usagePercent）改为
// 「会话净占用 + 系统提示 + 工具定义实值估算」口径：
//   · 弹层打开时经 chatStore.requestSystemPrompt/requestToolDefs
//     取实值（agents/system-prompt 干跑 + router 同口径生效集）；
//   · 未取（弹层从未打开/加载中）= 0 并入——不虚假抬高占用；
//   · 档位阈值与后端 session/tokens 同款（<50 low/<75 moderate/
//     <90 high/≥90 critical）；
//   · 弹层补「合计（含固定开销）」明细行。
// 真 vue 渲染（项目惯例 createApp 直 mount，@vue/test-utils 不可用）。
// 固定开销数据面走 chatStore（无 runtime 单测 = offlineRpc 独立实例）——
// 实值注入直接写 store 状态（rpc 拉取链属 chat-core，另有测试覆盖）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import { useChatStore } from 'ac-client-ui-conversation/client/chatStore.ts';
import TokenGauge from 'ac-client-ui-conversation/client/header/TokenGauge.vue';

/** 记录型 rpc 桩：session/tokens / session/kv-timeline 按脚本应答（仪表基线走 useClientContext 注入） */
function recordingRpc(script: { tokens?: Record<string, unknown>; kv?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    impl: {
      async call<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === 'session/tokens') {
          return (script.tokens ?? { contextTokens: 0 }) as T;
        }
        if (method === 'session/kv-timeline') {
          return { conversationId: (params as { conversationId?: string })?.conversationId, points: script.kv ?? [] } as T;
        }
        throw new Error(`unexpected rpc: ${method}`);
      },
    },
  };
}

async function mountGauge(rpc: unknown, data: Record<string, unknown>): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const pinia = createPinia();
  setActivePinia(pinia); // 组件外 useChatStore()（实值注入）与组件内同实例
  const app = createApp({
    render: () => h(TokenGauge as never, { data }),
  });
  app.use(pinia);
  app.provide(CLIENT_CONTEXT_KEY, { rpc });
  app.mount(root);
  for (let i = 0; i < 8; i++) await nextTick();
  await Promise.resolve();
  return root;
}

/** 仪表触发弹层（toggleTokenPanel——rpc 取数链在无 runtime 单测走 offlineRpc，这里只开面板） */
async function openPanel(root: HTMLElement): Promise<void> {
  (root.querySelector('.session-token-gauge') as HTMLElement)?.click();
  for (let i = 0; i < 8; i++) await nextTick();
  await Promise.resolve();
}

/** 固定开销实值注入（模拟 agents/system-prompt · agents/tool-defs 已返回） */
async function seedOverhead(systemPrompt: string, defs: unknown[]): Promise<void> {
  const chat = useChatStore();
  chat.systemPromptContent = systemPrompt;
  chat.toolDefs = defs as never;
  for (let i = 0; i < 4; i++) await nextTick();
}

function ringText(root: HTMLElement): string {
  return (root.querySelector('.gauge-ring-pct') as HTMLElement)?.textContent ?? '';
}

/** 3340 个 CJK 字 ≈ 2004 tokens（estimateTokens 0.6/字） */
const SYS_2K = '一二三四五六七八九十'.repeat(334);

const baseData = { agentId: 'helper', form: 'direct', conversationId: 'helper~user', single: null };

describe('TokenGauge 占用比例含固定开销', () => {
  it('未取实值（弹层从未打开）：固定开销 = 0 并入——占比 = 净占用', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 2, contextTokens: 60_000, maxContextTokens: 100_000, usagePercent: 60 },
    });
    const root = await mountGauge(rpc.impl, baseData);
    expect(ringText(root)).toBe('60'); // 60k/100k，开销 0 并入
  });

  it('实值并入：系统提示 + 工具定义抬高占比；明细含合计行', async () => {
    // 净 60k + 系统提示 ≈2k + 工具定义 ≈18 → ≈62k/100k = 62%
    const rpc = recordingRpc({
      tokens: { messageCount: 2, contextTokens: 60_000, maxContextTokens: 100_000, usagePercent: 60, status: 'normal' },
    });
    const root = await mountGauge(rpc.impl, baseData);
    expect(ringText(root)).toBe('60'); // 未取前 = 净占用
    await openPanel(root);
    await seedOverhead(SYS_2K, [{ name: 'bash', description: '在 shell 中执行命令', parameters: { type: 'object' } }]);
    expect(ringText(root)).toBe('62'); // 60,000 + 2,004 + 18 = 62,022 → 62%
    // 图例一例一行（cr-234 #1：余量行回归）：四行、键名与数值在场
    const legendRows = [...root.querySelectorAll('.token-legend__row')].map((el) => el.textContent ?? '');
    expect(legendRows).toHaveLength(4);
    expect(legendRows.some((t) => t.includes('会话上下文'))).toBe(true);
    expect(legendRows.some((t) => t.includes('系统提示词'))).toBe(true);
    expect(legendRows.some((t) => t.includes('工具定义'))).toBe(true);
    expect(legendRows.some((t) => t.includes('余量'))).toBe(true);
    // 堆叠条四段（余量占位段回归；cr-234 #3 段序反转：工具定义→系统提示→会话上下文→余量）
    const segs = [...root.querySelectorAll('.token-stack__seg')] as Array<HTMLElement>;
    expect(segs).toHaveLength(4);
    expect(segs.every((el) => el.style.flexBasis === '2px' || el.style['flex-basis'] === '2px')).toBe(true);
    const grows = segs.map((el) => parseFloat(el.style.flexGrow));
    // 真比例（grow = token 数）：微段工具定义 < 系统提示 2,004 < 会话 60k < 余量 ~37k 不必最大（只锁前三序）
    expect(grows[0]).toBeGreaterThan(0);
    expect(grows[0]).toBeLessThan(grows[1]);
    expect(grows[1]).toBe(2_004);
    expect(grows[2]).toBe(60_000);
    expect(grows[3]).toBe(100_000 - grows[0] - grows[1] - grows[2]);
    // 段色 = 星色板 hex 内联（cr-234 #2 浅淡色带；jsdom 归一为 rgb）——三段各色 + 余量无内联色
    expect(segs[0].style.background).toBe('rgb(236, 197, 154)'); // #ecc59a 杏橙（cr-237 两色对调）
    expect(segs[1].style.background).toBe('rgb(201, 167, 236)'); // #c9a7ec 柔紫
    expect(segs[2].style.background).toBe('rgb(143, 184, 230)'); // #8fb8e6 柔蓝
    expect(segs[3].style.background).toBe('');
    // 段间 1.5px 分隔缝（非首段带 is-gap-before）
    expect(segs[0].classList.contains('is-gap-before')).toBe(false);
    expect(segs.slice(1).every((el) => el.classList.contains('is-gap-before'))).toBe(true);
    // 头行（cr-232 #1）：「上下文占用 N%」+ ~占用/上限
    const topline = (root.querySelector('.token-bar-topline') as HTMLElement)?.textContent ?? '';
    expect(topline).toContain('上下文占用 62%');
    expect(topline).toContain('~62K / 100K');
  });

  it('固定开销可跨档位：净 74%（normal）+ 开销 ≈2k → 76% = high 档', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 5, contextTokens: 74_000, maxContextTokens: 100_000, usagePercent: 74, status: 'normal' },
    });
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    await seedOverhead(SYS_2K, []);
    // 74k + 2,004 = 76,004 → ≥75% = high（档位随并入后的占比重判，阈值与后端同款）
    const ringPct = root.querySelector('.gauge-ring-pct') as HTMLElement;
    expect(ringPct.className).toContain('high');
    expect(ringPct.textContent).toBe('76');
  });

  it('KV 缓存率走势（cr-231）：开面板拉 kv-timeline，sparkline 渲染等距折线', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 3, contextTokens: 50_000, maxContextTokens: 100_000, usagePercent: 50 },
      kv: [
        { ts: Date.parse('2026-10-05T10:00:00Z'), hit: 950, miss: 50 },
        { ts: Date.parse('2026-10-05T10:05:00Z'), hit: 990, miss: 10 },
        { ts: Date.parse('2026-10-05T10:40:00Z'), hit: 0, miss: 900 }, // 归档后全 miss 跳变
      ],
    });
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    // 拉取参数：会话键 = 对桶推导（viewer~helper 排序）；无 limit（cr-236 全量）
    const kvCall = rpc.calls.find((c) => c.method === 'session/kv-timeline');
    expect(kvCall?.params).toMatchObject({ conversationId: 'helper~user' });
    // sparkline 在场：标签（步口径）+ 折线（3 点全有数据 → 单段折线）
    expect(root.querySelector('.kv-spark')).toBeTruthy();
    const label = (root.querySelector('.kv-spark__label') as HTMLElement)?.textContent ?? '';
    expect(label).toContain('全部 3 步');
    const lines = root.querySelectorAll('.kv-spark__line');
    expect(lines).toHaveLength(1);
    // 去点（cr-235 #4）：无 circle 数据点，走势由折线承载
  });

  it('KV 走势懒加载（cr-236 #2）：拉取中 BusyRing 转圈，完成后渲染', async () => {
    let release: ((v: unknown) => void) | undefined;
    const rpc = recordingRpc({
      tokens: { messageCount: 2, contextTokens: 10_000, maxContextTokens: 100_000, usagePercent: 10 },
    });
    // kv-timeline 挂起：首拉不返回 → loading 态
    const origCall = rpc.impl.call.bind(rpc.impl);
    rpc.impl.call = async (method: string, params?: unknown) => {
      if (method === 'session/kv-timeline') {
        await new Promise((r) => { release = r; });
        return { points: [{ ts: 1, hit: 5, miss: 5 }, { ts: 2, hit: 9, miss: 1 }] };
      }
      return origCall(method, params);
    };
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    expect(root.querySelector('.kv-spark--loading')).toBeTruthy(); // 转圈在场
    expect(root.querySelector('.kv-spark__svg')).toBeFalsy(); // 走势未渲染
    release?.(null);
    for (let i = 0; i < 8; i++) await nextTick();
    await Promise.resolve();
    expect(root.querySelector('.kv-spark--loading')).toBeFalsy();
    expect(root.querySelector('.kv-spark__svg')).toBeTruthy(); // 完成后渲染
  });

  it('KV 走势 null 点断线（hit+miss=0 的 run 不连线）+ 单点不绘线', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 2, contextTokens: 10_000, maxContextTokens: 100_000, usagePercent: 10 },
      kv: [
        { ts: Date.parse('2026-10-05T10:00:00Z'), hit: 0, miss: 0 },
        { ts: Date.parse('2026-10-05T10:01:00Z'), hit: 800, miss: 200 },
        { ts: Date.parse('2026-10-05T10:02:00Z'), hit: 0, miss: 0 },
        { ts: Date.parse('2026-10-05T10:03:00Z'), hit: 700, miss: 300 },
      ],
    });
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    // 两段独立折线（0-1 无线、1-2 断、2-3 断；仅 1→无、1 与 3 互不连 → 0 段？
    // 实际：点 0 null、点 1 有、点 2 null、点 3 有 → 单点段不入串 → 0 条折线）
    expect(root.querySelectorAll('.kv-spark__line')).toHaveLength(0);
    expect(root.querySelectorAll('.kv-spark__dot, .kv-spark__nodata')).toHaveLength(0); // 去点（cr-235 #4）
  });

  it('占比封顶 100%：开销并入不溢出环形', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 9, contextTokens: 99_000, maxContextTokens: 100_000, usagePercent: 99, status: 'critical' },
    });
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    await seedOverhead(SYS_2K, []);
    expect(ringText(root)).toBe('100'); // 101,004 → min(100, 101)
  });
});
