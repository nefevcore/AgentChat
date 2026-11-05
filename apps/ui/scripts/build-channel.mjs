// ============================================================
// build-channel.mjs —— 通道模块构建器（8.5b 第二批）
//
// 扫 channel/ 下模块目录（含 manifest.json 者为通道模块）：
//   · vite library build：entry = src/index.ts，formats es；
//   · rollupOptions.external = manifest.channelImports（基座外部化——
//     运行时经 boot.ts installChannelImportmap 解析宿主实例）；
//   · 产物落 <outDir>/<name>/ui/（manifest entry 'ui/index.js' 对齐）+
//     manifest.json 拷贝同目录——直接构成 pluginsDir 形态（assembleBootGraph 可扫）。
// 用法：node scripts/build-channel.mjs [--out <dir>] [<name>...]
//   缺省 out = sandbox/ui-plugins/（数据根隔离红线：恒 sandbox/ 下）。
// ============================================================
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_MODULE_SPECS } from './host-module-table.ts';

const channelRoot = fileURLToPath(new URL('../channel', import.meta.url));
// 仓库根（脚本在 <root>/apps/ui/scripts/——CWD 无关锚点；3 级上行）
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const args = process.argv.slice(2);
let outDir = join(repoRoot, 'sandbox/ui-plugins');
const only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = resolve(repoRoot, args[++i]);
  else only.push(args[i]);
}

const modules = readdirSync(channelRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(channelRoot, e.name))
  .filter((dir) => existsSync(join(dir, 'manifest.json')))
  .filter((dir) => only.length === 0 || only.includes(dir.split(/[\\/]/).pop()));

if (modules.length === 0) { console.error('[build-channel] 无匹配通道模块'); process.exit(1); }

for (const dir of modules) {
  const name = dir.split(/[\\/]/).pop();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  // cr-905 批3 切片二：channelImports 退役——外部化 = 宿主模块表全表恒等
  //（host-module-table.mjs 单源；manifest 不再自述共享面）
  const isExternal = (id) => HOST_MODULE_SPECS.some((x) => id === x || id.startsWith(x + '/'));
  const target = join(outDir, name);
  mkdirSync(join(target, 'ui'), { recursive: true });
  console.log('[build-channel] ' + name + ' → ' + target + '（external: 宿主模块表 ' + HOST_MODULE_SPECS.length + ' 键）');
  await build({
    configFile: false,
    plugins: [vue(), Icons({ compiler: 'vue3' })],
    resolve: {
      alias: { '@agentchat/protocol': fileURLToPath(new URL('../src/shims/@agentchat/protocol.ts', import.meta.url)) },
    },
    build: {
      outDir: join(target, 'ui'),
      emptyOutDir: true,
      // 通道模块 target = esnext（跳过 esbuild 降级路径——Windows esbuild renderChunk
      // 临时文件删除偶发 Access denied；chrome92 降级归 8.5e 构建面统一处理）
      target: 'esnext',
      minify: false,
      lib: { entry: join(dir, 'src/index.ts'), formats: ['es'], fileName: () => 'index.js' },
      rollupOptions: { external: isExternal },
    },
  });
  // manifest 落盘（cr-584）：产物有 style.css（vite lib 把 SFC scoped 样式 emit 到
  // entry 同目录）时注入 styles 声明——装载器 defaultLoader 据此挂 <link>。
  // 源 manifest 不回写（构建产物形态，与 ui/ 产物同族）。
  // cr-905 批3 切片二：产物摘 channelImports（退役字段——外部化恒为宿主
  // 模块表全表，装载面 importmap 同源注入，条目不再自述共享面）。
  const { channelImports: _retired, ...manifestRest } = manifest;
  const out = { ...manifestRest };
  if (existsSync(join(target, 'ui', 'style.css'))) out.styles = ['ui/style.css'];
  else delete out.styles;
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(out, null, 2) + '\n', 'utf-8');
}
// 触发宿主 boot-graph 缓存失效（cr-893）：产物文件替换不改 outDir 的 readdir
// mtime——touch 之，宿主 webui-row 目录签名立即变化（旧实现只看父目录 mtime
// 时同样依赖此 touch 生效）。幂等：纯 mtime 更新。
const now = new Date();
for (const d of modules) {
  const target = join(outDir, d.split(/[\\/]/).pop());
  try { utimesSync(target, now, now); } catch { /* 目录缺席（首建由 mkdir 落 mtime） */ }
}
console.log('[build-channel] 完成 ' + modules.length + ' 模块 → ' + outDir);