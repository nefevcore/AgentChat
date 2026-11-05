// @vitest-environment jsdom
// ============================================================
// ac-client-ui-fs/tests/edit-diff-lines.test.ts —— edit 卡 diff 分行
// 渲染验收（cr-896 行为锁）：diff 文本按换行符拆行逐行染色
// （- → del / + → add / 缩进 → ctx / ... → sep）。
// 锁因：cr-465 CRLF→LF 清理曾把 split('\n') 误双重转义成
// split('\\n')（字面反斜杠 n）——diff 恒单行、整卡一坨红，
// 存量测试未锁分行行为故漏网。此测试即防再犯。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultEdit from '../client/ToolResult/ToolResultEdit.vue';

interface Mount { root: HTMLElement; unmount: () => void }

async function mountCard(data: Record<string, unknown>): Promise<Mount> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(ToolResultEdit, { data }) });
  app.mount(root);
  await nextTick();
  return { root, unmount: () => { app.unmount(); root.remove(); } };
}

const DIFF = ['- 1 旧行', '+ 1 新行', '  2 上下文', '...', '+ 4 新增块'].join('\n');

describe('edit 卡 · diff 逐行拆分染色（cr-896 行为锁）', () => {
  it('按换行符拆行：每行独立 .diff-line，类名按前缀分派', async () => {
    const { root, unmount } = await mountCard({ path: 'a.ts', diff: DIFF });
    const lines = Array.from(root.querySelectorAll('.diff-line'));
    expect(lines.length).toBe(5); // 单元素数组 = split 字面 \\n 回归即红
    expect(lines.map((l) => l.className)).toEqual(['diff-line diff-del', 'diff-line diff-add', 'diff-line diff-ctx', 'diff-line diff-sep', 'diff-line diff-add']);
    expect(lines[0].textContent?.trim()).toBe('- 1 旧行'); // 行内容不串行
    unmount();
  });

  it('del 行只含自身文本（整卡一坨红的回归形态不再出现）', async () => {
    const { root, unmount } = await mountCard({ path: 'a.ts', diff: DIFF });
    const del = root.querySelector('.diff-del .diff-content');
    expect(del?.textContent).toBe('- 1 旧行');
    expect(root.querySelectorAll('.diff-del').length).toBe(1);
    unmount();
  });

  it('无 diff 标记（纯文本）：回落纯文本 pre 展示，无行染色', async () => {
    const { root, unmount } = await mountCard({ path: 'a.ts', diff: 'just plain text' });
    expect(root.querySelectorAll('.diff-line').length).toBe(0);
    expect(root.querySelector('.edit-plain-text')).toBeTruthy();
    unmount();
  });
});

describe('edit 卡 · 折行开关经 CodeCard slot prop 生效（cr-897 行为锁）', () => {
  it('wrap 类随 CodeCard #17C 开关切换：default slot 下发 → diff 体跟随', async () => {
    // localStorage 缺省 = wrap 开（readGlobalWrap 缺省 true）——jsdom 无存储记忆
    localStorage.removeItem('agentchat.codeWrap');
    const m = await mountCard({ path: 'a.ts', diff: DIFF });
    // 缺省折行：wrap 类在场（与卡头按钮「不换行」态同源）
    expect(m.root.querySelector('.edit-diff-body')!.classList.contains('wrap')).toBe(true);
    m.unmount();
    // 显式 wrap:false 单卡覆盖：nowrap——横滚阅读（经 attrs fallthrough 传 CodeCard）
    const root2 = document.createElement('div');
    document.body.appendChild(root2);
    const app2 = createApp({ render: () => h(ToolResultEdit, { data: { path: 'a.ts', diff: DIFF }, wrap: false }) });
    app2.mount(root2);
    await nextTick();
    expect(root2.querySelector('.edit-diff-body')!.classList.contains('wrap')).toBe(false);
    app2.unmount();
    root2.remove();
  });
});
