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
//   旧 ES 形态（--out，切片③ §4.9 退役）：沙箱/出厂拷贝链投影——dev 数据
//     根隔离红线恒 sandbox/ 下；仅 build-bundle 出厂链在用。
// ============================================================
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_MODULE_SPECS } from './host-module-table.ts';

const pkgRoot = fileURLToPath(new URL('../../../packages', import.meta.url));
// 仓库根（脚本在 <root>/apps/ui/scripts/——CWD 无关锚点；3 级上行）
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const repoUiDir = fileURLToPath(new URL('..', import.meta.url)); // apps/ui（壳）
const PKG_PREFIX = 'ac-client-ui-';

const args = process.argv.slice(2);
let outDir = null; // null = v3 形态（包内 client/dist）
const only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = resolve(repoRoot, args[++i]);
  else only.push(args[i]);
}

const webFaceOf = (dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  const web = pkg.ac?.faces?.web;
  return web !== undefined && typeof web.entry === 'string' && web.entry !== ''
    ? { pkg, web } : null;
};

const modules = readdirSync(pkgRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith(PKG_PREFIX))
  .map((e) => ({ short: e.name.slice(PKG_PREFIX.length), dir: join(pkgRoot, e.name) }))
  .filter(({ short, dir }) => webFaceOf(dir) !== null && (only.length === 0 || only.includes(short)));

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

if (outDir !== null) {
  // ---------------- 旧 ES 形态（--out：出厂/沙箱拷贝链投影；切片③退役） ----------------
  for (const { short, dir } of modules) {
    const { pkg, web } = webFaceOf(dir);
    const target = join(outDir, short);
    mkdirSync(join(target, 'ui'), { recursive: true });
    console.log('[build-channel] ' + short + ' → ' + target + '（旧 ES 形态，external: 宿主模块表 ' + HOST_MODULE_SPECS.length + ' 键）');
    await build({ ...viteCommon(resolve(dir, web.entry)), outDir: join(target, 'ui'), emptyOutDir: true });
    const bundle = readFileSync(join(target, 'ui', 'index.js'), 'utf-8');
    const specs = new Set();
    for (const m of bundle.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
    for (const m of bundle.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
    const offenders = [...specs].filter((s) => !s.startsWith('.') && !s.startsWith('/') && !isExternal(s));
    if (offenders.length > 0) {
      console.error('[build-channel] ' + short + ' 外部化门违例（宿主模块表未覆盖，已被打包进产物或不可解析）：\n  ' + offenders.join('\n  '));
      process.exit(1);
    }
    const out = {
      name: short,
      version: String(pkg.version ?? '0.0.0'),
      entry: 'ui/index.js',
      platform: 'web',
      ...(Array.isArray(web.seats) && web.seats.length > 0 ? { seats: web.seats.map((s) => ({ seat: s })) } : {}),
      isolated: web.isolated !== false,
    };
    if (existsSync(join(target, 'ui', 'style.css'))) out.styles = ['ui/style.css'];
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(out, null, 2) + '\n', 'utf-8');
  }
  // 触发宿主 boot-graph 缓存失效（cr-893）：touch 目录 mtime
  const now = new Date();
  for (const { short } of modules) {
    try { utimesSync(join(outDir, short), now, now); } catch { /* 首建由 mkdir 落 mtime */ }
  }
  console.log('[build-channel] 完成（旧形态）' + modules.length + ' 模块 → ' + outDir);
  process.exit(0);
}

// ---------------- v3 形态（缺省：factory 注册 + revision 清单） ----------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 产物 require 说明符（cjs 形）——纯度门与 seeds 记录的输入 */
function requireSpecs(text) {
  const specs = new Set();
  for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
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

for (const { short, dir } of modules) {
  const { pkg, web } = webFaceOf(dir);
  const distDir = join(dir, 'client', 'dist');
  const srcEntry = join(dir, 'client', 'index.ts');
  if (!existsSync(srcEntry)) {
    console.error('[build-channel] ' + short + '：client/index.ts 源入口缺席（v3 形态源约定）');
    process.exit(1);
  }
  const selfContained = web.isolated === true; // 裁决八：isolated 档不外部化种子
  console.log('[build-channel] ' + short + ' → client/dist（' + (selfContained ? 'isolated 自含档' : '外部化宿主模块表 ' + HOST_MODULE_SPECS.length + ' 键') + '）');
  await build({
    configFile: false,
    plugins: [vue(), Icons({ compiler: 'vue3' })],
    resolve: {
      alias: { '@agentchat/protocol': fileURLToPath(new URL('../src/shims/@agentchat/protocol.ts', import.meta.url)) },
    },
    build: {
      outDir: distDir,
      emptyOutDir: true,
      target: 'esnext',
      minify: false,
      lib: { entry: srcEntry, formats: ['cjs'], fileName: () => 'index.js' },
      rollupOptions: {
        ...(selfContained ? {} : { external: isExternal }),
        output: { inlineDynamicImports: true },
      },
    },
  });

  // factory 注册包裹：模块体副作用全延迟到首物化（§4.4 lazy CJS——bundle
  // 执行只注册工厂，CSS 注入等随物化）
  const raw = readFileSync(join(distDir, 'index.js'), 'utf-8');
  const wrapped = 'window.__ModuleLoader__.load({\n'
    + '  id: ' + JSON.stringify(pkg.name) + ',\n'
    + '  factory: (require) => {\n'
    + '    const module = { exports: {} };\n'
    + '    (function (module, exports, require) {\n'
    + raw
    + '\n    })(module, module.exports, require);\n'
    + '    return module.exports && typeof module.exports === \'object\' && \'default\' in module.exports\n'
    + '      ? module.exports : { default: module.exports };\n'
    + '  },\n'
    + '});\n';
  writeFileSync(join(distDir, 'index.js'), wrapped, 'utf-8');

  // 纯度门（cjs 面）：产物剩余 require ⊆ 宿主模块表；isolated 自含档 = 空
  const specs = requireSpecs(wrapped);
  const offenders = selfContained
    ? specs.filter((s) => !s.startsWith('node:'))
    : specs.filter((s) => !isExternal(s));
  if (offenders.length > 0) {
    console.error('[build-channel] ' + short + ' 外部化门违例（宿主模块表未覆盖）：\n  ' + offenders.join('\n  '));
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
  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  // 触发宿主 wire/rebuilt 探测面（stat-poll 读 mtime——清单位不必参与）
  const now = new Date();
  try { utimesSync(distDir, now, now); } catch { /* 首建由 mkdir 落 mtime */ }
}
console.log('[build-channel] 完成（v3 factory 形态）' + modules.length + ' 模块 → 各包 client/dist');
