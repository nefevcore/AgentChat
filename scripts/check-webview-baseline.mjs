// ============================================================
// check-webview-baseline.mjs —— webui 产物最低运行环境守门
//
// 基线：Chrome / Android WebView **92**（真机 Redmi K20 实测 92.0.4515.131）。
//
// 为什么需要守门：桌面与模拟器 Chromium 版本远新于真机，基线差异在那边永远看不见
// ——M3 真机验证 §1.1 连续踩了两层，都是同一根因「产物没声明最低运行环境」：
//   ① 运行时 API：esbuild（含 vite build.target）只降语法、不补 API，cordis 打包进的
//      Object.hasOwn（Chrome 93）→ 真机 `is not a function`，装配期白屏；
//   ② 语法面：esbuild 对 class static block **不降级、只警告**，须显式 supported 授意
//      → 真机 `SyntaxError: Unexpected token '{'`，整个 chunk 不执行。
//
// 三处同一份基线，改基线须三处同步：
//   ① src/webui/public/legacy-runtime.js      运行时垫片（补上即放行）
//   ② src/webui/vite.config.ts                build.target + esbuild.supported
//   ③ 本文件                                   构建期守门（API 面 + 语法面）
//
// 覆盖度判定：某 API「已垫片」= 垫片源码里 grep 得到它的**全名**（垫片里的 feature-detect
// 就写作 typeof <全名> !== 'function'）。故垫片与守门表不会各自漂移——声明垫了但没写，
// 这里立刻 fail。
//
// 用法：node scripts/check-webview-baseline.mjs   （webui:build 末尾自动执行）
// ============================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repo, 'src/webui/dist');
const indexPath = join(dist, 'index.html');
const assetsDir = join(dist, 'assets');
const SHIM = 'legacy-runtime.js';
const BASELINE_WEBVIEW = 92;

/** CSS 面 color-mix() 声明数上限（cr-38 棘轮，只减不增——同 dep-cycles.yml 纪律）
 *  基线 WebView 92 不解析 color-mix（Chrome 111+）：可静态表达者一律改写为
 *  rgba(var(--x-rgb), α)（tokens.css 三元组，语义等价）；无法表达者（动态内联色 /
 *  currentColor / 与非透明色混色）保留 color-mix 但必须在同属性前置静态回退声明。
 *  消化一处即下调本数；新写 color-mix 未经此路径 = 红。 */
const CSS_COLOR_MIX_CAP = 12;

if (!existsSync(indexPath)) {
  console.error(`[webview-baseline] 缺少 ${indexPath}——先跑 pnpm webui:build`);
  process.exit(1);
}

const fail = [];

// ---- 判据①：垫片在位，且执行语义确实早于应用代码 ----
// 判据是**语义**而非字面位置：module 脚本恒为 deferred（解析完才执行），而 classic
// 非 defer/async 脚本解析到即执行——故垫片在 body、入口 module 被 vite 提到 head
// （实测布局）时垫片仍先执行，位置无关。真正会垫不上的是：垫片自己被标成 module，
// 或带了 async/defer 而文档位置又在入口 module 之后（那才落入 defer 队列序列）。
const shimPath = join(dist, SHIM);
const shimSrc = existsSync(shimPath) ? readFileSync(shimPath, 'utf8') : '';
if (shimSrc === '') {
  fail.push(`垫片缺失：${SHIM} 未进 dist（应为 src/webui/public/${SHIM}）`);
} else {
  const html = readFileSync(indexPath, 'utf8');
  const tagAt = html.indexOf(`src="/${SHIM}"`);
  if (tagAt < 0) {
    fail.push(`垫片未接线：index.html 未引用 /${SHIM}`);
  } else {
    const tagStart = html.lastIndexOf('<script', tagAt);
    const tag = html.slice(tagStart, html.indexOf('>', tagAt) + 1);
    if (/type\s*=\s*"module"/.test(tag)) {
      fail.push(`垫片类型错：/${SHIM} 被标为 module（必须 classic，否则不先于应用代码求值）`);
    }
    const deferred = /\b(async|defer)\b/.test(tag);
    const entryAt = html.indexOf('<script type="module"');
    if (deferred && entryAt >= 0 && entryAt < tagAt) {
      fail.push(`垫片顺序错：/${SHIM} 带 async/defer 且排在入口 module 之后——落入 defer 队列后被应用代码抢先`);
    }
  }
}

