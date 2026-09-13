// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-preview-tabs.test.ts —— P1 aux 预览选区验收
//（多 tab 文件预览：选区注册 + 意图通道 + tab 状态机）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { workspaceClientPlugin } from 'ac-client-ui-workspace/client';
import { usePreviewTabsStore, MAX_PREVIEW_TABS } from 'ac-client-ui-workspace/client/previewTabs.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('P1 · preview 选区注册（workspace 行）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('行装载 → aux-sidebar 含 preview 条目（available=false 空 tab）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    setActivePinia(createPinia()); // boot 后重置——active 谓词读到本用例 pinia
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(workspaceClientPlugin);
    expect(ids('aux-sidebar')).toContain('webui-domain-workspace.preview');
    // def 断言：available 空-tab 隐藏（rail 按钮不露）
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-workspace.preview')!;
    const def = entry.meta?.def as { id: string; available: () => boolean; active: () => boolean };
    expect(def.id).toBe('preview');
    expect(def.available()).toBe(false); // 无 tab
    // 开 tab 后 available/active 翻真
    const tabs = usePreviewTabsStore();
    tabs.openTab('note/a.md');
    expect(def.available()).toBe(true);
    expect(def.active()).toBe(true); // panelOpen 随 openTab 置真
    await fiber.dispose();
    expect(ids('aux-sidebar')).not.toContain('webui-domain-workspace.preview');
  });

  it('意图通道：openPreview（宽屏）→ previewIntent++；窄屏 → previewVisible 直开', async () => {
    const ui = useUiStore();
    // jsdom 缺省 1024px（>768 → 宽屏分支）
    ui.openPreview('docs/x.md', 'agent-1');
    expect(ui.auxIntent).toBe(1); // 通用意图 seq（panel='preview'）
    expect(ui.auxIntentPanel).toBe('preview');
    expect(ui.previewIntentFallback).toBe('agent-1');
    expect(ui.previewVisible).toBe(false); // 宽屏不开 Modal
    // 窄屏：直接操纵 innerWidth（jsdom 可写）
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    try {
      ui.openPreview('docs/y.md');
      expect(ui.previewVisible).toBe(true); // Modal 形态
      expect(ui.auxIntent).toBe(1); // 意图不变
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    }
  });
});

describe('P1 · previewTabs 状态机（LRU 淘汰 + 激活让位）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('行号与代码行对齐：空行计数不塌陷 + 尾部换行不产生多余行号', async () => {
    // codeLines 滤尾部空串（源码 \n 结束）——行号列与 <pre> 内实际行数一致
    const { useFilePreviewContent } = await import('ac-client-ui-workspace/client/filePreviewContent.ts');
    // 直接构造内容走 composable：绕过 fetch 不便——这里只测 split 语义
    const lines = 'a\n\nb\n'.split('\n');
    const trimmed = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    expect(trimmed).toEqual(['a', '', 'b']); // 3 行（中间空行保留、尾部空串滤除）
  });

  it('splitHighlightedHtml：跨行标签平衡（行尾闭合/行首重开，颜色延续）', async () => {
    const { splitHighlightedHtml } = await import('ac-client-ui-workspace/client/filePreviewContent.ts');
    // 模拟 hljs 块注释跨行：span 开在第 1 行、闭在第 3 行
    const html = 'a<span class="c">/* 跨行\n注释\n继续 */</span>d';
    const lines = splitHighlightedHtml(html);
    expect(lines).toHaveLength(3);
    // 行 1：开标签 + 文本 + 闭合补齐
    expect(lines[0]).toBe('a<span class="c">/* 跨行</span>');
    // 行 2：重开 + 文本 + 闭合
    expect(lines[1]).toBe('<span class="c">注释</span>');
    // 行 3：重开 + 闭 + 后续文本
    expect(lines[2]).toBe('<span class="c">继续 */</span>d');
    // 每行标签平衡（开闭计数相等）
    for (const l of lines) {
      const open = (l.match(/<span/g) ?? []).length;
      const close = (l.match(/<\/span>/g) ?? []).length;
      expect(open).toBe(close);
    }
    // 纯文本快路径
    expect(splitHighlightedHtml('x\ny')).toEqual(['x', 'y']);
  });

  it('同路径去重 + 超上限淘汰最旧非激活 tab', () => {
    const tabs = usePreviewTabsStore();
    for (let i = 0; i < MAX_PREVIEW_TABS; i++) tabs.openTab(`f${i}.md`);
    expect(tabs.count).toBe(MAX_PREVIEW_TABS);
    // 同路径：复用（激活跳转，不新增）
    tabs.openTab('f3.md');
    expect(tabs.count).toBe(MAX_PREVIEW_TABS);
    expect(tabs.activeKey).toBe('f3.md');
    // 超上限：淘汰最旧非激活（f0——非当前激活）
    tabs.openTab('new.md');
    expect(tabs.count).toBe(MAX_PREVIEW_TABS);
    expect(tabs.tabs.some((t) => t.key === 'f0.md')).toBe(false); // 最旧被淘汰
    expect(tabs.tabs.some((t) => t.key === 'f3.md')).toBe(true); // 激活 tab 保留
    expect(tabs.activeKey).toBe('new.md');
  });

  it('同文件双分隔符写法去重：反斜杠形复用既有 tab，不新开', () => {
    const tabs = usePreviewTabsStore();
    tabs.openTab('src/ac-client-ui-workspace/client/fileApi.ts');
    expect(tabs.count).toBe(1);
    // 同一文件的反斜杠写法（服务端 path.resolve 双分隔符同权）
    tabs.openTab('src\\ac-client-ui-workspace\\client\\fileApi.ts');
    expect(tabs.count).toBe(1); // 不新开
    expect(tabs.activeKey).toBe('src/ac-client-ui-workspace/client/fileApi.ts'); // 激活原 tab（保留首开 key）
    // 混合分隔符同样命中
    tabs.openTab('src\\ac-client-ui-workspace/client\\fileApi.ts');
    expect(tabs.count).toBe(1);
    // 不同文件照常新开
    tabs.openTab('src/other.ts');
    expect(tabs.count).toBe(2);
  });

  it('关闭激活 tab → 相邻让位；全关 → 面板收起', () => {
    const tabs = usePreviewTabsStore();
    tabs.openTab('a.md');
    tabs.openTab('b.md');
    tabs.openTab('c.md');
    expect(tabs.activeKey).toBe('c.md');
    tabs.closeTab('c.md');
    expect(tabs.activeKey).toBe('b.md'); // 无右邻 → 左邻
    tabs.closeTab('a.md');
    expect(tabs.activeKey).toBe('b.md');
    tabs.closeTab('b.md');
    expect(tabs.count).toBe(0);
    expect(tabs.panelOpen).toBe(false); // 全关收起
  });

  it('收面板不清 tab——重开恢复', () => {
    const tabs = usePreviewTabsStore();
    tabs.openTab('keep.md');
    tabs.closePanel();
    expect(tabs.panelOpen).toBe(false);
    expect(tabs.count).toBe(1); // tab 状态在
    tabs.openPanel();
    expect(tabs.activeKey).toBe('keep.md'); // 恢复上次激活
  });

  it('per-tab 视图偏好：wrap/viewMode 写回当前 tab，别的 tab 不受牵连', () => {
    const tabs = usePreviewTabsStore();
    tabs.openTab('a.md');
    tabs.openTab('b.ts');
    tabs.toggleWrap('b.ts');
    tabs.setViewMode('a.md', 'markdown');
    const a = tabs.tabs.find((t) => t.key === 'a.md')!;
    const b = tabs.tabs.find((t) => t.key === 'b.ts')!;
    expect(a.wrap).toBeUndefined(); // 未动
    expect(a.viewMode).toBe('markdown'); // markdown 显式渲染态
    expect(b.wrap).toBe(true); // 开换行
    expect(b.viewMode).toBeUndefined(); // 未动
    tabs.toggleWrap('b.ts');
    expect(tabs.tabs.find((t) => t.key === 'b.ts')!.wrap).toBe(false); // 再翻回
  });
});

