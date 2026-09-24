// ============================================================
// client/filePreviewContent.ts —— 文件预览内容逻辑 composable
//（P1 aux 预览选区：自 FilePreviewModal 抽出共用——Modal（移动端
//  全屏形态）与多 tab 面板 pane 双消费，单一逻辑源）
//
// 职责：按 filePath 自取数（候选路径 fallback files/<agentId>/）+
//   类型分派（HTML/图片/Markdown/代码）+ 高亮/渲染计算。
// 请求序号守卫在 pane 粒度：快速连点两个文件时，A 的慢响应后到
//   不会覆盖 B（每个 pane 独立 seq 域，互不干扰）。
// ============================================================
import { ref, computed, watch, getCurrentInstance } from 'vue';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';
import { hljs, ensureHljsLanguage, hljsLanguageVersion } from 'ac-client-ui-renderer/client/hljs-languages.ts';
import { fetchWorkspaceFile, type ReadContext } from './workspaceFile.ts';
import { preparePreviewHtml, rewriteHtmlRefs, dirOf, markdownPreviewDoc } from './htmlPreviewRefs.ts';

interface FileData {
  path: string;
  content: string;
  contentType: string;
  size: number;
  binary: boolean;
  base64?: boolean;
}

// ============================================================
// 视图模式（下拉框格式选择）：能力检查 + 分派（纯函数，可单测）
// ============================================================

/** 视图模式：'auto' 演示扩展名自动分派；其余为用户显式选择的渲染格式 */
export type PreviewViewMode = 'auto' | 'markdown' | 'code' | 'text' | 'image' | 'html' | 'office';

/** 实际渲染分支（viewMode 解析结果——auto 落到具体格式） */
export type PreviewViewKind = 'markdown' | 'code' | 'text' | 'image' | 'html' | 'office';

/** 高亮语言表（扩展名 → hljs 语言）：非表内扩展名按纯文本渲染 */
const HIGHLIGHT_LANGS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'jsx', 'json', 'css', 'scss', 'less', 'html', 'htm',
  'xml', 'svg', 'vue', 'svelte', 'py', 'java', 'rs', 'go', 'rb', 'php', 'swift',
  'kt', 'scala', 'c', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'sh', 'bash', 'ps1', 'sql',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'bat', 'cmd', 'abap', 'md',
]);

/** 图片扩展名集（imageSrc 构造能力——svg 为文本但可转 data URL） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

/** 纯文本展示扩展名（无高亮价值：日志/普通文本/逗号分隔数据等） */
const TEXT_EXTS = new Set(['txt', 'log', 'csv', 'env']);

/** Office 文档扩展名（@vue-office 渲染：docx/xlsx/pptx 纯前端解析；
 *  doc/xls/ppt 属 97-2003 复合二进制格式，解析器不支持——不进此表，
 *  维持未知二进制兜底（十六进制/下载/本地打开） */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'xlsm', 'pptx']);

