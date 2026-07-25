// ============================================================
// Markdown 渲染 composable（语法高亮 + 复制按钮）
// ============================================================

import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';
import { v4 as uuidv4 } from 'uuid';
import { registerAbapLanguage } from '../utils/abap-hljs';

// 注册 ABAP 语言高亮
registerAbapLanguage();

// ---- 动态语法高亮主题 ----
let themeStyleEl: HTMLStyleElement | null = null;

function ensureThemeStyle(): HTMLStyleElement {
  if (!themeStyleEl) {
    themeStyleEl = document.createElement('style');
    themeStyleEl.id = 'hljs-theme';
    document.head.appendChild(themeStyleEl);
  }
  return themeStyleEl;
}

function applyTheme(isDark: boolean) {
  // 使用内联简单主题（避免额外 CSS 文件依赖）
  const lightTheme = `
.hljs{color:#383a42;background:#fafafa}
.hljs-comment,.hljs-quote{color:#a0a1a7;font-style:italic}
.hljs-doctag,.hljs-keyword,.hljs-formula{color:#a626a4}
.hljs-section,.hljs-name,.hljs-selector-tag,.hljs-deletion,.hljs-subst{color:#e45649}
.hljs-literal{color:#0184bb}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#50a14f}
.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-type,.hljs-selector-class,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-number{color:#986801}
.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-title{color:#4078f2}
.hljs-built_in,.hljs-title.class_,.hljs-class .hljs-title{color:#c18401}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
.hljs-link{text-decoration:underline}
`;
  const darkTheme = `
.hljs{color:#d6deeb;background:#011627}
.hljs-keyword{color:#c792ea;font-style:italic}
.hljs-built_in{color:#addb67;font-style:italic}
.hljs-type{color:#82aaff}
.hljs-literal{color:#ff5874}
.hljs-number{color:#f78c6c}
.hljs-regexp{color:#5ca7e4}
.hljs-string{color:#ecc48d}
.hljs-subst{color:#d3423e}
.hljs-symbol{color:#82aaff}
.hljs-class{color:#ffcb8b}
.hljs-function{color:#82aaff}
.hljs-title{color:#dcdcaa;font-style:italic}
.hljs-params{color:#7fdbca}
.hljs-comment{color:#637777;font-style:italic}
.hljs-doctag{color:#7fdbca}
.hljs-meta,.hljs-meta .hljs-keyword{color:#82aaff}
.hljs-meta .hljs-string{color:#ecc48d}
.hljs-section{color:#82b1ff}
.hljs-attr,.hljs-name,.hljs-tag{color:#7fdbca}
.hljs-attribute{color:#80cbc4}
.hljs-variable{color:#addb67}
.hljs-bullet{color:#d9f5dd}
.hljs-code{color:#80cbc4}
.hljs-emphasis{color:#c792ea;font-style:italic}
.hljs-strong{color:#addb67;font-weight:bold}
.hljs-formula{color:#c792ea}
.hljs-link{color:#ff869a}
.hljs-quote{color:#697098;font-style:italic}
.hljs-selector-tag{color:#ff6363}
.hljs-selector-id{color:#fad430}
.hljs-selector-class{color:#addb67;font-style:italic}
.hljs-selector-attr,.hljs-selector-pseudo{color:#c792ea;font-style:italic}
.hljs-template-tag{color:#c792ea}
.hljs-template-variable{color:#addb67}
.hljs-addition{color:#addb67ff;font-style:italic}
.hljs-deletion{color:#ef535090;font-style:italic}
// ABAP specific
.hljs-meta{color:#c792ea}
`;
  ensureThemeStyle().textContent = isDark ? darkTheme : lightTheme;
}

// 初始化主题
function getIsDark(): boolean {
  const html = document.documentElement;
  if (html.classList.contains('dark')) return true;
  if (html.classList.contains('light')) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

applyTheme(getIsDark());

// 监听系统偏好变化
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', (e) => {
  // 仅在未手动设置主题时跟随系统
  const html = document.documentElement;
  if (!html.classList.contains('dark') && !html.classList.contains('light')) {
    applyTheme(e.matches);
  }
});

// 监听手动主题切换事件
window.addEventListener('theme-changed', ((e: CustomEvent) => {
  applyTheme(e.detail.theme === 'dark');
}) as EventListener);

// ---- 创建实例工厂 ----
let mdInstance: MarkdownIt | null = null;
let mdPlainInstance: MarkdownIt | null = null;

