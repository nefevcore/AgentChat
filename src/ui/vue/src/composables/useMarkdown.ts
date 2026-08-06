// ============================================================
// Markdown 渲染 composable（语法高亮 + 复制按钮）
// ============================================================

import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';
import { v4 as uuidv4 } from 'uuid';
import { registerAbapLanguage } from '../utils/abap-hljs';
import { logger } from '../utils/logger';

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

    // 禁用模糊链接匹配，避免将 "TODO.md" 等文件名误识别为链接（.md 是摩尔多瓦 ccTLD）
    md.linkify.set({ fuzzyLink: false });

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
    // 匹配: ./path/file.ext 或 path/to/file.ext 或 /path/file.ext
    // 要求路径中至少有一个 /（区分文件名和普通单词）
    return new RegExp(
        `(\\.{0,2}/)?([\\w\\-.]+/)+[\\w\\-.]+?\\.(${extGroup})\\b`,
        'gi'
    );
})();

// ---- <file> 标签解析 ----
// <file> 标签由 LLM 输出，前端解析为可点击的文件链接。
// <msg> 标签仅存在于 LLM 上下文（loadGroupHistory 格式化），前端无需解析。
//
// 占位符使用 __MD_X_<随机>_<序号> 格式，不含任何 HTML 特殊字符，
// 确保安全穿过 markdown-it 渲染管线。

interface ParsedTag {
  placeholder: string;
  replacement: string;
}

/** 每次渲染生成唯一占位符，不含任何 markdown 特殊字符 */
function makePlaceholder(prefix: string, index: number): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `MDFT_${rnd}_${index}`;
}

/** 解析 <file path="...">name</file> 标签，替换为安全占位符 */
function parseFileTags(content: string): { text: string; tags: ParsedTag[] } {
  const tags: ParsedTag[] = [];
  const filePattern = /<file\s+path=(['"])(.*?)\1\s*>(.*?)<\/file>/gi;

  const text = content.replace(filePattern, (match, _quote, filePath, displayName) => {
    const escapedPath = filePath.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedName = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const placeholder = makePlaceholder('FT', tags.length);
    tags.push({
      placeholder,
      replacement: `<span class="file-tag" data-file-path="${escapedPath}" title="点击预览文件">${escapedName}</span>`,
    });
    return placeholder;
  });

  return { text, tags };
}

/** 在 markdown 渲染后还原占位符为 HTML */
function restoreTags(html: string, tags: ParsedTag[]): string {
  let result = html;
  for (const tag of tags) {
    result = result.split(tag.placeholder).join(tag.replacement);
  }
  return result;
}

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
            // 1. 预处理：解析 <file> 标签 → 占位符
            const { text: afterTags, tags: fileTags } = parseFileTags(trimmed);

            // 2. Markdown 渲染
            const rendered = md.render(afterTags).trimEnd();

            // 3. 后处理：还原占位符 → HTML + 正则兜底文件路径
            const withTags = restoreTags(rendered, fileTags);
            return linkifyFilePaths(withTags);
        } catch (error) {
            logger.error('Markdown 渲染失败:', error);
            return md.utils.escapeHtml(content);
        }
    }

    /** 轻量渲染（不含 KaTeX 数学公式），用于思考内容等性能敏感场景 */
    function renderPlain(content: string): string {
        if (!content) return '';
        const trimmed = content.trimEnd();
        if (!trimmed) return '';
        try {
            // 1. 预处理：解析 <file> 标签 → 占位符
            const { text: afterTags, tags: fileTags } = parseFileTags(trimmed);

            // 2. Markdown 渲染
            const rendered = mdPlain.render(afterTags).trimEnd();

            // 3. 后处理：还原占位符 → HTML + 正则兜底文件路径
            const withTags = restoreTags(rendered, fileTags);
            return linkifyFilePaths(withTags);
        } catch (error) {
            logger.error('Markdown 渲染失败:', error);
            return mdPlain.utils.escapeHtml(content);
        }
    }

    return { render, renderPlain };
}