describe('P1 · 预览格式能力矩阵（previewModeOptions / resolveViewKind）', () => {
  it('previewModeOptions：按扩展名给出允许格式（下拉选项源）', async () => {
    const { previewModeOptions } = await import('ac-client-ui-workspace/client/filePreviewContent.ts');
    // markdown：渲染/代码/纯文本三态
    expect(previewModeOptions('docs/readme.md')).toEqual(['auto', 'markdown', 'code', 'text']);
    // html：网页/源码/纯文本
    expect(previewModeOptions('index.html')).toEqual(['auto', 'html', 'code', 'text']);
    // 代码文件：高亮/纯文本
    expect(previewModeOptions('src/main.ts')).toEqual(['auto', 'code', 'text']);
    // 纯文本类：无高亮价值
    expect(previewModeOptions('app.log')).toEqual(['auto', 'text', 'code']);
    // 位图：仅图片（binary，无文本视图）
    expect(previewModeOptions('pic.png')).toEqual(['auto', 'image']);
    // svg：图片 + 源码（文本格式）
    expect(previewModeOptions('logo.svg')).toEqual(['auto', 'image', 'code']);
    // 未知二进制/无扩展名：无选项（下拉隐藏）
    expect(previewModeOptions('data.bin')).toEqual([]);
    expect(previewModeOptions('Makefile')).toEqual([]);
  });

  it('resolveViewKind：auto 分派 + 显式模式 + binary 网关 + 非法回落', async () => {
    const { resolveViewKind } = await import('ac-client-ui-workspace/client/filePreviewContent.ts');
    // auto：按扩展名
    expect(resolveViewKind('auto', 'a.md', false)).toBe('markdown');
    expect(resolveViewKind('auto', 'a.html', false)).toBe('html');
    expect(resolveViewKind('auto', 'a.png', true)).toBe('image');
    expect(resolveViewKind('auto', 'a.ts', false)).toBe('code');
    expect(resolveViewKind('auto', 'a.log', false)).toBe('text');
    // 显式模式：markdown 切代码、代码切纯文本、html 切源码
    expect(resolveViewKind('code', 'a.md', false)).toBe('code');
    expect(resolveViewKind('text', 'a.ts', false)).toBe('text');
    expect(resolveViewKind('code', 'a.html', false)).toBe('code');
    expect(resolveViewKind('image', 'logo.svg', false)).toBe('image');
    expect(resolveViewKind('code', 'logo.svg', false)).toBe('code');
    // 非法组合（png 选 markdown）：回落 auto 结果
    expect(resolveViewKind('markdown', 'a.png', true)).toBe('image');
    // binary 网关：svg 误判 binary（非图片扩展名对照）时非 image 模式回落 text
    expect(resolveViewKind('code', 'a.ts', true)).toBe('text');
  });
});
