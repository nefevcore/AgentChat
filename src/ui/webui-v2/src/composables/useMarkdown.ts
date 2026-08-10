// ============================================================
// composables/useMarkdown.ts —— markdown 渲染（单例）
// ============================================================

import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import hljs from 'highlight.js';
import katex from 'katex';

export function useMarkdown() {
  const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    highlight: (code: string, lang: string): string => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
        } catch { /* fallthrough */ }
      }
      return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    },
  });

  md.use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false } });

  function render(content: string): string {
    return md.render(content || '');
  }

  function renderPlain(content: string): string {
    return md.utils.escapeHtml(content || '');
  }

  return { render, renderPlain };
}
