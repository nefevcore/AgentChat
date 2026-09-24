// scripts/release-preflight.mjs —— 发版本地预检（CI 同序五步 + 可选干净安装档）
//
// 背景：v0.8.0 起 12 个版本无一首发全绿（见 src/docs/release-ci-postmortem.md），
// 失败集中在平台/形态/环境三边界。CI 的五步本地全有命令，缺的是「一条命令按 CI
// 同序跑一遍」的入口，以及「干净安装」档（三连败全是本地 node_modules 历史残留
// 掩盖的干净安装问题——uplot 声明/解析/postinstall 档位）。
//
// 用法：
//   pnpm release:preflight          # 快档：按 CI 同序五步（用现有 node_modules）
//   pnpm release:preflight --clean  # 干净档：删全部 node_modules → 全新安装 → 五步
//                                  #（约多 2-4 分钟；发布前建议至少跑一次）
// 五步与 .github/workflows/publish.yml 完全同序：
//   install(--frozen-lockfile) → check:deps → build:frontend → test → build:bundle
// npm publish / electron-builder / 上传等发布动作不预检（有副作用）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEAN = process.argv.includes('--clean');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(label, cmd, args) {
  console.log(`\n[preflight] === ${label} ===`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\n[preflight] ✗ ${label} 失败（${sec}s）——本地拦下，没浪费一次 CI 轮次`);
    process.exit(1);
  }
  console.log(`[preflight] ✓ ${label}（${sec}s）`);
}

if (CLEAN) {
  console.log('[preflight] 干净档：删除全部 node_modules（顶层 + 各包）……');
  const dirs = [path.join(root, 'node_modules')];
  for (const entry of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nm = path.join(root, 'src', entry.name, 'node_modules');
      if (fs.existsSync(nm)) dirs.push(nm);
    }
  }
  const dn = path.join(root, 'desktop', 'node_modules');
  if (fs.existsSync(dn)) dirs.push(dn);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`[preflight] 已清 ${dirs.length} 个 node_modules`);
}

run('1/5 安装依赖（frozen，与 CI 同参）', pm, ['install', '--frozen-lockfile']);
run('2/5 依赖卫生检查', pm, ['check:deps']);
run('3/5 构建前端', pm, ['build:frontend']);
run('4/5 全量测试', pm, ['test']);
run('5/5 构建发布 bundle', pm, ['build:bundle']);

console.log('\n[preflight] ✓ 全部通过——CI 的构建/测试面已本地验证，可以推 tag 了');
console.log('[preflight] 注：npm publish / 桌面打包（electron-builder）/ 三平台差异面不在预检范围');
