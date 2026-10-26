// @vitest-environment jsdom
// ============================================================
// ac-client-ui-run-code/tests/run-code-plain-string-value.test.ts
// —— 返回值分形渲染验收：run_code return 纯 string 时按普通文本
// 直显（保留换行、无引号包裹），对象/数组仍走 JSON 代码块。
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

  it('多行 string 超长折叠：截断 + 展开按钮还原全文', async () => {
    const text = Array.from({ length: 40 }, (_, i) => '行' + i + '：' + '内容文本段落'.repeat(5)).join('\n');
    const { root, unmount } = await mountCard({ summary: SUMMARY, programHash: 'ab12cd34', value: text });
    const pre = root.querySelector('.rc-value-text')!;
    expect(pre.textContent!.length).toBeLessThan(text.length); // 折叠截断
    const btn = root.querySelector('.rc-expand-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await nextTick();
    expect(root.querySelector('.rc-value-text')!.textContent!.trim()).toBe(text); // 展开还原
    unmount();
  });
});
