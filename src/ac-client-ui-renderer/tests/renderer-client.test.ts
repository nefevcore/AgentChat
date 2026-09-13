// @vitest-environment jsdom
// ============================================================
// ac-client-ui-renderer/tests/renderer-client.test.ts —— client 半边验收
//（M27.2-2：ctx.vueRenderer 服务面 + markdown 管线资产〔useMarkdown
// 模块求值期读 document 主题态——需 jsdom〕）
// ============================================================
import { describe, it, expect } from 'vitest';

describe('M27.2 · ac-client-ui-renderer client 半边（服务面 + markdown 管线资产）', () => {
  it('插件装载 → ctx.vueRenderer 服务（boot-once install + renderSlot 面）', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    const { rendererClientPlugin } = await import('../client/index.ts');
    const fiber = await ctx.plugin(rendererClientPlugin);
    expect(ctx.vueRenderer).toBeDefined();
    const vnode = ctx.vueRenderer.renderSlot('root');
    expect(vnode).toBeDefined(); // root 空态也产出 vnode（DEV 诊断/空 Outlet）
    await fiber.dispose();
    expect((ctx as { vueRenderer?: unknown }).vueRenderer).toBeUndefined();
  });

  it('markdown 管线资产在场：useMarkdown 渲染基本 markdown', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const html = render('**加粗**');
    expect(String(html)).toContain('<');
  });

  it('文件路径识别：正斜杠/反斜杠/盘符/混形皆可点（linkifyFilePaths）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // 正斜杠（原有能力）
    const fwd = render('改了 src/ac-client-ui-workspace/client/fileApi.ts 文件');
    expect(fwd).toContain('data-file-path="src/ac-client-ui-workspace/client/fileApi.ts"');
    // Windows 反斜杠（本次修复的形态）
    const back = render('改了 src\\ac-client-ui-workspace\\client\\fileApi.ts 文件');
    expect(back).toContain('data-file-path="src\\ac-client-ui-workspace\\client\\fileApi.ts"');
    // 盘符绝对形
    const drive = render('输出在 C:\\Users\\x\\docs\\report.md');
    expect(drive).toContain('data-file-path="C:\\Users\\x\\docs\\report.md"');
    // 混合分隔符（LLM 常见混形）
    const mixed = render('见 mixed\\sep/path.ts');
    expect(mixed).toContain('data-file-path="mixed\\sep/path.ts"');
    // 反例：纯文件名 / 非已知扩展名不误报
    const noSep = render('file.ts 与 hello.world 不识别');
    expect(noSep).not.toContain('file-path-link');
  });

  it('行内代码整段为路径 → code 升级为文件链接（不再灰底 code + 链接双渲染）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // 系统提示要求 LLM 以行内代码引用产出路径——升级后只剩一种效果
    const html = render('已修改 `src/app.ts`');
    expect(html).toContain('<code class="file-path-link"');
    expect(html).toContain('data-file-path="src/app.ts"');
    // 升级后内部不得再嵌套第二层链接芯片（双渲染回归）
    expect(html).not.toContain('<span class="file-path-link"');
    // code 内混杂其他文字 → 保持字面语义不升级（部分路径不从 code 检出）
    const literal = render('`见 src/a.ts 文件` 保持原样');
    expect(literal).not.toContain('file-path-link');
    expect(literal).toContain('<code>');
  });

  // 注记：M30 D3 的 useSeatOccupancy 门控原语随主区/aux 选举化失去全部
  // 生产消费方（占用门控内在于选举），同批除役——git 史可溯。

  // ---- YAML frontmatter（文档首部 --- 元数据块）----
  it('frontmatter：文档首部 --- 围合块 → 键值网格（不再 hr + setext h2）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const html = render(`---
name: agentchat-plugin-dev
description: 开发插件——注入 <服务> 与 "引号"
whenToUse: 任务涉及修改 src/ 下的插件行
---

正文段落`);
    expect(html).toContain('md-frontmatter');
    expect(html).toContain('md-frontmatter-key');
    expect(html).toContain('agentchat-plugin-dev');
    // 值内特殊字符转义（frontmatter 内容不可信）
    expect(html).toContain('&lt;服务&gt;');
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<hr');
    // 闭合之后的正文正常渲染
    expect(html).toContain('正文段落');
  });

  it('frontmatter：中段 --- 分隔线 / setext 标题 / 未闭合 / 无键值行 → 默认行为不受影响', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // 中段分隔线
    const hr = render('上文\n\n---\n\n下文');
    expect(hr).toContain('<hr');
    expect(hr).not.toContain('md-frontmatter');
    // setext 二级标题（段落行 + --- 下划线）
    const setext = render('标题行\n---\n\n正文');
    expect(setext).toContain('<h2>标题行</h2>');
    expect(setext).not.toContain('md-frontmatter');
    // 未闭合（流式中间态）→ 回落默认渲染
    const unclosed = render('---\nname: x');
    expect(unclosed).not.toContain('md-frontmatter');
    // 无任何键值行 → 不按 frontmatter 处理
    const noEntries = render('---\njust some text\n---');
    expect(noEntries).not.toContain('md-frontmatter');
  });

  it('frontmatter：parseFrontmatterEntries 浅解析（引号剥除/注释跳过/裸标量不误判）', async () => {
    const { parseFrontmatterEntries } = await import('../client/useMarkdown.ts');
    const entries = parseFrontmatterEntries(`# 注释行
name: value
title: "带引号标题"
empty:
http://example.com
  - 列表项`);
    expect(entries).toEqual([
      { key: 'name', value: 'value' },
      { key: 'title', value: '带引号标题' },
      { key: 'empty', value: '' },
    ]);
  });
});
