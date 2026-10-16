// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-cards-run-code.test.ts —— run_code 程序卡渲染验收
//
// 组件此前全仓零渲染测试（cr-464 终端卡先例的补测批次）：四段式布局、
// 时间线折叠/串行/被拒徽章、frozenMs 徽章 title、纯 string / JSON 返回值
// 分形、错误态。席位注册面由 clients-tool-cards.test.ts 锁定，此处不重复。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultRunCode from 'ac-client-ui-run-code/client/ToolResult/ToolResultRunCode.vue';

interface Mount { root: HTMLElement; unmount: () => void }

async function mountCard(data: Record<string, unknown>, loading = false): Promise<Mount> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(ToolResultRunCode, { data, loading }) });
  app.mount(root);
  await nextTick();
  return { root, unmount: () => { app.unmount(); root.remove(); } };
}

/** 基准 summary（protocol.ts RunSummary 形状的最小实例） */
const BASE_SUMMARY = { calls: 2, ok: 2, failed: 0, computeMs: 30, wallMs: 60, denied: [], serialized: [], trace: [
  { seq: 1, name: 'read', ok: true, ms: 20, brief: '读取 src/README.md' },
  { seq: 2, name: 'grep', ok: true, ms: 10, brief: '搜索 foo' },
] };

describe('run_code 程序卡渲染 · 四段式与时间线', () => {
  it('程序体 + 时间线 + 返回值：三段齐现，行数徽记可见', async () => {
    const code = ['const r = 1 + 2;', 'return r;'].join('\n');
    const { root, unmount } = await mountCard({ code, summary: BASE_SUMMARY, programHash: 'ab12cd34', value: 3 });
    expect(root.querySelector('.rc-code')).toBeTruthy();
    expect(root.querySelector('.rc-head-label')?.textContent).toBe('program.ts');
    expect(root.querySelector('.rc-meta-dim')?.textContent).toContain('2 行');
    expect(root.querySelectorAll('.rc-trace-row').length).toBe(2);
    expect(root.querySelector('.rc-trace-name')?.textContent).toBe('read');
    expect(root.querySelector('.rc-value-body .md-code-block')).toBeTruthy(); // JSON 代码块
    unmount();
  });

  it('时间线折叠：超 8 条默认截断，展开按钮还原全部', async () => {
    const trace = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, name: 'hello', ok: true, ms: 5, brief: 'b' + i }));
    const summary = { ...BASE_SUMMARY, calls: 10, ok: 10, trace };
    const { root, unmount } = await mountCard({ code: 'return 1;', summary });
    expect(root.querySelectorAll('.rc-trace-row').length).toBe(8); // 折叠上限
    const btn = root.querySelector('.rc-trace-toggle') as HTMLButtonElement;
    expect(btn?.textContent).toContain('展开全部 10 条调用');
    btn.click();
    await nextTick();
    expect(root.querySelectorAll('.rc-trace-row').length).toBe(10);
    unmount();
  });

  it('失败行红点 + 串行标记 + 被拒徽章 + 截断计数', async () => {
    const summary = {
      calls: 4, ok: 2, failed: 1, computeMs: 40, wallMs: 80,
      denied: [{ name: 'pwsh', error: 'shell 能力未授权' }],
      serialized: [2],
      trace: [
        { seq: 1, name: 'read', ok: true, ms: 10, brief: 'ok' },
        { seq: 2, name: 'edit', ok: true, ms: 30, brief: '写路径' },
        { seq: 3, name: 'grep', ok: false, ms: 0, brief: '炸了', error: 'pattern 无效' },
      ],
      traceTruncated: 12,
    };
    const { root, unmount } = await mountCard({ code: 'return 1;', summary });
    expect(root.querySelector('.rc-trace-row.rc-trace-fail')).toBeTruthy(); // 失败行
    expect(root.querySelectorAll('.rc-dot-fail').length).toBe(1);
    const serial = root.querySelector('.rc-trace-serial');
    expect(serial?.textContent).toBe('串行');
    const denied = root.querySelector('.rc-badge-denied');
    expect(denied?.textContent).toContain('被拒 1');
    expect(root.querySelector('.rc-trace-more')?.textContent).toContain('12 条');
    unmount();
  });

  it('frozenMs：计算徽章 title 说明应答等待不计机器预算', async () => {
    const summary = { ...BASE_SUMMARY, frozenMs: 1500 };
    const { root, unmount } = await mountCard({ code: 'return 1;', summary });
    const badge = [...root.querySelectorAll('.ui-badge')].find((b) => b.textContent?.includes('计算'));
    expect(badge?.getAttribute('title')).toContain('应答等待 1500ms');
    unmount();
  });

  it('执行中：无 summary 时忙指示文案区分「生成中/执行中」', async () => {
    const withCode = await mountCard({ code: 'return 1;' }, true);
    expect(withCode.root.querySelector('.rc-running')?.textContent).toContain('程序执行中');
    withCode.unmount();
    const noCode = await mountCard({}, true);
    expect(noCode.root.querySelector('.rc-running')?.textContent).toContain('程序体生成中');
    noCode.unmount();
  });

  it('错误态：错误段渲染 + 无返回值段', async () => {
    const { root, unmount } = await mountCard({ code: 'return 1;', summary: BASE_SUMMARY, error: '程序执行失败：x 未定义' });
    expect(root.querySelector('.rc-error-title')?.textContent).toContain('程序失败');
    expect(root.querySelector('.rc-error-text')?.textContent).toContain('x 未定义');
    expect(root.querySelector('.rc-value')).toBeNull();
    unmount();
  });
});
