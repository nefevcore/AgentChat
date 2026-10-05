// ============================================================
// scripts/build-webui-preview.mjs —— 预览页 kit 片段注入（cr-121）
//
// 背景：预览页（原 v2.html 答辩版，已退役）过去手抄 webui-kit 的令牌与
// 组件样式（tokens/row/badge/BusyRing/CollapseRow/DockCard + starColor 星板）。
// 手抄必然漂移——评审看到的与源码不一致，「预览页看起来有焦点环、进源码后没有」
// 这类问题都出自这里。故把可机读的事实源改为注入：
//
//   /* @kit:base/tokens.css */  …  /* @end */     ← 从 kit 文件现读现填
//   /* @stars:starColor.ts */   …  /* @end */
//
// 页壳样式（预览页自己的布局/陈列）仍手写——那部分没有第二来源，不会漂移。
// 注入区以外的字节保持原样（含原有换行），故 diff 只落在标记区间内。
//
// 用法：node scripts/build-webui-preview.mjs            写入
//       node scripts/build-webui-preview.mjs --check    只校验（CI / 测试用）
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(repo, 'src/webui-kit/src');
// 单页注入：v2 答辩版已退役（被 gallery 取代），kit 标记区随页走
const PAGES = ['src/webui/design/gallery.html'].map((p) => join(repo, p));

/** kit 源文件 → 注入体（统一 LF，去掉尾部空行） */
const kitBody = (p) => readFileSync(p, 'utf8').split('\r\n').join('\n').trimEnd();

/** .vue 的 scoped 样式块（组件视觉的事实源）。页面是纯 HTML：需剥掉
    vue 专属的 :deep(...)（把后代选择器还原为普通选择器）。 */
function vueStyle(rel) {
  const src = readFileSync(join(KIT, rel), 'utf8');
  const i = src.indexOf('<style scoped>');
  const j = src.indexOf('</style>', i);
  if (i < 0 || j < 0) throw new Error('未找到 scoped 样式：' + rel);
  const body = src.slice(i + '<style scoped>'.length, j).split('\r\n').join('\n').trim();
  return stripDeep(body);
}

/** :deep(X) → X（含括号配平；X 内可再有括号） */
function stripDeep(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf(':deep(', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let depth = 0;
    let j = at + ':deep('.length - 1;
    for (; j < css.length; j += 1) {
      if (css[j] === '(') depth += 1;
      if (css[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out += css.slice(at + ':deep('.length, j);
    i = j + 1;
  }
  return out;
}

const isHexChar = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
function hexesIn(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const h = line.indexOf('#', i);
    if (h < 0) break;
    let j = h + 1;
    while (j < line.length && isHexChar(line[j])) j += 1;
    out.push(line.slice(h, j));
    i = j;
  }
  return out;
}
const triplet = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(", ");
};

/** 星色板（starColor.ts 是事实源；.sc-* 是预览页的呈现类名） */
function starBody() {
  const src = kitBody(join(KIT, 'starColor.ts'));
  const rules = [];
  let idx = 0;
  let user = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("{ nebula:")) {
      const [neb, aur] = hexesIn(line);
      const q = line.lastIndexOf("'");
      const q2 = line.lastIndexOf("'", q - 1);
      const label = line.slice(q2 + 1, q);
      rules.push({ cls: 'sc-' + idx, neb, aur, label });
      idx += 1;
    } else if (line.startsWith('const USER_STAR')) {
      const [neb, aur] = hexesIn(line);
      user = { cls: 'sc-user', neb, aur, label: '白金' };
    }
  }
  if (user) rules.push(user);
  const out = [];
  for (const r of rules) {
    out.push(`html[data-theme='nebula'] .${r.cls},html.dark .${r.cls}{--sc:${r.neb};--sc-rgb:${triplet(r.neb)};--tc:${r.neb};--tc-rgb:${triplet(r.neb)}} /* ${r.label} */`);
    out.push(`html[data-theme='aurora'] .${r.cls},html.light .${r.cls}{--sc:${r.aur};--sc-rgb:${triplet(r.aur)};--tc:${r.aur};--tc-rgb:${triplet(r.aur)}} /* ${r.label} */`);
  }
  return out.join('\n');
}

