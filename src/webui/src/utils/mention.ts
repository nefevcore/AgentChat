// ============================================================
// utils/mention.ts —— 输入框快捷输入触发检测纯函数
//
// 触发规则（DSH 同款直觉 + 多语义分身）：
//   · 触发符出现在行首，或前一字符是空白（空格/换行）——行中 URL
//     （https://…）、路径（a/b）、邮箱（a@b）不误触发；
//   · / = 命令与技能；@ = 文件/目录/Agent；# = 历史会话（Slack 心智：
//     @=对象引用、#=频道/主题——Agent 名与会话标题词法不撞车）；
//   · 触发符到光标之间的"查询词"继续匹配字符集则弹层存活并作为过滤词；
//     超出字符集即判定用户已离开快捷输入，弹层关闭——@/# 的查询词
//     允许任意非空白字符（文件名/标题可含中文）。
//   · 同一时刻最多一个活跃触发；输入区之外的编辑（粘贴大段文本）由
//     调用方以 caret 参数自然裁决（token 必须恰好结束于光标处）。
// ============================================================

/** 快捷输入触发态：kind + 触发符位置 + 过滤词 */
export interface MentionTrigger {
  kind: 'slash' | 'at' | 'hash';
  /** 触发符（/ 或 @ 或 #）在文本中的下标 */
  start: number;
  /** 触发符之后的过滤词（触发符到光标的原文） */
  query: string;
}

/** / 触发的过滤词字符集：命令与技能名（kebab-case / 英数） */
const SLASH_QUERY_RE = /^[A-Za-z0-9_-]*$/;

/**
 * 检测光标处是否处于快捷输入 token 内。
 * 返回 null = 无活跃触发（弹层应关闭）。
 */
export function detectMention(text: string, caret: number): MentionTrigger | null {
  if (caret <= 0 || caret > text.length) return null;
  // 从光标向左找触发符：越过查询词允许的字符才可能命中
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined) return null;
    if (ch === '/' || ch === '@' || ch === '#') break;
    // 查询词内不允许空白（空格 = 用户已离开快捷输入）
    if (/\s/.test(ch)) return null;
    i--;
  }
  if (i < 0) return null;
  const trigger = text[i];
  // token 必须结束于光标处：光标后还有续词字符 = 光标停在 token 中间，不触发
  const after = text[caret];
  if (after !== undefined && !/\s/.test(after)) return null;
  const before = i > 0 ? text[i - 1] : '';
  // 行首或前一字符是空白才触发（https://、a/b、a@b 不触发）
  if (i > 0 && !/\s/.test(before)) return null;
  const query = text.slice(i + 1, caret);
  if (trigger === '/') {
    // 命令/技能过滤词限定英数与 -_（中文命令暂无）
    if (!SLASH_QUERY_RE.test(query)) return null;
    return { kind: 'slash', start: i, query };
  }
  if (trigger === '@') return { kind: 'at', start: i, query };
  return { kind: 'hash', start: i, query };
}

/**
 * 选中条目后替换 token：把 [start, caret) 的触发符+过滤词替换为插入文本。
 * 返回新文本（调用方自行把光标移到末尾）。
 */
export function replaceMentionToken(text: string, start: number, caret: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(caret);
}

/** 大小写不敏感的包含匹配（过滤词匹配 label/hint） */
export function mentionMatches(label: string, query: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query.toLowerCase());
}

// ============================================================
// 语义化高亮分词（输入框 overlay 渲染）：把草稿文本里的快捷输入 token
// 切成带 kind 的区间——/技能手势（与后端 SKILL_GESTURE 同款正则）、
// @ 文件/Agent 引用、# 会话引用。纯展示用：textarea 值仍是字面文本，
// 复制/发送/编辑零变化。
// ============================================================

/** token 语义类别（决定芯片颜色） */
export type HighlightKind = 'skill' | 'file' | 'agent' | 'session';

/** 文本区间 [start, end) 的一个语义 token */
export interface HighlightToken {
  start: number;
  end: number;
  kind: HighlightKind;
}

/** /name 技能手势（与后端 SKILL_GESTURE 同款：空白为界 kebab-case；
 *  行中 https:// 的 // 不命中——/ 前必须行首或空白；kebab 字符集天然
 *  不吞中文标点） */
