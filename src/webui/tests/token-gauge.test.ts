// @vitest-environment jsdom
// ============================================================
// webui/tests/token-gauge.test.ts —— Token 仪表占用比例含固定开销
//
// 2026-12 前端反馈：统计占用比例时应加上工具定义与系统提示词——
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

/** 记录型 rpc 桩：session/tokens 按脚本应答（仪表基线走 useClientContext 注入） */
function recordingRpc(script: { tokens?: Record<string, unknown> } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    impl: {
      async call<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === 'session/tokens') {
          return (script.tokens ?? { contextTokens: 0 }) as T;
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
      tokens: { messageCount: 2, contextTokens: 60_000, maxContextTokens: 100_000, usagePercent: 60, status: 'moderate' },
    });
    const root = await mountGauge(rpc.impl, baseData);
    expect(ringText(root)).toBe('60'); // 未取前 = 净占用
    await openPanel(root);
    await seedOverhead(SYS_2K, [{ name: 'bash', description: '在 shell 中执行命令', parameters: { type: 'object' } }]);
    expect(ringText(root)).toBe('62'); // 60,000 + 2,004 + 18 = 62,022 → 62%
    // 明细行在场：工具定义 / 系统提示词 / 合计（含固定开销）
    const rows = [...root.querySelectorAll('.token-row .k')].map((el) => el.textContent);
    expect(rows).toContain('工具定义');
    expect(rows).toContain('系统提示词');
    expect(rows).toContain('合计（含固定开销）');
  });

  it('固定开销可跨档位：净 74%（moderate）+ 开销 ≈2k → 76% = high 档', async () => {
    const rpc = recordingRpc({
      tokens: { messageCount: 5, contextTokens: 74_000, maxContextTokens: 100_000, usagePercent: 74, status: 'moderate' },
    });
    const root = await mountGauge(rpc.impl, baseData);
    await openPanel(root);
    await seedOverhead(SYS_2K, []);
    // 74k + 2,004 = 76,004 → ≥75% = high（档位随并入后的占比重判，阈值与后端同款）
    const statusEl = root.querySelector('.token-panel__status') as HTMLElement;
    expect(statusEl.className).toContain('high');
    expect(statusEl.textContent).toBe('接近上限');
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