/** 把标记区间的内容替换为注入体（标记外字节不动） */
function inject(html, name, body) {
  const startTag = `/* @kit:${name} */`;
  const endTag = '/* @end */';
  const i = html.indexOf(startTag);
  if (i < 0) throw new Error('缺少注入标记（或在 @kit 前多加空格）：' + startTag);
  const j = html.indexOf(endTag, i);
  if (j < 0) throw new Error('标记缺 @end 收尾：' + startTag);
  return html.slice(0, i + startTag.length) + "\n" + body + "\n" + html.slice(j);
}

export function renderPreview(page = PAGES[0]) {
  let html = readFileSync(page, 'utf8');
  html = inject(html, 'base/tokens.css', kitBody(join(KIT, 'base/tokens.css')));
  html = inject(html, 'base/row.css', kitBody(join(KIT, 'base/row.css')));
  html = inject(html, 'base/badge.css', kitBody(join(KIT, 'base/badge.css')));
  html = inject(html, 'base/dropdown.css', kitBody(join(KIT, 'base/dropdown.css')));
  // L1 原语 / 工具组件 / 反馈层 / 浮层 / 星群 / cr-157 标准件：样式块逐段注入
  for (const rel of [
    'base/Button.vue', 'base/Avatar.vue', 'base/StatusDot.vue', 'base/Tooltip.vue',
    'base/RingProgress.vue', 'base/BusyRing.vue', 'base/CollapseRow.vue', 'base/DockCard.vue',
    'feedback/FeedbackNotice.vue', 'feedback/ToastHost.vue',
    'base/Modal.vue', 'base/Sheet.vue', 'base/PullToRefresh.vue',
    'star/StarAvatar.vue',
    'base/Chip.vue', 'base/IconAction.vue', 'base/Progress.vue', 'base/Breadcrumb.vue',
    'base/ConfirmBody.vue', 'base/OptionRow.vue', 'base/PickTag.vue',
    'base/Segmented.vue', 'base/Tabs.vue', 'base/DocTabs.vue', 'base/Select.vue', 'base/DatePicker.vue',
    'base/Input.vue', 'base/Textarea.vue', 'base/Checkbox.vue', 'base/Slider.vue',
    'base/FieldRow.vue', 'base/Label.vue', 'base/SearchInput.vue', 'base/PasswordInput.vue',
  ]) {
    html = inject(html, rel, vueStyle(rel));
  }
  html = html.replace('/* @stars:starColor.ts */', '/* @kit:starColor.ts */');
  html = inject(html, 'starColor.ts', starBody());
  return html;
}

function main() {
  const check = process.argv.includes('--check');
  let dirty = false;
  for (const page of PAGES) {
    const next = renderPreview(page);
    const cur = readFileSync(page, 'utf8');
    const same = cur.split('\r\n').join('\n') === next.split('\r\n').join('\n');
    if (check) {
      if (!same) {
        console.error(page + ' kit 片段与事实源不一致：node scripts/build-webui-preview.mjs 重新注入');
        process.exit(1);
      }
      continue;
    }
    if (!same) {
      // 页面工作区行尾跟随仓库风格（core.autocrlf=true → CRLF）：注入体是 LF，写回前统一
      writeFileSync(page, next.split('\r\n').join('\n').split('\n').join('\r\n'));
      dirty = true;
    }
  }
  console.log(check ? '预览页 kit 片段与事实源一致 ✓（' + PAGES.length + ' 页）'
    : dirty ? '预览页已注入：L0 四 css + starColor 星板 + 25 个组件样式块（含 cr-157 十二标准件：Chip/IconAction/Progress/Breadcrumb/ConfirmBody/Dropdown/OptionRow/PickTag/Segmented/Tabs/DocTabs + Avatar 角标/Sheet right）'
    : '预览页无需变更（已与事实源一致）');
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) main();
