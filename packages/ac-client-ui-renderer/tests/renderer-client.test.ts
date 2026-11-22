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

  it('代码块复制按钮：渲染方 document 级委托——点击即复制 pre code 文本', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // 裸容器（无任何组件级监听）= 文件预览/工具卡等 v-html 消费面的形态：
    // 按钮可用性完全依赖渲染管线的 document 级委托
    const container = document.createElement('div');
    container.innerHTML = render('```ts\nconst a = 1;\n```');
    document.body.appendChild(container);
    // jsdom 无 navigator.clipboard——stub 后验证委托链路（writeText + 按钮态翻转）
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    try {
      const btn = container.querySelector('.md-code-block-btn') as HTMLElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(written).toEqual(['const a = 1;\n']);
      expect(btn.classList.contains('copied')).toBe(true);
      expect(btn.querySelector('.md-code-block-btn-text')?.textContent).toBe('已复制');
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
      document.body.removeChild(container);
    }
  });

  it('文件路径识别：正斜杠/反斜杠/盘符/混形皆可点（linkifyFilePaths）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // 正斜杠（原有能力）
    const fwd = render('改了 packages/ac-client-ui-workspace/client/fileApi.ts 文件');
    expect(fwd).toContain('data-file-path="packages/ac-client-ui-workspace/client/fileApi.ts"');
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
    expect(html).toContain('<table class="md-frontmatter">');
    expect(html).toContain('<td class="md-frontmatter-key">');
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

  // ---- 表格贪婪列分类（cr-1183：渲染器列级 md-col-clamp 标记）----
  it('table：含超长 token 的列被标记 md-col-clamp，短列不受影响', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const html = render(`| 字段 | 链接 | 备注 |
| --- | --- | --- |
| 文档 | https://example.com/a/very/long/path/with/many/segments?q=1 | 说明文字 |
| 接口 | https://api.internal.example.com/v2/endpoint?with=full,payload | - |`);
    // wrapper 包裹不变
    expect(html).toContain('<div class="md-table-wrapper"><table>');
    // 第 2 列（链接）含超长 URL → clamp；表头与数据行同列同标记
    expect(html).toContain('<th class="md-col-clamp">链接</th>');
    expect(html).toContain('<td class="md-col-clamp">');
    // 第 1/3 列短内容 → 不标记
    expect(html).toContain('<th>字段</th>');
    expect(html).toContain('<th>备注</th>');
  });

  it('table：全短列表格零 clamp；同一渲染器实例连续渲染多表不串扰', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const short = render(`| 键 | 值 |
| --- | --- |
| 端口 | 8080 |`);
    expect(short).not.toContain('md-col-clamp');
    // 跨渲染复用同一 md 实例：先渲染带 clamp 列的表，再渲染全短表，
    // clampCols 闭包态必须被 table_open 重置（不得残留上一表的标记）
    const greedy = render(`| a | b |
| --- | --- |
| x | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |`);
    expect(greedy).toContain('md-col-clamp');
    const shortAgain = render(`| 键 | 值 |
| --- | --- |
| 端口 | 8080 |`);
    expect(shortAgain).not.toContain('md-col-clamp');
    // 列号对齐：clamp 只落在第 2 列，第 1 列不受影响
    expect(greedy).toContain('<th>a</th>');
  });

  // ---- cr-1210：CJK 可断 + 列级浓度阈值（中文散文列不再误封顶）----
  it('table：中文散文夹代码标识符 → 长串被 CJK 稀释，浓度 <60% 不 clamp', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // cr-1210 实测误判场景复刻：改动列是中文长散文，夹 reservedPluginNameError() 等
    // 标识符——旧判定（任一长 token）整列封顶致表格 356px 缩在 547px 气泡里
    const html = render(['| 文件 | 改动 |',
      '| --- | --- |',
      '| manifest.ts | 拒绝文案抽 reservedPluginNameError() 单源导出（validate 臂改调用，字面不变） |',
      '| pkg.ts | 核心改 readPluginPackage 读臂补 isReservedPluginName 后抛出——admissionOf 门禁收口 |',
      '| 测试 ×4 | 官方名 fixture 全数改第三方名（ac-plugin-todo→dev-plugin-todo 等） |'].join('\n'));
    expect(html).not.toContain('md-col-clamp');
  });

  it('table：纯长 token 列浓度 ≥60% 仍 clamp（判定收紧不回归贪婪列）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const html = render(['| 项 | 值 |',
      '| --- | --- |',
      '| 文档 | https://example.com/a/very/long/path/with/many/segments?q=1 |',
      '| 接口 | https://api.internal.example.com/v2/endpoint?filter=created_after%3D2024-01-01 |'].join('\n'));
    expect(html).toContain('<th class="md-col-clamp">值</th>');
    expect(html).toContain('<th>项</th>');
  });

  // ---- 本地图片 src 重写（cr-1005：多模态下行表达力）----
  it('image：workspace 本地路径 → /api/workspace/raw 直链（files/ 前缀与绝对路径）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    // files/ 前缀（数据根上传/Agent 专用空间约定形）——src 整体编码
    const files = render('![截图](files/__creator__/_tmp/1a0379ec43f6.jpg)');
    expect(files).toContain('src="/api/workspace/raw?path=files%2F__creator__%2F_tmp%2F1a0379ec43f6.jpg"');
    // 绝对路径（cr-22 上传引用主形态，正斜杠 Windows 形）
    const absFwd = render('![图](C:/Users/x/data/files/tmp/abc.jpg)');
    expect(absFwd).toContain('src="/api/workspace/raw?path=C%3A%2FUsers%2Fx%2Fdata%2Ffiles%2Ftmp%2Fabc.jpg"');
    // 绝对路径反斜杠形（markdown-it 解析层已百分号编码 %5C——渲染层
    // 解码判定后整体重编码）
    const absBack = render('![图](C:\\Users\\x\\data\\tmp\\abc.jpg)');
    expect(absBack).toContain('src="/api/workspace/raw?path=C%3A%5CUsers%5Cx%5Cdata%5Ctmp%5Cabc.jpg"');
    // alt 文本保留
    expect(files).toContain('alt="截图"');
  });

  it('image：非本地 src 一律不重写（http/data/裸相对路径/端点形不二次包裹）', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    expect(render('![外链](https://cdn.example.com/a.png)')).toContain('src="https://cdn.example.com/a.png"');
    expect(render('![本机](http://127.0.0.1:3830/api/workspace/raw?path=files/a.jpg)'))
      .toContain('src="http://127.0.0.1:3830/api/workspace/raw?path=files/a.jpg"');
    expect(render('![内嵌](data:image/png;base64,zz)')).toContain('src="data:image/png;base64,zz"');
    expect(render('![相对](images/pic.png)')).toContain('src="images/pic.png"');
    // 已是 raw 端点形（相对形态，LLM 也可能输出）——不二次包裹
    expect(render('![已直链](/api/workspace/raw?path=files/a.jpg)'))
      .toContain('src="/api/workspace/raw?path=files/a.jpg"');
  });
});
