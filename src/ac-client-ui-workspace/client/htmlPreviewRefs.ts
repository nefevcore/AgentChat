// ============================================================
// client/htmlPreviewRefs.ts —— HTML 预览相对引用改写（纯函数，可单测）
//
// 背景：HTML 预览 = <iframe srcdoc> + sandbox="allow-scripts"（安全
// 基线：无 allow-same-origin，预览的 HTML 触达不了父页面 DOM/存储）。
// srcdoc 文档无自身 URL——相对路径按宿主页（应用根 /）解析，工作区
// 相对引用（<img src="_dev/x.svg">）必然 404。
//
// 处置（预览侧改写，不动服务端）：
//   · 相对 src/srcset → /api/workspace/raw?path=<文件目录拼引用> 直链
//    （raw 端点与 readFile 同源定位词表；agentId/conversationId 读面
//     上下文随 query 透传，工作区相对引用同样可解析）；
//   · ../ 段保留原样——服务端 resolveIn 词法归一 + 越界守卫（逃出
//     数据根/工作区 = 404），与直接预览该路径同一防线；
//   · <base target="_blank"> 注入——srcdoc 内链接外开新窗口，防沙箱
//     内导航迷航。不能用 <base href> 指工作区：其属性值不允许 query
//    （HTML 规范要求丢弃），浏览器即便保留也会以词法 resolve 撞
//     Windows 盘符越界。
//
// 手法：正则改写（非 DOMParser）——srcdoc 本就要整段字符串，且纯函数
// 无 DOM 依赖可直测；script src / CSS url() 不改（执行面与样式面保持
// 预览语义，不悄悄换加载来源）；引用值含 > 的畸形 HTML 不迁就。
// ============================================================

import type { ReadContext } from './workspaceFile.ts';

/** 引用属性标签范围：媒体类（img/source/video/audio/track） */
const SRC_TAGS = 'img|source|video|audio|track';

/** src 属性（引号值；未引号形罕见，不改写） */
const SRC_RE = new RegExp(
  '(<(?:' + SRC_TAGS + ')\\b[^>]*?\\ssrc\\s*=\\s*)(["\'])(.*?)\\2',
  'gi',
);

/** srcset 属性（img/source；值 = 逗号分隔的 url [描述符] 候选） */
const SRCSET_RE = new RegExp(
  '(<(?:img|source)\\b[^>]*?\\ssrcset\\s*=\\s*)(["\'])(.*?)\\2',
  'gi',
);

/** 目录段提取（双分隔符）：'a/b/c.html' → 'a/b'；无分隔符 → '' */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
}

/** 单个引用值 → raw 直链（相对值拼目录；其余形态原样） */
function resolveRef(ref: string, dir: string, ctx?: ReadContext): string {
  if (!ref) return ref;
  // 协议（http/data/…）/ 协议相对 //、锚点、查询、根相对 /：不改写
  //（根相对在本域语义 = 应用根而非工作区根，盲目映射会指错文件，宁缺）
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?|\/)/i.test(ref)) return ref;
  const parts = ['path=' + encodeURIComponent(dir ? dir + '/' + ref : ref)];
  if (ctx?.agentId) parts.push('agentId=' + encodeURIComponent(ctx.agentId));
  if (ctx?.conversationId) parts.push('conversationId=' + encodeURIComponent(ctx.conversationId));
  return '/api/workspace/raw?' + parts.join('&');
}

/** HTML 内相对引用改写为 raw 直链（dir = 预览文件所在目录） */
export function rewriteHtmlRefs(html: string, dir: string, ctx?: ReadContext): string {
  if (!html) return html;
  let out = html.replace(SRC_RE, (_m, pre: string, q: string, val: string) =>
    pre + q + resolveRef(val, dir, ctx) + q);
  out = out.replace(SRCSET_RE, (_m, pre: string, q: string, val: string) => {
    const rewritten = val.split(',').map((cand: string) => {
      const t = cand.trim();
      if (!t) return cand;
      const sp = t.search(/\s/);
      return sp < 0 ? resolveRef(t, dir, ctx) : resolveRef(t.slice(0, sp), dir, ctx) + t.slice(sp);
    }).join(',');
    return pre + q + rewritten + q;
  });
  return out;
}