/** 创建共享的 markdown-it 基础配置 + 自定义规则 */
function createBaseInstance(): MarkdownIt {
    const md = new MarkdownIt({
        html: false,
        linkify: true,
        breaks: true,
        highlight(str: string, lang: string): string {
            if (lang && hljs.getLanguage(lang)) {
                try {
                    return hljs.highlight(str, { language: lang }).value;
                } catch (e) { /* fallthrough */ }
            }
            return md.utils.escapeHtml(str);
        },
    });

    // 自定义表格渲染 —— 包裹滚动容器
    md.renderer.rules.table_open = () => '<div class="md-table-wrapper"><table>';
    md.renderer.rules.table_close = () => '</table></div>';

    // 自定义代码块渲染 —— 添加语言标签 + 复制按钮
    const defaultRender = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
        const token = tokens[idx];
        const lang = token.info || 'text';
        const codeId = `cb-${uuidv4().slice(0, 8)}`;
        const highlighted = defaultRender(tokens, idx, options, env, self);
        const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        return `
<div class="md-code-block">
  <div class="md-code-block-banner">
    <span class="md-code-block-lang">${lang}</span>
    <div class="md-code-block-actions">
      <button class="md-code-block-btn" data-action="copy" data-code-id="${codeId}">
        <span class="md-code-block-btn-icon md-code-block-btn-icon-copy">${copyIcon}</span>
        <span class="md-code-block-btn-icon md-code-block-btn-icon-check" style="display:none">${checkIcon}</span>
        <span class="md-code-block-btn-text">复制</span>
      </button>
    </div>
  </div>
  ${highlighted}
</div>`;
    };

    return md;
}

/** 完整渲染实例（含 KaTeX 数学公式） */
function getMarkdownInstance(): MarkdownIt {
    if (mdInstance) return mdInstance;
    mdInstance = createBaseInstance();
    mdInstance.use(texmath, {
        engine: katex,
        delimiters: 'dollars',
        katexOptions: {
            throwOnError: false,
            errorColor: '#cc0000',
            strict: 'ignore',
        },
    });
    return mdInstance;
}

/** 轻量渲染实例（不含数学公式，用于思考内容等性能敏感场景） */
function getMarkdownPlainInstance(): MarkdownIt {
    if (mdPlainInstance) return mdPlainInstance;
    mdPlainInstance = createBaseInstance();
    return mdPlainInstance;
}

// ---- 文件路径检测 ----
// 匹配工作区文件路径：./path/file.ext、/path/file.ext、path/to/file.ext
// 需要包含路径分隔符 + 已知文件扩展名
const KNOWN_EXTS = [
    'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'txt', 'md',
    'py', 'java', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'sh', 'bash',
    'ps1', 'sql', 'abap', 'vue', 'svelte', 'rs', 'go', 'rb', 'php', 'swift', 'kt',
    'scala', 'c', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'bat', 'cmd', 'log', 'csv',
    'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
];

const FILE_PATH_PATTERN = (() => {
    const extGroup = KNOWN_EXTS.join('|');
    // 匹配: ./path/file.ext 或 /path/file.ext 或 path/to/file.ext
    // 要求路径中至少有一个 /
    return new RegExp(
        `(\\.{0,2}/)([\\w\\-./]+)\\.(${extGroup})\\b`,
        'gi'
    );
})();

/**
 * 在渲染后的 HTML 中检测并标记可点击的文件路径。
 * 使用占位符保护已有 HTML 标签，然后对纯文本进行路径替换。
 */
function linkifyFilePaths(html: string): string {
    // Step 1: 保护已有的 HTML 标签（<a>, <code>, <pre>, <img> 等），替换为占位符
    const protectedTags: string[] = [];
    const protectedHtml = html.replace(
        /<(a|pre|img|button|svg|path|rect|polyline|circle|line|span|div)[^>]*>.*?<\/\1>|<(a|pre|img|button|svg|path|rect|polyline|circle|line|span|div)[^>]*\/?>|<(a|pre|img|button|svg|path|rect|polyline|circle|line|span|div)[^>]*>(?:(?!<\/\1>).)*$/gs,
        (match) => {
            protectedTags.push(match);
            return `\x00PROTECTED_${protectedTags.length - 1}\x00`;
        }
    );

    // Step 2: 在受保护的 HTML 中查找文件路径
    const result = protectedHtml.replace(FILE_PATH_PATTERN, (match, prefix) => {
        // 跳过看起来像 URL 的
        if (/^https?:\/\//i.test(match)) return match;
        // 跳过太短或太长的路径
        if (match.length < 4 || match.length > 200) return match;
        return `<span class="file-path-link" data-file-path="${match}" title="点击预览此文件">${match}</span>`;
    });

    // Step 3: 还原受保护的 HTML 标签
    return result.replace(/\x00PROTECTED_(\d+)\x00/g, (_, i) => {
        const idx = parseInt(i, 10);
        return protectedTags[idx] || '';
    });
}

export function useMarkdown() {
    const md = getMarkdownInstance();
    const mdPlain = getMarkdownPlainInstance();

    function render(content: string): string {
        if (!content) return '';
        const trimmed = content.trimEnd();
        if (!trimmed) return '';
        try {
            const rendered = md.render(trimmed).trimEnd();
            return linkifyFilePaths(rendered);
        } catch (error) {
            console.error('Markdown 渲染失败:', error);
            return md.utils.escapeHtml(content);
        }
    }

    /** 轻量渲染（不含 KaTeX 数学公式），用于思考内容等性能敏感场景 */
    function renderPlain(content: string): string {
        if (!content) return '';
        const trimmed = content.trimEnd();
        if (!trimmed) return '';
        try {
            const rendered = mdPlain.render(trimmed).trimEnd();
            return linkifyFilePaths(rendered);
        } catch (error) {
            console.error('Markdown 渲染失败:', error);
            return mdPlain.utils.escapeHtml(content);
        }
    }

    return { render, renderPlain };
}
