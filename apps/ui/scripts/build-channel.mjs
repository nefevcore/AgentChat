// ============================================================
// build-channel.mjs —— 通道模块唯一构建器（cr-927 webui-v3 切片① v3 形态；
// docs/design/webui-v3.md §4.5 产物与构建）
//
// 两种形态（同一脚本，cutover 收敛为一）：
//   v3（缺省，本档产物位）：<pkg>/client/dist/ —— factory 注册 bundle
//     （window.__ModuleLoader__.load({id, factory})，模块体副作用全延迟到
//     首物化）+ revision 清单 manifest.json（rev = 内容哈希；宿主只读不算）。
//     isolated:true 自含档（不外部化种子——bundle 自带 vue 等依赖，
//     §4.6 裁决八）；缺省外部化宿主模块表（纯度门：产物剩余 require ⊆
//     宿主模块表，违例 fail-loud）。
// ============================================================
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_MODULE_SPECS } from './host-module-table.ts';

const pkgRoot = fileURLToPath(new URL('../../../packages', import.meta.url));
// 仓库根（脚本在 <root>/apps/ui/scripts/——CWD 无关锚点；3 级上行）
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const repoUiDir = fileURLToPath(new URL('..', import.meta.url)); // apps/ui（壳）
// 包族前缀 = 行类型词形（仓库既有约定，gen-webui-base / seats-audit 同款）：
// ac-client-ui-* = 前端行（factory bundle）；ac-client-theme-* = 主题包
//（纯样式行，cr-936）。判定取舍：按声明（ac.faces.web 在场）全扫包根亦可，
// 但前缀族是各消费面的同一约定——沿用前缀，避免把种子/宿主类包的其他
// ac 声明误纳入构建面
const PKG_PREFIXES = ['ac-client-ui-', 'ac-client-theme-'];

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));

const webFaceOf = (dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  const web = pkg.ac?.faces?.web;
  // v3 两形态（cr-936）：entry 行（factory bundle）或 theme 行（纯样式——
  // theme id + styles 声明，无 entry）
  const hasFace = web !== undefined && web !== null && typeof web === 'object'
    && ((typeof web.entry === 'string' && web.entry !== '') || typeof web.theme === 'string');
  return hasFace ? { pkg, web } : null;
};

const modules = readdirSync(pkgRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && PKG_PREFIXES.some((p) => e.name.startsWith(p)))
  .map((e) => {
    const prefix = PKG_PREFIXES.find((p) => e.name.startsWith(p));
    return { short: e.name.slice(prefix.length), dir: join(pkgRoot, e.name), pureStyle: prefix === 'ac-client-theme-' };
  })
  .filter(({ short, dir }) => webFaceOf(dir) !== null && (only.length === 0 || only.includes(short)));
const builtModules = modules.filter((m) => !m.pureStyle);

if (modules.length === 0) { console.error('[build-channel] 无匹配通道包（ac.faces.web 声明缺席）'); process.exit(1); }

const isExternal = (id) => HOST_MODULE_SPECS.some((x) => id === x || id.startsWith(x + '/'));

const viteCommon = (entry) => ({
  configFile: false,
  plugins: [vue(), Icons({ compiler: 'vue3' })],
  resolve: {
    alias: { '@agentchat/protocol': fileURLToPath(new URL('../src/shims/@agentchat/protocol.ts', import.meta.url)) },
  },
  build: {
    // 通道模块 target = esnext（跳过 esbuild 降级路径——Windows esbuild renderChunk
    // 临时文件删除偶发 Access denied；chrome92 降级归 8.5e 构建面统一处理）
    target: 'esnext',
    minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: isExternal },
  },
});

// ---------------- v3 形态（缺省：factory 注册 + revision 清单） ----------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 通道行包判定（有 ac.faces.web 的 ac-client-ui-*——wire 行而非种子） */
function isChannelPkg(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, root, 'package.json'), 'utf-8'));
    return pkg.ac?.faces?.web !== undefined;
  } catch {
    return false;
  }
}