/** <base target="_blank"> 注入（已有 <base> 尊重作者；<head> → <html> → 置顶） */
export function injectBaseTarget(html: string): string {
  const TAG = '<base target="_blank">';
  if (/<base\b/i.test(html)) return html;
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + TAG + html.slice(m.index + m[0].length);
  }
  return TAG + html;
}

/** 预览 HTML 组装：相对引用改写（按文件所在目录 + 读面上下文）+ base target 注入 */
export function preparePreviewHtml(content: string, filePath: string, ctx?: ReadContext): string {
  if (!content) return content;
  return injectBaseTarget(rewriteHtmlRefs(content, dirOf(filePath || ''), ctx));
}
// ============================================================
// Markdown 预览文档壳（沙箱 iframe srcdoc 用）
// ============================================================

/** markdown.css 主题相关变量子集（亮/暗两套——srcdoc 文档无应用变量，
//  内嵌求值；变量词表见 webui/src/assets/main.css。文档级排版样式
//（标题/代码块/表格…）住应用侧 markdown.css，iframe 内 v1 不内嵌） */
const MD_PALETTE_LIGHT = [
  '--color-primary:#6366f1', '--color-text-primary:#2c3e50',
  '--color-text-secondary:#7f8c8d', '--color-text-tertiary:#a8abb2',
  '--color-text-muted:#95a5a6', '--color-bg-page:#ffffff',
  '--color-bg-surface:#f8f8f8', '--color-bg-subtle:#e9e9e9',
  '--color-border-primary:#bdc3c7', '--color-border-secondary:#e0e0e0',
  '--color-border-light:#eee', '--color-link:#4f46e5',
  '--color-code-bg:#ffffff', '--color-code-border:#dfe6e9',
  '--color-code-toolbar:#eceff1',
].join(';');

const MD_PALETTE_DARK = [
  '--color-primary:#818cf8', '--color-text-primary:#ecf0f1',
  '--color-text-secondary:#bdc3c7', '--color-text-tertiary:#7f8c8d',
  '--color-text-muted:#7f8c8d', '--color-bg-page:#1a1a1a',
  '--color-bg-surface:#2d2d2d', '--color-bg-subtle:#252525',
  '--color-border-primary:#404040', '--color-border-secondary:#333333',
  '--color-border-light:#333333', '--color-link:#818cf8',
  '--color-code-bg:#2d2d2d', '--color-code-border:#404040',
  '--color-code-toolbar:#252525',
].join(';');

/** 文档级排版样式（markdown.css 的文档形子集——srcdoc 文档无应用样式表，
 *  内嵌求值；值消费调色板变量，随亮/暗两套） */
