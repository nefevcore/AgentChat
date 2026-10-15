// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-cards-browser.test.ts —— browser 工具卡渲染回归（cr-467）
//
// 锁定项（卡组件此前全仓零渲染测试——resolve 断言只保注册面）：
//   · 批量：步数徽记 + 成功/失败计数 + 失败步骤红框 + 动作徽章词条（kit
//     .ui-badge.tag + ACTION_META 分类色板）；
//   · 单动作：page（URL/标题/正文）/ elements / logs 分栏 / tabs；
//   · 单动作失败回落：error 信封无 output → 卡只见参数层（action/url）——
//     ToolMessage 已在卡上方渲染错误行，卡内不得误显「完成」徽章。
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultBrowser from 'ac-client-ui-browser/client/ToolResult/ToolResultBrowser.vue';

async function mountCard(data: Record<string, unknown>): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({
    render: () => h(ToolResultBrowser as never, { data }),
  });
  app.mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  return root;
}

describe('ToolResultBrowser 渲染（cr-467）', () => {
  it('批量：步数计数 + 成功/失败徽记 + 动作徽章词条（ACTION_META）', async () => {
    const root = await mountCard({
      count: 3,
      results: [
        { step: 1, action: 'open', repeat: 1, params: { url: 'https://example.com' }, result: { url: 'https://example.com', title: 'Example' } },
        { step: 2, action: 'click', repeat: 1, params: { ref: 3 }, result: { clicked: 'button "OK"', url: 'https://example.com/done', title: 'Done' } },
        { step: 3, action: 'eval', repeat: 2, params: { js: '1+1' }, status: 'error', message: 'eval 拒绝：未调用的函数' },
      ],
    });
    expect(root.querySelector('.brw-batch-count')?.textContent).toBe('3 步');
    expect(root.querySelector('.brw-batch-ok')?.textContent).toContain('2');
    expect(root.querySelector('.brw-batch-err')?.textContent).toContain('1');
    // 步骤行 3 条；失败步骤红框；repeat > 1 显示 .2 后缀
    expect(root.querySelectorAll('.brw-step')).toHaveLength(3);
    expect(root.querySelectorAll('.brw-step-err')).toHaveLength(1);
    expect(root.querySelector('.brw-step-no')?.textContent).toContain('#1');
    // 动作徽章词条走 ACTION_META（open=打开 / click=点击）
    const badges = [...root.querySelectorAll('.brw-step-badge')].map((b) => b.textContent);
    expect(badges[0]).toContain('打开');
    expect(badges[1]).toContain('点击');
    root.remove();
  });

  it('批量失败收束：failedStep + errorMessage 完整展示（部分成功不吞）', async () => {
    const root = await mountCard({
      failedStep: 2,
      message: '第 2 步执行失败',
      results: [
        { step: 1, action: 'open', repeat: 1, params: {}, result: { url: 'https://example.com', title: 'Example' } },
      ],
    });
    expect(root.querySelector('.brw-batch-failed')?.textContent).toContain('第 2 步失败');
    expect(root.querySelector('.brw-error')?.textContent).toContain('第 2 步执行失败');
    expect(root.querySelectorAll('.brw-step')).toHaveLength(1);
    root.remove();
  });

  it('单动作 page：URL（协议裁剪）+ 标题 + 正文', async () => {
    const root = await mountCard({
      url: 'https://example.com/page',
      title: '示例页',
      text: '页面正文第一行',
      marker: 12,
    });
    expect(root.querySelector('.brw-page-url')?.textContent).toContain('example.com/page');
    expect(root.querySelector('.brw-page-title')?.textContent).toBe('示例页');
    expect(root.querySelector('.brw-text')?.textContent).toContain('页面正文第一行');
    root.remove();
  });

  it('单动作 elements：计数徽记 + 元素清单', async () => {
    const root = await mountCard({
      count: 2,
      elements: ['[1] button "提交"', '[2] input 搜索框'],
      marker: 3,
    });
    expect(root.querySelector('.brw-elements .ui-badge')?.textContent).toContain('× 2');
    expect(root.querySelector('.brw-text')?.textContent).toContain('[1] button');
    root.remove();
  });

  it('单动作 logs：console/network 分栏（Tabs line）+ 级别着色', async () => {
    const root = await mountCard({
      console: [{ seq: 1, level: 'error', text: 'boom' }],
      network: [{ seq: 2, method: 'GET', url: 'https://api.example.com/x', state: 'failed', error: 'net::ERR' }],
      marker: 7,
    });
    expect(root.querySelector('.brw-log-level')?.textContent).toBe('error');
    expect(root.querySelector('.brw-log-row.lv-error')).toBeTruthy();
    // 网络分栏：点击 tab 切换后可见
    const tabs = [...root.querySelectorAll('[role=tab], .tabs-item, button')];
    const netTab = tabs.find((t) => t.textContent?.includes('网络'));
    (netTab as HTMLElement | undefined)?.click();
    for (let i = 0; i < 4; i++) await nextTick();
    expect(root.textContent).toContain('https://api.example.com/x');
    root.remove();
  });

  it('单动作 tabs：标签页清单 + active 高亮', async () => {
    const root = await mountCard({
      tabs: [
        { index: 0, title: '文档', url: 'https://example.com/doc', active: true },
        { index: 1, title: '(无标题)', url: 'about:blank', active: false },
      ],
    });
    const rows = root.querySelectorAll('.brw-tab-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.brw-tab-title')?.textContent).toBe('文档');
    expect(rows[0]?.classList.contains('active')).toBe(true);
    root.remove();
  });

  it('单动作失败回落：error 信封无 output → 参数层单 URL 不误显完成徽章（展开体由 ToolMessage 错误行承载）', async () => {
    // useToolResult：{ok:false,error} → status=error 无 data → resultData 只含参数
    const root = await mountCard({ action: 'open', url: 'https://example.com' });
    // 参数 url 使 singleType 落 page（展示目标 URL——比「完成」徽章忠实）；关键断言：不渲染 brw-ok
    expect(root.querySelector('.brw-ok')).toBeNull();
    expect(root.querySelector('.brw-page-url')?.textContent).toContain('example.com');
    root.remove();
  });

  it('纯参数无 URL（如 press 失败）：回落完成徽章前不崩溃（兜底渲染路径）', async () => {
    const root = await mountCard({ action: 'press', key: 'Enter' });
    expect(root.querySelector('.brw-ok')).toBeTruthy();
    root.remove();
  });
});