const SKILL_TOKEN_RE = /(^|\s)(\/[a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
/** @ 引用：@"含空格路径"（引号可未闭合=输入中）或 @非空白非引号串 */
const AT_TOKEN_RE = /(^|\s)(@(?:"[^"\n]*"?|[^\s"]+))/g;
/** # 会话引用：#非空白串（体首字符排除 #——markdown 标题 ## 不误染） */
const HASH_TOKEN_RE = /(^|\s)(#[^\s#]+)/g;

/** 中文无空格分界：token 粘连后文的截断点（首个中文标点即止；ASCII
 *  标点不截——路径/文件名里的 . - _ ( ) 等是合法字符，显示层不误伤） */
const CJK_PUNCT_RE = /[，。！？；：、【】（）《》「』"'"'》]/;

/** token 本体在首个中文标点处截断（纯显示层语义；引号形态不截） */
function cutAtCjkPunct(body: string): string {
  const m = CJK_PUNCT_RE.exec(body);
  return m ? body.slice(0, m.index) : body;
}

/**
 * 切出草稿文本里的全部语义 token（按 start 升序）。
 * @ 引用的 kind 判定：引号形态或含路径分隔符（/ \ :）→ file，其余 → agent。
 * 中文无空格分界：`@张三，过来` → token=`@张三`（首个中文标点截断）；
 * `#周报(sid-1)，看` → token=`#周报(sid-1)`。
 */
export function tokenizeMentionHighlights(text: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    const lead = (m[1] ?? '').length;
    const start = (m.index ?? 0) + lead;
    tokens.push({ start, end: start + (m[2] ?? '').length, kind: 'skill' });
  }
  for (const m of text.matchAll(AT_TOKEN_RE)) {
    const lead = (m[1] ?? '').length;
    const start = (m.index ?? 0) + lead;
    const matched = m[2] ?? '';
    // 引号形态原样（显式引用）；裸形态在首个中文标点截断
    const raw = matched.startsWith('@"')
      ? matched
      : `@${cutAtCjkPunct(matched.slice(1))}`;
    if (raw.length < 2) continue; // 只剩 @ 本身（标点紧随）
    const body = raw.slice(1);
    const kind: HighlightKind = raw.startsWith('@"') || /[\/\\:]/.test(body) ? 'file' : 'agent';
    tokens.push({ start, end: start + raw.length, kind });
  }
  for (const m of text.matchAll(HASH_TOKEN_RE)) {
    const lead = (m[1] ?? '').length;
    const start = (m.index ?? 0) + lead;
    const raw = `#${cutAtCjkPunct((m[2] ?? '').slice(1))}`;
    if (raw.length < 2) continue;
    tokens.push({ start, end: start + raw.length, kind: 'session' });
  }
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

/** overlay 渲染段：token 段带 kind，其余为纯文本段 */
export interface HighlightSegment {
  text: string;
  kind?: HighlightKind;
}

/** 文本 → 交替的纯文本/token 段（渲染层逐段 <span>，不经 v-html） */
export function buildHighlightSegments(text: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const token of tokenizeMentionHighlights(text)) {
    if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start) });
    segments.push({ text: text.slice(token.start, token.end), kind: token.kind });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

// ============================================================
// 文件引用插入格式（DSH formatFileMention 移植）——与 ac-fs-tools 的
// [引用约定]（"含空格形如 @"路径"，目录以尾斜杠标识"）同语法：
//   · 含空白 → 引号形态 @"path"（目录保持引号开 = 补全可继续下钻）；
//   · 目录补尾斜杠 /（read 目录即列表）；
//   · 控制字符/内嵌引号 → null（编辑器语法无法安全表示，不插入）。
// ============================================================

/** 文件引用候选（文件或目录） */
export interface FileMentionCandidate {
  path: string;
  kind: 'file' | 'directory';
}

/**
 * 选中文件/目录 → 插入文本（@token，不带尾随空格——调用方自行补）。
 * 无法安全表示（控制字符/内嵌引号）→ null。
 */
export function formatFileMention(candidate: FileMentionCandidate, preserveQuote = false): string | null {
  const path = candidate.kind === 'directory' ? `${candidate.path.replace(/[\\/]+$/, '')}/` : candidate.path;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return null;
  const quoted = preserveQuote || /\s/u.test(path);
  if (!quoted) return `@${path}`;
  if (candidate.kind === 'directory') return `@"${path}`;
  return `@"${path}"`;
}
