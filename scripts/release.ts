/**
 * release.ts —— 本地发布辅助
 *
 * 仅做两件事：
 *   1. pnpm build:release —— 构建便携包
 *   2. 打包 zip
 *
 * GitHub Release 由 CI (GitHub Actions) 自动完成，
 * 此脚本用于本地预览构建产物。
 *
 * 用法：
 *   npx tsx scripts/release.ts
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = PKG.version;
const tag = `v${version}`;

function log(msg: string) { console.log(msg); }

// 检查工作区
const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' }).trim();
if (status) {
  console.error('❌ 工作区不干净，请先提交所有改动。');
  console.error(status);
  process.exit(1);
}

log(`\n🚀 构建 AgentChat ${tag} 发布包...`);

// 1. 构建便携包
execSync('pnpm build:release', { cwd: ROOT, stdio: 'inherit' });

// 2. 打包 zip
const releaseDir = path.join(ROOT, 'release', 'AgentChat');
if (!fs.existsSync(releaseDir)) {
  console.error('❌ release/AgentChat/ 不存在，构建可能失败');
  process.exit(1);
}

const zipFile = path.join(ROOT, 'release', `AgentChat-${tag}-win-x64.zip`);
if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);

// 统一使用 make-release-zip.ps1（与 CI 一致）：对 .zip 用 NoCompression 存储，
// 避免二次压缩 ~90MB 的 node-portable.zip（Compress-Archive 会重新压缩，慢且大）。
log(`\n> 压缩 ${releaseDir} → ${zipFile}`);
execSync(
  `powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'scripts', 'make-release-zip.ps1')}" ` +
  `-Source "${releaseDir}" -Out "${zipFile}"`,
  { cwd: ROOT, encoding: 'utf-8' }
);
const zipSize = (fs.statSync(zipFile).size / 1024 / 1024).toFixed(1);
log(`  完成 (${zipSize} MB)`);

log(`\n✅ 构建完成。`);
log(`\n📋 下一步：`);
log(`   1. git tag ${tag} && git push --tags`);
log(`   2. GitHub Actions 自动创建 Release + 上传 zip`);
log(`   3. 或手动: https://github.com/nefevcore/AgentChat/releases/new`);
log(`   4. 上传附件: release\\AgentChat-${tag}-win-x64.zip\n`);
