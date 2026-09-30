// ============================================================
// @vitest-environment jsdom
// ac-client-ui-workspace/tests/preview-markdown-doc.test.ts ——
// Markdown 预览沙箱文档单测（markdownPreviewDoc + renderTrusted 组装链）
//
// 背景：Markdown 预览改为渲染进 sandbox iframe（与 HTML 预览同一安全
// 基线）——raw HTML（README 的 <div align>/<img>/<details>）经
// renderTrusted（markdown-it html:true）真实渲染而非转义成字面文本；
// 相对图片经 rewriteHtmlRefs 改 raw 直链（srcdoc 无自身 URL，相对路径
// 按宿主页解析必 404）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownPreviewDoc, rewriteHtmlRefs, dirOf } from '../client/htmlPreviewRefs.ts';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';

describe('markdownPreviewDoc', () => {
  it('完整文档壳：doctype + base target + 亮/暗调色板 + markdown-body 包裹', () => {
    const doc = markdownPreviewDoc('<p>hi</p>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('prefers-color-scheme:dark');
    expect(doc).toContain('--color-text-primary:#2c3e50');
    expect(doc).toContain('--color-text-primary:#ecf0f1');
    expect(doc).toContain('<div class="markdown-body"><p>hi</p></div>');
  });

  it('代码块 banner 样式 + 沙箱内复制脚本外链注入（cr-42：srcdoc 继承宿主 CSP script-src self，内联必被拦——脚本本体迁 webui public 同源托管）', () => {
    const doc = markdownPreviewDoc('<p>hi</p>');
    // banner/按钮全套样式（此前仅存应用侧样式表，srcdoc 文档拿不到）
    expect(doc).toContain('.md-code-block-banner{');
    expect(doc).toContain('.md-code-block-btn.copied');
    // 复制脚本外链注入（父页事件委托进不了 iframe——sandbox 无 allow-same-origin；
    // 内联形被 CSP 拦死，外链 self 脚本放行）
    expect(doc).toContain('<script src="/md-preview-copy.js">');
    expect(doc).not.toMatch(/<script(?![^>]*src=)[^>]*>/); // 不得残留任何内联 script
  });
  it('复制脚本本体在 webui public（构建进 dist 同源托管，CSP self 放行）', () => {
    const file = join(__dirname, '..', '..', 'webui', 'public', 'md-preview-copy.js');
    expect(existsSync(file), '缺少 src/webui/public/md-preview-copy.js').toBe(true);
    const src = readFileSync(file, 'utf-8');
    // 与文档壳按钮选择器对齐（脱钩即按钮死控件）
    expect(src).toContain('.md-code-block-btn[data-action=copy]');
    expect(src).toContain('execCommand');
  });

  it('空正文 → 空串（组件分支回落 loading/空态）', () => {
    expect(markdownPreviewDoc('')).toBe('');
  });
});

describe('renderTrusted（renderer 受信实例）', () => {
  it('raw HTML 放行：README 的 <div align=center>/<img> 原样渲染', () => {
    const { renderTrusted } = useMarkdown();
    const out = renderTrusted('<div align="center"><img src="logo.png" width="120"></div>');
    expect(out).toContain('<div align="center">');
    expect(out).toContain('<img src="logo.png"');
  });

  it('markdown 语法照常（加粗/链接）', () => {
    const { renderTrusted } = useMarkdown();
    expect(renderTrusted('**b**')).toContain('<strong>b</strong>');
    expect(renderTrusted('[t](https://a.b)')).toContain('href="https://a.b"');
  });

  it('聊天实例仍转义 raw HTML（安全基线不变）', () => {
    const { render } = useMarkdown();
    expect(render('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('相对图片引用组合链：受信渲染 + raw 直链改写', () => {
    const { renderTrusted } = useMarkdown();
    const body = rewriteHtmlRefs(renderTrusted('![logo](img/logo.png)'), dirOf('docs/README.md'), undefined);
    expect(body).toContain('src="/api/workspace/raw?path=docs%2Fimg%2Flogo.png"');
  });

  it('markdown 图片引用改写不影响外链', () => {
    const { renderTrusted } = useMarkdown();
    const body = rewriteHtmlRefs(renderTrusted('![b](https://a.b/c.png)'), '', undefined);
    expect(body).toContain('src="https://a.b/c.png"');
  });
});