/** 文件名（含扩展名）提取 */
function baseNameOf(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** 扩展名提取（小写；无扩展名 = ''） */
function extOf(p: string): string {
  const name = baseNameOf(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * 文件能力检查：路径 → 允许的视图格式列表（下拉框选项源）。
 * 纯路径推导（预取数前即可调用——选项随 tab 即刻就位）；
 * binary 网关按已知图片扩展名放行，未知二进制无任何选项
 * （auto 分支兜底十六进制/下载提示，下拉隐藏）。
 * 顺序即下拉展示序：auto 恒居首，其余按该文件的自然主格式排前。
 */
export function previewModeOptions(path: string): PreviewViewMode[] {
  const ext = extOf(path);
  // 已知二进制扩展名（图片除外）与无扩展名：auto 分支兜底渲染，无可切
  // 格式（svg 在 IMAGE_EXTS 内不会走到这里）
  if (!ext || (!IMAGE_EXTS.has(ext) && !HIGHLIGHT_LANGS.has(ext) && !TEXT_EXTS.has(ext) && !OFFICE_EXTS.has(ext))) {
    return [];
  }
  const opts: PreviewViewMode[] = ['auto'];
  if (OFFICE_EXTS.has(ext)) opts.push('office');
  else if (ext === 'md') opts.push('markdown', 'code', 'text');
  else if (ext === 'html' || ext === 'htm') opts.push('html', 'code', 'text');
  else if (IMAGE_EXTS.has(ext)) opts.push('image', ...(ext === 'svg' ? ['code' as PreviewViewMode] : [])); // svg 文本格式可看源码；位图 binary 无文本视图
  else if (HIGHLIGHT_LANGS.has(ext)) opts.push('code', 'text');
  else opts.push('text', 'code');
  return opts;
}

/** 预览格式下拉显示词（Modal 与 pane 双形态同款词表） */
export const PREVIEW_MODE_LABELS: Record<PreviewViewMode, string> = {
  auto: '自动',
  markdown: 'Markdown',
  code: '代码',
  text: '纯文本',
  image: '图片',
  html: '网页',
  office: 'Office',
};

/**
 * 视图分派：viewMode + 路径 + binary 网关 → 实际渲染分支。
 * auto：按扩展名落 markdown/html/image/code/text；
 * 显式模式：受 binary 网关约束（二进制时 image 之外全部回落 text——
 * 十六进制视图），非法组合（如图片选 markdown）回落 auto 结果。
 */
export function resolveViewKind(
  viewMode: PreviewViewMode,
  path: string,
  binary: boolean,
): PreviewViewKind {
  const ext = extOf(path);
  // auto 结果（扩展名 → 自然格式）
  let auto: PreviewViewKind;
  if (OFFICE_EXTS.has(ext)) auto = 'office';
  else if (ext === 'md') auto = 'markdown';
  else if (ext === 'html' || ext === 'htm') auto = 'html';
  else if (IMAGE_EXTS.has(ext)) auto = 'image';
  else if (HIGHLIGHT_LANGS.has(ext)) auto = 'code';
  else auto = 'text';
  if (viewMode === 'auto') return auto;
  // binary 网关：非图片二进制只允许 text（十六进制兜底视图）；office 文件
  // 例外——其二进制载荷正是渲染源（@vue-office 吃 base64），office 即自然格式
  if (binary && viewMode !== 'image' && viewMode !== 'office') return auto === 'image' ? 'image' : auto === 'office' ? 'office' : 'text';
  // 合法性检查：选项集外的显式模式回落 auto（防脏数据/竞态）
  return previewModeOptions(path).includes(viewMode) ? viewMode : auto;
}

/**
 * 按行切分 hljs 高亮 HTML：跨行 <span>（块注释/模板串）行尾闭合、
 * 行首重开——颜色跨行延续且每行是平衡 HTML（可独立 v-html 渲染）。
 * 纯文本（无标签）路径 = 按换行直切。
 */
export function splitHighlightedHtml(html: string): string[] {
  if (!html) return [];
  // 无标签快路径（hljs 不可识别语言 → 纯转义文本）
  if (!html.includes('<')) return html.split('\n');
  const out: string[] = [];
  // 用占位符保护实体（&amp; 等不被行切分破坏——split 不动它们，此处无需处理）
  let openTags: string[] = []; // 未闭合标签栈（跨行延续）
  // 逐字符扫描太慢；按标签与换行 tokenize
  const tokens = html.split(/(<[^>]+>)/);
  let line = '';
  for (const tk of tokens) {
    if (tk === '\n') {
      out.push(openTags.length ? `${line}${openTags.map(() => '</span>').join('')}` : line);
      line = openTags.length ? openTags.join('') : '';
      continue;
    }
    if (tk.startsWith('<')) {
      if (tk.startsWith('</')) {
        openTags.pop(); // hljs 输出规范：闭合与开标签严格配对
      } else if (!tk.endsWith('/>')) {
        openTags.push(tk);
      }
      line += tk;
    } else {
      // 文本 token：可能内含换行（split 只切标签，文本里的 \n 保留）
      const parts = tk.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          out.push(openTags.length ? `${line}${openTags.map(() => '</span>').join('')}` : line);
          line = openTags.length ? openTags.join('') : '';
        }
        line += parts[i];
      }
    }
  }
  out.push(line);
  return out;
}

/**
 * 单个文件预览的自取数内容逻辑。
 * @param filePath 文件路径（ref——pane 的 key 路径；一个 pane 生命周期内不变）
 * @param context 读面推导上下文（agentId/conversationId——M32：服务端按
 *   会话挂载工作区 > Agent 沙箱基准定位相对引用；404 后回落本地
 *   files/<agentId>/ 前缀猜测）
 * @param enabled 加载门（pane 显隐/面板开合时控制——false 期间不发起请求）
 */
export function useFilePreviewContent(
  filePath: () => string,
  context: () => ReadContext,
  enabled: () => boolean,
) {
  const { renderTrusted } = useMarkdown();

  const loading = ref(false);
  const error = ref('');
  const fileData = ref<FileData | null>(null);

  const path = computed(() => filePath());

  // 文件扩展名
  const ext = computed(() => {
    const parts = path.value.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  });

  const fileName = computed(() => path.value.split(/[/\\]/).pop() || path.value);

  // 是否为 HTML 文件
  const isHtml = computed(() => ['html', 'htm'].includes(ext.value));

  // 是否为 Office 文档（@vue-office 前端渲染域：docx/xlsx/pptx 家族）
  const isOffice = computed(() => OFFICE_EXTS.has(ext.value));

  // 是否为图片
  const isImage = computed(() => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext.value));

  // 是否为 Markdown
  const isMarkdown = computed(() => ext.value === 'md');

  // 显示语言标签
  const langLabel = computed(() => {
    const map: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript',
      py: 'Python', java: 'Java', rs: 'Rust', go: 'Go', rb: 'Ruby',
      php: 'PHP', swift: 'Swift', kt: 'Kotlin', cs: 'C#', scala: 'Scala',
      c: 'C', cpp: 'C++', cxx: 'C++', h: 'C/C++ Header', hpp: 'C++ Header',
      html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
      json: 'JSON', xml: 'XML', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
      md: 'Markdown', sql: 'SQL', sh: 'Bash', bash: 'Bash', ps1: 'PowerShell',
      abap: 'ABAP', vue: 'Vue', svelte: 'Svelte', txt: 'Text', log: 'Log',
      ini: 'INI', cfg: 'Config', env: 'Env', bat: 'Batch', cmd: 'Batch',
      docx: 'Word', xlsx: 'Excel', xlsm: 'Excel', pptx: 'PowerPoint',
    };
    return map[ext.value] || ext.value.toUpperCase() || 'Text';
  });

  // 图片 src
  const imageSrc = computed(() => {
    if (!fileData.value) return '';
    const d = fileData.value;
    if (d.binary && d.base64) {
      return `data:${d.contentType};base64,${d.content}`;
    }
    // SVG 是文本格式（binary=false），后端不返回 base64：将 XML 文本编码为 data URL
    if (ext.value === 'svg' && !d.binary) {
      try {
        const bytes = new TextEncoder().encode(d.content);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return `data:image/svg+xml;base64,${btoa(bin)}`;
      } catch {
        return `data:image/svg+xml;utf8,${encodeURIComponent(d.content)}`;
      }
    }
    return '';
  });

  // Office 文档渲染源：raw 直链 URL（@vue-office 三组件的 string src
  // 一律按 URL 取数〔excel 侧 XHR、docx 侧 fetch——base64 串会被当 URL
  // 请求〕，故传链不传 base64 载荷；组件经同源 raw 端点拉字节流，天然
  // 命中 HTTP 缓存。displayPath = 数据根命中回显的请求形路径）。
  const officeSrc = computed(() => {
    const d = fileData.value;
    if (!d) return '';
    const parts = ['path=' + encodeURIComponent(d.path || path.value)];
    const ctx = context();
    if (ctx.agentId) parts.push('agentId=' + encodeURIComponent(ctx.agentId));
    if (ctx.conversationId) parts.push('conversationId=' + encodeURIComponent(ctx.conversationId));
    return '/api/workspace/raw?' + parts.join('&');
  });

  // 代码高亮
  const highlightedCode = computed(() => {
    if (!fileData.value || fileData.value.binary || isHtml.value || isImage.value) return '';
    const lang = ext.value;
    void hljsLanguageVersion.value; // 响应式依赖：冷门语言补齐后重算高亮
    if (lang) void ensureHljsLanguage(lang);
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(fileData.value.content, { language: lang }).value;
      } catch { /* fallthrough */ }
    }
    // 转义 HTML
    return fileData.value.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  });

  // 按行切分高亮 HTML（wrap 态行号跟随的前提：行号/代码同行渲染，
  // 每行一段高亮 HTML）。跨行标签平衡：hljs 的 <span> 可跨行（块注释/
  // 模板串）——行尾闭合栈上开标签、行首重开，颜色在行边界无损延续。
  const highlightedLines = computed<string[]>(() => splitHighlightedHtml(highlightedCode.value));

  // HTML 预览内容：srcdoc 文档无自身 URL，相对路径按宿主页解析必 404
  //——改写相对引用为 raw 直链（按文件所在目录拼 + 读面上下文透传）、
  // 注入 base target（详见 htmlPreviewRefs.ts）。基准取回显 path
  //（displayPath：数据根命中 = 请求形，工作区推导 = 绝对路径），
  // 缺席回落请求路径。
  const previewHtml = computed(() => {
    const d = fileData.value;
    if (!d || !isHtml.value) return '';
    return preparePreviewHtml(d.content, d.path || path.value, context());
  });

  // Markdown 预览文档（沙箱 iframe srcdoc 用）：受信渲染（raw HTML 放行
  //——README 常带 <div align>/<img>/<details>，聊天实例会转义成字面文本）
  // + 相对引用改 raw 直链（与 HTML 预览同款）+ 内嵌调色板文档壳（iframe
  // 内无应用主题变量，亮暗随系统偏好）。文档整体进 sandbox iframe——
  // 不可信内容不进应用 DOM，与 HTML 预览同一安全基线。
  const previewMarkdownDoc = computed(() => {
    const d = fileData.value;
    if (!d || !isMarkdown.value) return '';
    void hljsLanguageVersion.value; // 响应式依赖：冷门语言补齐后重算
    const body = rewriteHtmlRefs(renderTrusted(d.content), dirOf(d.path || path.value), context());
    return markdownPreviewDoc(body);
  });

  // 行号（尾部空行滤除：源码常以 \n 结束，split 产生的末位空串不是真实行——
  // 保留会让行号列比代码多一行）
  const codeLines = computed(() => {
    if (!fileData.value || fileData.value.binary) return [];
    const lines = fileData.value.content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  });

  // 文件大小格式化
  const sizeDisplay = computed(() => {
    if (!fileData.value) return '';
    const bytes = fileData.value.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  });

  // 加载文件（请求序号守卫：pane 内 filePath 不变，守卫在 enabled
  // 翻转重载与组件卸载在途丢弃两个场景起作用）
  let loadSeq = 0;
  async function loadFile() {
    const p = path.value;
    if (!enabled() || !p) return;
    const seq = ++loadSeq;
    loading.value = true;
    error.value = '';
    fileData.value = null;
    // 候选路径：原路径（带 context——服务端数据根未命中时按会话/Agent
    // 工作区基准推导，M32）；404 且未带 files/ 前缀时本地回落
    // files/<agentId>/<p>（Agent 回复常写 note/xxx.md 之类相对路径）。
    // 预设/虚拟 ID（__standard__ 等）不参与回落——预设无 files 桶，
    // 猜测请求恒 404，只会在控制台刷错误。
    const ctx = context();
    const candidates: Array<string | { path: string; ctx?: ReadContext }> = [{ path: p, ctx }];
    const fid = ctx.agentId ?? '';
    if (fid && !/^files[/\\]/i.test(p) && !fid.startsWith('__')) {
      candidates.push(`files/${fid}/${p}`);
    }
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      try {
        const data = typeof c === 'string'
          ? await fetchWorkspaceFile(c)
          : await fetchWorkspaceFile(c.path, c.ctx);
        if (seq !== loadSeq) return; // 已作废：丢弃过期响应
        fileData.value = data as unknown as FileData;
        loading.value = false;
        return;
      } catch (err: any) {
        if (seq !== loadSeq) return;
        if (i === candidates.length - 1) {
          error.value = `加载失败: ${err.message}`;
        }
      }
    }
    if (seq === loadSeq) loading.value = false;
  }

  // 依赖驱动加载：mount 后 enabled 首次为真即取数（pane 常驻 v-show，
  // 挂载即 enabled 语义由消费方保证；immediate 覆盖初挂场景）
  if (getCurrentInstance()) {
    watch([path, enabled], () => { if (enabled() && path.value) void loadFile(); }, { immediate: true });
  }

  function invalidate() {
    loadSeq++; // 作废在途请求
    fileData.value = null;
    error.value = '';
    loading.value = false;
  }

  return {
    loading, error, fileData,
    ext, fileName, isHtml, isImage, isMarkdown, isOffice, langLabel,
    imageSrc, officeSrc, highlightedCode, highlightedLines, previewHtml, previewMarkdownDoc,
    codeLines, sizeDisplay, reload: loadFile, invalidate,
  };
}
