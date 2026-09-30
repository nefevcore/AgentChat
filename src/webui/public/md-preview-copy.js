/* ============================================================
 * md-preview-copy.js —— Markdown 预览沙箱内代码块复制脚本
 *
 * 为何是外链文件而非内联 <script>：markdown 预览文档由 markdownPreviewDoc()
 * 组装、经 <iframe srcdoc sandbox="allow-scripts"> 渲染，而 srcdoc 文档
 * 继承宿主页（webui index.html）的 CSP——script-src 'self' 禁一切内联脚本，
 * 内联形被确定性拦截（cr-42；报错 hash 与脚本体 sha256 吻合实锤）。外链
 * self 脚本经实测可执行（CSP 放行同源资源）。本文件经 vite public 直拷
 * 进 dist、web-server 同源托管——legacy-runtime.js / officeVendor 同款通道，
 * mobile 端经 scripts/sync-webui.mjs 自动跟进。
 *
 * 功能：点击委托——banner 按钮 → 就近取代码文本 → navigator.clipboard
 * 优先（sandbox=allow-scripts 下可能被拒）→ execCommand 兜底 → copied 态
 * 切换（与父页 useMarkdown 的委托复制同视觉）。
 *
 * 写法保持 ES5 + classic script：与 legacy-runtime.js 同基线（WebView 92）。
 * ============================================================ */
document.addEventListener("click", function (e) {
  var btn = e.target && e.target.closest ? e.target.closest(".md-code-block-btn[data-action=copy]") : null;
  if (!btn) return;
  var block = btn.closest(".md-code-block");
  var code = block && block.querySelector("pre code");
  if (!code) return;
  var text = code.textContent || "";
  var done = function () {
    btn.classList.add("copied");
    var t = btn.querySelector(".md-code-block-btn-text");
    if (t) t.textContent = "已复制";
    setTimeout(function () {
      btn.classList.remove("copied");
      if (t) t.textContent = "复制";
    }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text) && done(); });
  } else { fallbackCopy(text) && done(); }
  function fallbackCopy (s) {
    var ta = document.createElement("textarea");
    ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { return document.execCommand("copy"); } finally { ta.remove(); }
  }
});
