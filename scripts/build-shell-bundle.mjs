#!/usr/bin/env node
/**
 * build-shell-bundle.mjs —— dev 形态壳 bundle（cr-961 冷启 IO 治本）
 *
 * 壳 boot 的成本模型 = 每进程 × 全量源码图 × 冷文件系统 × AV 滤镜：
 * 1904 文件装载 / 5373 模块解析，暖态 ~1.3s，待机唤醒冷态实测 40~47s
 * （11 天 44 次 adopt 超时误杀现场）。本脚本把壳 boot 图 esbuild 成单文件
 * dist/shell.mjs（IO 降两个数量级），并写指纹旁车 dist/shell.bundle.json
 * （全部输入源文件的 mtime/size 清单）——宿主 anchors 据此在「bundle 新鲜
 * → 用 bundle」与「任何源码漂移 → 回落源码直载」间自动选择：dev 改码后
 * 无需手动重建即自动回源，产物只在显式 pnpm build:shell 后生效。
 *
 * 与 build-bundle.mjs（发布链全量产物）的分野：本脚本只产壳双入口
 * （shell.mjs + worker.mjs），不动 dist/ 其余面（webui/plugins/templates
 * 等归发布链）。esbuild 接线同源：TEMP 重定向（cr-558）+ write:false
 * node 终写（cr-920）+ createRequire banner。
 *
 * 用法：pnpm build:shell
 */
import { mkdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Windows TEMP 重定向（cr-558 同族）：%TEMP% 被实时防护占用时 esbuild 写
// 临时文件偶发 Access denied——包内临时目录规避，构建后自清。
const tmpDir = path.join(root, '.tmp-shell-bundle');
if (process.platform === 'win32') {
  mkdirSync(tmpDir, { recursive: true });
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;
}
const requireFromRoot = createRequire(path.join(root, 'package.json'));
let esbuild;
try {
  esbuild = requireFromRoot('esbuild');
} catch {
  console.error('[build-shell-bundle] 无法解析 esbuild（请先 pnpm install）');
  process.exit(1);
}

const banner = { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" };
// write:false + node 终写（cr-920）：esbuild.exe 在受实时防护约束的机器上
// 被拒直接写产物——产物从内存取出由本进程落盘。
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', banner, logLevel: 'info', write: false, absWorkingDir: root, metafile: true };

/** 输入指纹（mtime/size——宿主 spawn 侧 stat 对拍，任何漂移即回落源码直载） */
const entries = new Map();
const recordInputs = (metafile) => {
  for (const rel of Object.keys(metafile.inputs)) {
    const abs = path.resolve(root, rel);
    try {
      const st = statSync(abs);
      entries.set(rel.replaceAll('\\', '/'), [st.mtimeMs, st.size]);
    } catch { /* 输入缺席（虚拟模块等）——不进指纹 */ }
  }
};

async function buildEntry(entry, outfile) {
  const r = await esbuild.build({ entryPoints: [entry], ...common });
  const out = r.outputFiles?.[0];
  if (out === undefined) throw new Error('[build-shell-bundle] 无产物面：' + entry);
  writeFileSync(outfile, out.contents);
  recordInputs(r.metafile);
  console.log('[build-shell-bundle] ' + path.relative(root, outfile) + '  ' + (out.contents.length / 1024).toFixed(0) + 'kb');
}

mkdirSync(dist, { recursive: true });
await buildEntry(path.join(root, 'apps', 'shell', 'boot.ts'), path.join(dist, 'shell.mjs'));

// run_code worker（ac-run-code dev/bundle 双入口的 bundle 候选——与壳同目录，
// 壳 bundle 形态下 dev 候选缺席、bundle 候选即本产物）
const workerEntry = path.join(root, 'packages', 'ac-run-code', 'src', 'worker.ts');
if (existsSync(workerEntry)) {
  await buildEntry(workerEntry, path.join(dist, 'worker.mjs'));
} else {
  console.log('[build-shell-bundle] ac-run-code worker 入口缺席——跳过');
}

writeFileSync(path.join(dist, 'shell.bundle.json'), JSON.stringify({
  version: 1,
  builtAt: new Date().toISOString(),
  entries: [...entries.entries()].map(([rel, [mtimeMs, size]]) => [rel, mtimeMs, size]),
}, null, 0) + '\n', 'utf-8');
console.log('[build-shell-bundle] 指纹 ' + entries.size + ' 输入 → dist/shell.bundle.json');

if (process.platform === 'win32') rmSync(tmpDir, { recursive: true, force: true });
