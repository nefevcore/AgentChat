// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-cards-fs.test.ts —— fs 工具卡渲染回归（cr-465）
//
// 锁定项（fs 双卡此前全仓零渲染测试——resolve 断言只保注册面）：
//   · Code 卡：文件模式（文件名/语言徽记/元信息/截断横幅）与目录模式
//     （清单条目/目录文件计数徽章）分叉渲染；
//   · Edit 卡：diff 标记行分色（+绿底/-红底，语义由行底 tint 承载——
//     cr-147 方案 B）、无变更文案、调用中 loading 态；
//   · write 不占卡：行 client 出厂仅 read/edit 双 def（cr-465）。
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultCode from 'ac-client-ui-fs/client/ToolResult/ToolResultCode.vue';
import ToolResultEdit from 'ac-client-ui-fs/client/ToolResult/ToolResultEdit.vue';
import { fsCardClientPlugin } from 'ac-client-ui-fs/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { resolveToolResultView } from '../src/core/registry/toolResultViews';

async function mountCard(comp: unknown, data: Record<string, unknown>, loading = false): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({
    render: () => h(comp as never, { data, loading }),
  });
  app.mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  return root;
}

describe('ToolResultCode 渲染（cr-465）', () => {
  it('文件模式：文件名 + 语言徽记 + 元信息（行数/范围/大小）', async () => {
    const root = await mountCard(ToolResultCode, {
      path: 'src/ac-fs-tools/src/index.ts',
      content: 'const a = 1;\\nconst b = 2;',
      total_lines: 2,
      size: 12345,
    });
    expect(root.querySelector('.code-file-name')?.textContent).toBe('index.ts');
    expect(root.querySelector('.code-lang-badge')?.textContent).toBe('TypeScript');
    const badges = [...root.querySelectorAll('.code-meta-badge')].map(e => e.textContent);
    expect(badges.some(t => t?.includes('12.1 KB'))).toBe(true);
    expect(badges.some(t => t?.includes('2 行'))).toBe(true);
    expect(root.querySelector('.dir-list')).toBeNull(); // 文件模式不渲染目录清单
  });

  it('目录模式：清单条目 + 计数徽章（N 项 / n 目录 / m 文件）', async () => {
    const root = await mountCard(ToolResultCode, {
      path: 'src/ac-fs-tools',
      type: 'directory',
      count: 3,
      items: [
        { name: 'src', type: 'directory' },
        { name: 'tests', type: 'directory' },
        { name: 'package.json', type: 'file' },
      ],
    });
    const items = [...root.querySelectorAll('.item-name')].map(e => e.textContent);
    expect(items).toContain('src/');
    expect(items).toContain('package.json');
    const badges = [...root.querySelectorAll('.code-meta-badge')].map(e => e.textContent);
    expect(badges.some(t => t?.includes('3 项'))).toBe(true);
    expect(badges.some(t => t?.includes('2 目录'))).toBe(true);
    expect(badges.some(t => t?.includes('1 文件'))).toBe(true);
    expect(root.querySelector('.code-area')).toBeNull(); // 目录模式不渲染代码区
  });

  it('截断横幅：truncated → 前 N（原始 M）可见', async () => {
    const root = await mountCard(ToolResultCode, {
      path: 'big.log',
      content: 'x'.repeat(50),
      truncated: true,
      total_bytes: 999999,
    });
    const banner = root.querySelector('.code-truncated-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('976.6 KB');
    expect(banner!.textContent).toContain('50 B');
  });

  it('调用中 loading：内容未返回 → 正在读取 + 无代码区', async () => {
    const root = await mountCard(ToolResultCode, { path: 'a.ts' }, true);
    expect(root.querySelector('.code-loading-text')?.textContent).toContain('正在读取');
    expect(root.querySelector('.code-area')).toBeNull();
  });
});

describe('ToolResultEdit 渲染（cr-465）', () => {
  it('diff 分色：+ 行绿底 tint、- 行红底 tint（语义由行底承载，cr-147 方案 B）', async () => {
    const root = await mountCard(ToolResultEdit, {
      path: 'src/a.ts',
      edits_applied: 1,
      fuzzy_matches: 0,
      first_changed_line: 3,
      diff: [
        '  2 const b = 2;',
        '- 3 const old = 3;',
        '+ 3 const fresh = 4;',
        '...',
        '  9 // tail',
      ].join('\\n'),
    });
    expect(root.querySelector('.edit-file-name')?.textContent).toBe('a.ts');
    const del = root.querySelector('.diff-del .diff-content');
    const add = root.querySelector('.diff-add .diff-content');
    expect(del?.textContent).toContain('const old = 3;');
    expect(add?.textContent).toContain('const fresh = 4;');
    expect(root.querySelector('.edit-stat')?.textContent).toContain('1 处替换');
    const badges = [...root.querySelectorAll('.edit-stat')].map(e => e.textContent);
    expect(badges.some(t => t === 'L3')).toBe(true);
  });

  it('无变更：diff=（无变更）无标记 → 纯文本形态显示原文（edit-no-diff 仅空 diff）', async () => {
    const root = await mountCard(ToolResultEdit, { path: 'a.ts', diff: '（无变更）' });
    expect(root.querySelector('.edit-plain-text')?.textContent).toContain('（无变更）');
    expect(root.querySelector('.diff-del')).toBeNull();
    expect(root.querySelector('.edit-no-diff')).toBeNull();
  });

  it('调用中 loading：diff 未返回 → 正在应用编辑', async () => {
    const root = await mountCard(ToolResultEdit, { path: 'a.ts', file_path: 'a.ts' }, true);
    expect(root.querySelector('.edit-loading-text')?.textContent).toContain('正在应用编辑');
  });
});

describe('fs 行出厂 def（cr-465：write 不占卡）', () => {
  it('行装载 → read/edit 双 def；write 恒 null（Label 直达预览，不占卡面）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(fsCardClientPlugin);
    expect(resolveToolResultView('read')).toBeTruthy();
    expect(resolveToolResultView('edit')).toBeTruthy();
    expect(resolveToolResultView('write')).toBeNull();
    await fiber.dispose();
    expect(resolveToolResultView('read')).toBeNull();
  });
});