const MD_DOC_STYLES = [
  'body{margin:0;padding:24px 28px;color:var(--color-text-primary);background:var(--color-bg-page);font:14px/1.7 -apple-system,"Segoe UI","Noto Sans SC",sans-serif;word-break:break-word}',
  'a{color:var(--color-link)}',
  'h1{font-size:1.6em;margin:1em 0 .5em;line-height:1.35}h2{font-size:1.35em;margin:1em 0 .45em;line-height:1.35}h3{font-size:1.15em;margin:.9em 0 .4em}h4{font-size:1em;margin:.8em 0 .35em;color:var(--color-text-secondary)}',
  'p{margin:7px 0}blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid var(--color-border-primary);color:var(--color-text-secondary)}',
  'code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:var(--color-bg-surface);border:1px solid var(--color-border-light);border-radius:4px;padding:.1em .35em}',
  'pre{margin:10px 0;padding:12px 14px;background:var(--color-code-bg);border:1px solid var(--color-code-border);border-radius:8px;overflow-x:auto}pre code{background:none;border:none;padding:0;font-size:13px}',
  'img{max-width:100%}table{border-collapse:collapse;margin:10px 0}th,td{border:1px solid var(--color-border-secondary);padding:6px 12px}th{background:var(--color-bg-surface)}',
  'hr{border:none;border-top:1px solid var(--color-border-light);margin:16px 0}',
  'ul,ol{padding-left:24px;margin:7px 0}',
  // ---- 代码块（md-code-block——markdown.css 同源复刻；banner 样式在此前
  // 仅存应用侧样式表，srcdoc 文档拿不到 → 预览面 header 样式丢失。
  // token 对齐调色板（--radius-* 无对应项，按 10px/6px 直值）） ----
  '.md-code-block{margin:12px 0;border-radius:10px;background:var(--color-code-bg);border:1px solid var(--color-code-border);overflow:hidden;min-width:0;max-width:100%}',
  '.md-code-block-banner{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:30px;background:var(--color-code-bg);border-bottom:1px solid var(--color-border-secondary);-webkit-user-select:none;user-select:none}',
  '.md-code-block-lang{font-size:11px;font-weight:500;color:var(--color-text-muted);text-transform:lowercase;letter-spacing:.3px}',
  '.md-code-block-actions{display:flex;align-items:center;gap:2px}',
  '.md-code-block-btn{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;font-size:12px;font-weight:500;color:var(--color-text-muted);background:transparent;border:none;border-radius:6px;cursor:pointer;opacity:0;transition:opacity .15s,color .15s,background .15s;line-height:1;font-family:inherit}',
  '.md-code-block:hover .md-code-block-btn,.md-code-block-btn:focus-visible{opacity:1}',
  '@media (hover:none){.md-code-block-btn{opacity:.6}}',
  '.md-code-block-btn:hover{color:var(--color-text-primary);background:var(--color-bg-subtle)}',
  '.md-code-block-btn:active{transform:scale(.95)}',
  '.md-code-block-btn.copied{opacity:1;color:#22c55e}',
  '.md-code-block-btn-icon{display:inline-flex;align-items:center}',
  '.md-code-block-btn-text{white-space:nowrap}',
  '.md-code-block-btn.copied .md-code-block-btn-icon-copy{display:none}',
  '.md-code-block-btn.copied .md-code-block-btn-icon-check{display:inline-flex !important}',
  '.md-code-block pre{margin:0;border-radius:0;border:none;padding:12px 16px;background:var(--color-code-bg);overflow-x:auto;max-width:100%}',
  '.md-code-block pre code{background:transparent;padding:0;font-size:13px;line-height:1.6;white-space:pre;color:inherit}',
].join('\n');

/** 沙箱内复制脚本（静态字符串，无用户内容——srcdoc 注入零注入面）。
 * 点击委托：banner 按钮 → 就近取代码文本 → navigator.clipboard 优先
 *（sandbox=allow-scripts 下可能被拒）→ execCommand 兜底 → copied 态
 * 切换（与父页 useMarkdown 的委托复制同视觉）。 */
const MD_COPY_SCRIPT = [
  '<script>',
  'document.addEventListener("click", function (e) {',
  '  var btn = e.target && e.target.closest ? e.target.closest(".md-code-block-btn[data-action=copy]") : null;',
  '  if (!btn) return;',
  '  var block = btn.closest(".md-code-block");',
  '  var code = block && block.querySelector("pre code");',
  '  if (!code) return;',
  '  var text = code.textContent || "";',
  '  var done = function () {',
  '    btn.classList.add("copied");',
  '    var t = btn.querySelector(".md-code-block-btn-text");',
  '    if (t) t.textContent = "已复制";',
  '    setTimeout(function () {',
  '      btn.classList.remove("copied");',
  '      if (t) t.textContent = "复制";',
  '    }, 1600);',
  '  };',
  '  if (navigator.clipboard && navigator.clipboard.writeText) {',
  '    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text) && done(); });',
  '  } else { fallbackCopy(text) && done(); }',
  '  function fallbackCopy (s) {',
  '    var ta = document.createElement("textarea");',
  '    ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0";',
  '    document.body.appendChild(ta); ta.select();',
  '    try { return document.execCommand("copy"); } finally { ta.remove(); }',
  '  }',
  '});',
  '</scr' + 'ipt>',
].join('\n');

/** Markdown 预览完整文档：内嵌亮/暗调色板（随系统偏好）+ base target
 * （链接外开）+ 受信渲染正文 + 代码块 banner 样式与沙箱内复制脚本。
 * bodyHtml 由消费方先行完成相对引用改写。 */
export function markdownPreviewDoc(bodyHtml: string): string {
  if (!bodyHtml) return '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<base target="_blank">'
    + '<style>:root{' + MD_PALETTE_LIGHT + '}'
    + ' @media (prefers-color-scheme:dark){:root{' + MD_PALETTE_DARK + '}}'
    + MD_DOC_STYLES + '</style>'
    + '</head><body><div class="markdown-body">' + bodyHtml + '</div>'
    + MD_COPY_SCRIPT + '</body></html>';
}
