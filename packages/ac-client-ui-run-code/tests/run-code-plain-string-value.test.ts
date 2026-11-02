// @vitest-environment jsdom
// ============================================================
// ac-client-ui-run-code/tests/run-code-plain-string-value.test.ts
// —— 返回值分形渲染验收：run_code return 纯 string 时按普通文本
// 直显（保留换行、无引号包裹），对象/数组仍走 JSON 代码块；
// 卡内「工具调用」时间线退役验收（cr-764——逐条子调用由紧随的
// subcall 平铺卡展示，卡内只留汇总徽章行）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultRunCode from '../client/ToolResult/ToolResultRunCode.vue';

interface Mount { root: HTMLElement; unmount: () => void }

async function mountCard(data: Record<string, unknown>): Promise<Mount> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(ToolResultRunCode, { data }) });
  app.mount(root);
  await nextTick();
  return { root, unmount: () => { app.unmount(); root.remove(); } };
}

const SUMMARY = { calls: 1, ok: 1, failed: 0, computeMs: 5, wallMs: 8, denied: [], serialized: [], trace: [] };

describe('run_code 卡 · return 纯 string 按普通文本渲染', () => {
  it('纯 string：pre 直显保留换行，无 JSON 引号包裹、无 json 代码块', async () => {
    const text = ['第一行结论', '第二行结论'].join('\n');
    const { root, unmount } = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34', value: text });
    // 普通文本分支：pre.rc-value-text 存在且内容原样（换行保留、无引号）
    const pre = root.querySelector('.rc-value-text');
    expect(pre).toBeTruthy();
    expect(pre?.textContent?.trim()).toBe(text);
    // 不走 markdown 渲染的 json 代码块
    expect(root.querySelector('.rc-value-body .md-code-block')).toBeNull();
    expect(root.querySelector('.rc-value-plain')).toBeTruthy();
    unmount();
  });

  it('对象：仍是 JSON 代码块（markdown 渲染）+ return 头', async () => {
    const { root, unmount } = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34', value: { ok: true, n: 1 } });
    expect(root.querySelector('.rc-value-text')).toBeNull();
    expect(root.querySelector('.rc-value-body .md-code-block')).toBeTruthy();
    expect(root.querySelector('.rc-head-label')?.textContent).toBe('return');
    unmount();
  });

  it('多行 string 超长护栏（cr-765 反馈 #3/#4：默认全量直出，仅 50KB 极端值折叠）', async () => {
    // 常规文本（< 50KB）：默认全量直出，无折叠按钮
    const text = Array.from({ length: 40 }, (_, i) => '行' + i + '：' + '内容文本段落'.repeat(5)).join('\n');
    const { root, unmount } = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34', value: text });
    expect(root.querySelector('.rc-value-text')!.textContent!.trim()).toBe(text); // 全量
    expect(root.querySelector('.rc-expand-btn')).toBeNull(); // 无折叠
    unmount();
    // 极端值（> 50KB）：折叠 + 展开还原
    const huge = Array.from({ length: 3000 }, (_, i) => '行' + i + '：' + '内容文本段落'.repeat(10)).join('\n');
    const m2 = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34', value: huge });
    const pre = m2.root.querySelector('.rc-value-text')!;
    expect(pre.textContent!.length).toBeLessThan(huge.length); // 护栏截断
    const btn = m2.root.querySelector('.rc-expand-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await nextTick();
    expect(m2.root.querySelector('.rc-value-text')!.textContent!.trim()).toBe(huge); // 展开还原
    m2.unmount();
  });
});

describe('run_code 卡 · 工具调用时间线退役（cr-764）', () => {
  const TRACE_SUMMARY = {
    ...SUMMARY,
    calls: 3, ok: 2, failed: 1, serialized: [2],
    denied: [{ name: 'pwsh', error: '权限拒绝：禁止执行' }],
    trace: [
      { seq: 1, name: 'read', ok: true, ms: 5, brief: 'a.ts' },
      { seq: 2, name: 'edit', ok: true, ms: 8, brief: 'a.ts' },
      { seq: 3, name: 'grep', ok: false, ms: 3, brief: 'x', error: '无命中' },
    ],
  };

  it('逐条时间线不渲染（rc-trace* 全消失）；调用徽章在程序体卡头（cr-765 #10 下沉），机器耗时在 return 段卡头', async () => {
    const { root, unmount } = await mountCard({ summary: TRACE_SUMMARY, programHash: 'ab12cd34' });
    expect(root.querySelector('.rc-trace')).toBeNull();
    expect(root.querySelector('.rc-trace-list')).toBeNull();
    expect(root.querySelector('.rc-trace-row')).toBeNull();
    // 程序体缺席分支：调用/串行徽章独立行（程序体在场时在卡头——rc-head-badges）
    const badges = root.querySelector('.rc-summary');
    expect(badges).toBeTruthy();
    const texts = Array.from(badges!.querySelectorAll('.ui-badge')).map((b) => b.textContent?.trim());
    expect(texts).toContain('调用 2/3');
    expect(texts).toContain('串行 1');
    unmount();
  });

  it('被拒徽章保留在程序体卡头——denied 子调用（before-execute 被 veto，无 subcall 卡）唯一前端可见面', async () => {
    const { root, unmount } = await mountCard({ summary: TRACE_SUMMARY, programHash: 'ab12cd34' });
    const denied = root.querySelector('.rc-summary .rc-badge-denied');
    expect(denied?.textContent?.trim()).toBe('被拒 1');
    unmount();
  });

  it('无 trace 子调用的纯计算程序：调用徽章照常（程序体缺席分支独立行；无空态占位文案）', async () => {
    const { root, unmount } = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34' });
    expect(root.querySelector('.rc-summary')).toBeTruthy();
    expect(root.querySelector('.rc-trace-empty')).toBeNull();
    unmount();
  });
});