// ---- 判据②：产物不得含「基线之上且未垫片」的运行时 API ----
// 新增依赖引入新 API 时在此 fail，而不是等真机白屏。
const ABOVE_BASELINE_API = [
  { api: 'Object.hasOwn', since: 93, probe: /\bObject\.hasOwn\b/g },
  { api: 'Object.groupBy', since: 117, probe: /\bObject\.groupBy\b/g },
  { api: 'structuredClone', since: 98, probe: /\bstructuredClone\b/g },
  { api: 'AbortSignal.timeout', since: 103, probe: /\bAbortSignal\.timeout\b/g },
  { api: 'AbortSignal.any', since: 116, probe: /\bAbortSignal\.any\b/g },
  { api: 'Promise.withResolvers', since: 119, probe: /\bPromise\.withResolvers\b/g },
  { api: 'Array.fromAsync', since: 121, probe: /\bArray\.fromAsync\b/g },
  { api: 'Array.prototype.findLast', since: 97, probe: /\.findLast\(/g },
  { api: 'Array.prototype.findLastIndex', since: 97, probe: /\.findLastIndex\(/g },
  { api: 'Array.prototype.toSorted', since: 110, probe: /\.toSorted\(/g },
  { api: 'Array.prototype.toReversed', since: 110, probe: /\.toReversed\(/g },
  { api: 'Array.prototype.toSpliced', since: 110, probe: /\.toSpliced\(/g },
  { api: 'Array.prototype.with', since: 110, probe: /\.with\(/g },
  { api: 'String.prototype.isWellFormed', since: 111, probe: /\.isWellFormed\(/g },
  { api: 'URL.canParse', since: 120, probe: /\bURL\.canParse\b/g },
  { api: 'Set.prototype.union', since: 122, probe: /\.union\(/g },
];

// ---- 判据③：语法面（esbuild 的 target 只管到它能降的那些） ----
// class static block 是典型：esbuild 不降级、只警告，须在 vite.config.ts 里
// esbuild.supported['class-static-block'] = false 才转成类定义后的 IIFE。
// 语法错误比 API 缺失更彻底——整块 chunk 直接不执行。
const ABOVE_BASELINE_SYNTAX = [
  { name: 'class static block', since: 94, probe: /static\s*\{/g },
  { name: 'import attributes (with { type: })', since: 123, probe: /\bwith\s*\{\s*type\s*:/g },
  { name: 'import assertions (assert { type: })', since: 91, probe: /\bassert\s*\{\s*type\s*:/g },
];

if (existsSync(assetsDir)) {
  const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  for (const { api, since, probe } of ABOVE_BASELINE_API) {
    if (shimSrc.includes(api)) continue; // 垫片已覆盖
    for (const f of bundles) {
      const n = (readFileSync(join(assetsDir, f), 'utf8').match(probe) || []).length;
      if (n > 0) {
        fail.push(
          `超基线 API ${api}（Chrome ${since}+）出现在 ${f} ×${n}——` +
            `WebView ${BASELINE_WEBVIEW} 上不存在：先在 src/webui/public/${SHIM} 补垫片` +
            '（feature-detect 写全名，守门按全名判定覆盖）',
        );
      }
    }
  }
  for (const { name, since, probe } of ABOVE_BASELINE_SYNTAX) {
    for (const f of bundles) {
      const n = (readFileSync(join(assetsDir, f), 'utf8').match(probe) || []).length;
      if (n > 0) {
        fail.push(
          `超基线语法 ${name}（Chrome ${since}+）出现在 ${f} ×${n}——` +
            'esbuild 不会自动降级该语法：改 vite.config.ts 的 esbuild.supported 授意降级，或改源码回避',
        );
      }
    }
  }

  // ---- 判据④：CSS 面——color-mix()（Chrome 111）基线不解析（cr-38） ----
  // 静态可表达者改写为 rgba(var(--x-rgb), α)；无法表达者保留但须有静态回退。
  // 棘轮：只减不增（消化一处即下调 CSS_COLOR_MIX_CAP）。
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
  let cmTotal = 0;
  for (const f of cssFiles) {
    cmTotal += (readFileSync(join(assetsDir, f), 'utf8').match(/color-mix\(/g) || []).length;
  }
  if (cmTotal > CSS_COLOR_MIX_CAP) {
    fail.push(
      `超基线 CSS color-mix()（Chrome 111+）产物出现 ${cmTotal} 处，上限 ${CSS_COLOR_MIX_CAP}——` +
        '静态可表达者改写 rgba(var(--x-rgb), α)（三元组令牌住 tokens.css）；' +
        '确无三元组可用者须在**同属性**前置一条静态回退声明（渐进增强），再上调本上限',
    );
  } else if (cmTotal < CSS_COLOR_MIX_CAP) {
    console.log(
      `[webview-baseline] CSS color-mix 已降到 ${cmTotal} 处（上限仍记 ${CSS_COLOR_MIX_CAP}）——` +
        '按棘轮纪律请下调 CSS_COLOR_MIX_CAP',
    );
  }
} else {
  fail.push(`缺少 ${assetsDir}——产物结构异常`);
}

if (fail.length > 0) {
  console.error('[webview-baseline] 未通过（基线 WebView ' + BASELINE_WEBVIEW + '）：');
  for (const f of fail) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('[webview-baseline] 通过：垫片在位且语义先于应用代码；产物无未垫片的超基线 API，无未降级语法（基线 WebView ' + BASELINE_WEBVIEW + '）');