/** 产物 require 说明符（cjs 形）——纯度门与 seeds 记录的输入。
 *  原生动态 import('X') 同收（cr-930 补丁面）：外部化深词的动态引用
 *  在第二遍才归一为 require——词收集须两形同源，否则他行 __deep 面漏词。 */
function requireSpecs(text) {
  const specs = new Set();
  for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  return [...specs].filter((s) => !s.startsWith('.') && !s.startsWith('/'));
}

/** 说明符根包名（@scope/name 或 name；子路径归包） */
const rootSpec = (s) => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];

/** 种子词版本区间：壳（apps/ui）在位版本 ^major.minor（§4.4 主版本对拍轴
 * ——种子实例归壳，版本从壳解析而非行包） */
function seedRange(shellDir, spec) {
  try {
    const req = createRequire(join(shellDir, 'package.json')); // apps/ui（壳依赖面）
    // exports 不暴露 ./package.json 的包：resolve 入口后上溯最近 package.json
    let pkgPath;
    try {
      pkgPath = req.resolve(spec + '/package.json');
    } catch {
      let dir = req.resolve(spec);
      for (;;) {
        const candidate = join(dir, 'package.json');
        if (existsSync(candidate)) { pkgPath = candidate; break; }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    }
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const v = String(pkgJson.version ?? '');
    const m = /^(\d+)\.(\d+)/.exec(v);
    return m === null ? '^' + v : '^' + m[1] + '.' + m[2];
  } catch {
    return undefined;
  }
}

// ---- 纯样式档（cr-936 主题包）：源样式拷贝产物位 + 同款哈希框式 revision 清单 ----
// 产物 = client/dist 内声明样式文件的拷贝（无 bundle 构建面）；声明词形
// ./client/dist/<name>，源 = client/<name> 同名（与 entry 行 client/index.ts
// → client/dist/index.js 的源/产物位约定同构）
for (const { short, dir } of modules.filter((m) => m.pureStyle)) {
  const { web } = webFaceOf(dir);
  const distDir = join(dir, 'client', 'dist');
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  console.log('[build-channel] ' + short + ' → client/dist（纯样式拷贝档）');
  const styleNames = [];
  for (const declared of web.styles ?? []) {
    const name = String(declared).replace(/^\.\/client\/dist\//, '');
    if (!existsSync(join(dir, 'client', name))) {
      console.error('[build-channel] ' + short + ' 样式源缺席：client/' + name);
      process.exit(1);
    }
    copyFileSync(join(dir, 'client', name), join(distDir, name));
    styleNames.push(name);
  }
  // revision 清单：与 factory 档同款哈希框式（files 表在 manifest.json 落盘前
  // 计算——表内天然只含样式产物）；entry 缺席 = 纯样式行（wire 合成面词）
  const files = {};
  for (const name of readdirSync(distDir).sort()) {
    const buf = readFileSync(join(distDir, name));
    files[name] = { hash: sha256(buf).slice(0, 16), size: buf.length };
  }
  const hash = createHash('sha256').update(String(webFaceOf(dir).pkg.name));
  for (const [name, meta] of Object.entries(files)) {
    hash.update(String(meta.size) + ':' + name + ':' + meta.hash);
  }
  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify({
    rev: hash.digest('hex').slice(0, 16),
    builtAt: Date.now(),
    ...(styleNames.length > 0 ? { styles: styleNames } : {}),
    files,
  }, null, 2) + String.fromCharCode(10), 'utf-8');
  const now = new Date();
  try { utimesSync(distDir, now, now); } catch { /* 首建由 mkdir 落 mtime */ }
}

// ---- 第一遍：裸构建（无深导出）+ 全局 require 词收集 ----
const globalRequires = new Map(); // 根包名 -> Set<深说明符>（他行对本包的深引）
for (const { dir } of builtModules) {
  const distDir = join(dir, 'client', 'dist');
  const srcEntry = join(dir, 'client', 'index.ts');
  if (!existsSync(srcEntry)) { console.error('[build-channel] ' + dir + '：client/index.ts 源入口缺席'); process.exit(1); }
  await build({
    configFile: false,
    plugins: [vue(), Icons({ compiler: 'vue3' })],
    resolve: { alias: { '@agentchat/protocol': fileURLToPath(new URL('../src/shims/@agentchat/protocol.ts', import.meta.url)) } },
    build: {
      outDir: distDir, emptyOutDir: true, target: 'esnext', minify: false,
      lib: { entry: srcEntry, formats: ['cjs'], fileName: () => 'index.js' },
      rollupOptions: { external: isExternal, output: { inlineDynamicImports: true } },
    },
  });
  for (const spec of requireSpecs(readFileSync(join(distDir, 'index.js'), 'utf-8'))) {
    const root = rootSpec(spec);
    if (root === spec || !isChannelPkg(root)) continue;
    if (!globalRequires.has(root)) globalRequires.set(root, new Set());
    globalRequires.get(root).add(spec);
  }
}

// ---- 第二遍：深导出合成 entry 重建 ----
for (const { short, dir } of builtModules) {
  const { pkg, web } = webFaceOf(dir);
  const distDir = join(dir, 'client', 'dist');
  const srcEntry = join(dir, 'client', 'index.ts');
  const selfContained = web.isolated === true; // 裁决八：isolated 档不外部化种子
  console.log('[build-channel] ' + short + ' → client/dist（' + (selfContained ? 'isolated 自含档' : '外部化宿主模块表 ' + HOST_MODULE_SPECS.length + ' 键') + '）');
  // 深导出面（cr-930 裁决）：宿主模块表深词 ∪ 全局他行深引词（前缀外部化
  // 的显式对账——裸构建扫描防清单漂移）→ __deep 面
  const deepSpecs = [...new Set([
    ...HOST_MODULE_SPECS.filter((x) => rootSpec(x) === pkg.name && x !== pkg.name && x !== pkg.name + '/client'),
    ...(globalRequires.get(pkg.name) ?? []),
  ])];
  const tmpEntry = join(distDir, '..', '__v3-entry.mjs');
  const entryCode = deepSpecs.length === 0
    ? 'import plugin from ' + JSON.stringify(srcEntry) + ';' + String.fromCharCode(10) + 'export default plugin;' + String.fromCharCode(10)
    : 'import plugin from ' + JSON.stringify(srcEntry) + ';' + String.fromCharCode(10)
      + deepSpecs.map((x, i) => 'import * as m' + i + ' from ' + JSON.stringify(x) + ';').join(String.fromCharCode(10))
      + String.fromCharCode(10) + 'export default plugin;' + String.fromCharCode(10)
      + 'export const __deep = { ' + deepSpecs.map((x, i) => JSON.stringify(x) + ': m' + i).join(', ') + ' };' + String.fromCharCode(10);
  writeFileSync(tmpEntry, entryCode, 'utf-8');
  await build({
    configFile: false,
    plugins: [vue(), Icons({ compiler: 'vue3' })],
    resolve: { alias: { '@agentchat/protocol': fileURLToPath(new URL('../src/shims/@agentchat/protocol.ts', import.meta.url)) } },
    build: {
      outDir: distDir, emptyOutDir: true, target: 'esnext', minify: false,
      lib: { entry: tmpEntry, formats: ['cjs'], fileName: () => 'index.js' },
      rollupOptions: {
        ...(selfContained ? {} : { external: isExternal }),
        // interop: 'auto'（crash-hardening 批实锤修复）：外部化说明符的默认
        // 导入（跨包 .vue 组件词）须生成 .default 读取——运行时模块表深词
        // 存的是命名空间对象（ESM 形）。缺省（'default' 档）rollup 视外部
        // 模块为 CJS 直接透传 require 结果 = 命名空间当组件用 →
        // "Component is missing template or render function" 静默空渲染
        //（2026-11-07 会话面板空白事故根因）。
        output: { inlineDynamicImports: true, interop: 'auto' },
      },
    },
  });
  rmSync(tmpEntry, { force: true });

  // factory 注册包裹：模块体副作用全延迟到首物化（§4.4 lazy CJS——bundle
  // 执行只注册工厂，CSS 注入等随物化）
  let raw = readFileSync(join(distDir, 'index.js'), 'utf-8');
  // 原生动态 import 归一（cr-930 补丁面）：rollup 对外部化说明符的动态
  // import 保留原生 import('X') 词形——浏览器经典 script 无 importmap（裁
  // 决二退役），裸说明符 native import 必炸（defineAsyncComponent 跨行
  // 深引即此形）。v3 唯一解析面 = 模块系统 require（种子①支/深导出面）
  // ——产物级改写为 require 的 Promise 面（require 在 factory 包裹器作用域）。
  raw = raw.replace(
    /import\(\s*(["'])([^"'\n]+)\1\s*\)/g,
    (all, _q, spec) => (spec.startsWith('.') || spec.startsWith('/')) ? all
      : isExternal(spec)
        ? 'Promise.resolve().then(function () { return require(' + JSON.stringify(spec) + '); })'
        : all,
  );
  const wrapped = 'window.__ModuleLoader__.load({' + String.fromCharCode(10)
    + '  id: ' + JSON.stringify(pkg.name) + ',' + String.fromCharCode(10)
    + '  factory: (require) => {' + String.fromCharCode(10)
    + '    const module = { exports: {} };' + String.fromCharCode(10)
    + '    (function (module, exports, require) {' + String.fromCharCode(10)
    + raw
    + String.fromCharCode(10) + '    })(module, module.exports, require);' + String.fromCharCode(10)
    + '    return module.exports && typeof module.exports === ' + JSON.stringify('object') + ' && ' + JSON.stringify('default') + ' in module.exports' + String.fromCharCode(10)
    + '      ? module.exports : { default: module.exports };' + String.fromCharCode(10)
    + '  },' + String.fromCharCode(10)
    + '});' + String.fromCharCode(10);
  writeFileSync(join(distDir, 'index.js'), wrapped, 'utf-8');

  // 纯度门（cjs 面）：产物剩余 require ⊆ 宿主模块表；isolated 自含档 = 空。
  // 动态 import 同门（cr-930 补丁面）：改写后残留的裸说明符 native import
  //（非外部化词 = 归一失败）= 违例——防漂移。
  const specs = requireSpecs(wrapped);
  const nativeImports = [...wrapped.matchAll(/import\(\s*(["'])([^"'\n]+)\1\s*\)/g)]
    .map((m) => m[2])
    .filter((x) => !x.startsWith('.') && !x.startsWith('/'));
  const offenders = selfContained
    ? [...specs.filter((x) => !x.startsWith('node:')), ...nativeImports]
    : [...specs.filter((x) => !isExternal(x)), ...nativeImports];
  if (offenders.length > 0) {
    console.error('[build-channel] ' + short + ' 外部化门违例（宿主模块表未覆盖）：' + String.fromCharCode(10) + '  ' + offenders.join(String.fromCharCode(10) + '  '));
    process.exit(1);
  }

  // revision 清单：rev = files 哈希的框式聚合（跨文件边界不可移字节）
  const files = {};
  for (const name of readdirSync(distDir).sort()) {
    const buf = readFileSync(join(distDir, name));
    files[name] = { hash: sha256(buf).slice(0, 16), size: buf.length };
  }
  const hash = createHash('sha256').update(pkg.name);
  for (const [name, meta] of Object.entries(files)) {
    hash.update(String(meta.size) + ':' + name + ':' + meta.hash);
  }
  const seeds = {};
  for (const spec of new Set(specs.map(rootSpec))) {
    if (isChannelPkg(spec)) continue;
    const range = seedRange(repoUiDir, spec);
    if (range !== undefined) seeds[spec] = range;
  }
  const manifest = {
    rev: hash.digest('hex').slice(0, 16),
    builtAt: Date.now(),
    entry: 'index.js',
    ...(existsSync(join(distDir, 'style.css')) ? { styles: ['style.css'] } : {}),
    ...(Object.keys(seeds).length > 0 ? { seeds } : {}),
    files,
  };
  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + String.fromCharCode(10), 'utf-8');
  const now = new Date();
  try { utimesSync(distDir, now, now); } catch { /* 首建由 mkdir 落 mtime */ }
}
console.log('[build-channel] 完成（v3 形态：factory ' + builtModules.length + ' + 纯样式 ' + (modules.length - builtModules.length) + '）→ 各包 client/dist');
