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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const externals = manifest.channelImports ?? [];
  // 子路径导出同包外部化（'ac-client-runtime/client' 等——import 前缀匹配）
  const isExternal = (id) => externals.some((x) => id === x || id.startsWith(x + '/'));
  const target = join(outDir, name);
  mkdirSync(join(target, 'ui'), { recursive: true });
  console.log('[build-channel] ' + name + ' → ' + target + '（external: ' + externals.join(', ') + '）');
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
  const out = { ...manifest };
  if (existsSync(join(target, 'ui', 'style.css'))) out.styles = ['ui/style.css'];
  else delete out.styles;
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(out, null, 2) + '\n', 'utf-8');
}
console.log('[build-channel] 完成 ' + modules.length + ' 模块 → ' + outDir);