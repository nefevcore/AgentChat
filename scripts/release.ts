/**
 * release.ts
 *
 * 一键发布流程：
 *   1. 检查工作区是否干净
 *   2. 从 package.json 读取版本号
 *   3. 执行 build:release 构建便携包到 release/AgentChat/
 *   4. 打包 zip
 *   5. 输出 Release 信息（手动去 GitHub Releases 页面上传）
 *
 * 用法：
 *   npx tsx scripts/release.ts
 *
 * 前置条件：GitHub Personal Access Token 设到环境变量 GITHUB_TOKEN
 * 有此 Token 则自动创建 Release + 上传 zip，全自动。
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

function sh(cmd: string, cwd?: string) {
  console.log(`\n> ${cmd}`);
  console.log(execSync(cmd, { cwd: cwd || ROOT, encoding: 'utf-8', stdio: 'pipe' }).trimEnd());
}

// 1. 检查工作区
const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' }).trim();
if (status) {
  console.error('❌ 工作区不干净，请先提交所有改动。');
  console.error(status);
  process.exit(1);
}

const version = PKG.version;
const tag = `v${version}`;

console.log(`\n🚀 准备发布 AgentChat ${tag}`);

// 2. 构建发布包
sh('npm run build:release');
sh(`npx tsx scripts/build-release.ts`);

// 3. 打包 zip（Windows 用 PowerShell）
const releaseDir = path.join(ROOT, 'release', 'AgentChat');
const zipFile = path.join(ROOT, 'release', `AgentChat-${tag}-win-x64.zip`);

if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);

console.log(`\n> 压缩 ${releaseDir} → ${zipFile}`);
execSync(
  `powershell -Command "Compress-Archive -Path '${releaseDir}' -DestinationPath '${zipFile}'"`,
  { cwd: ROOT, encoding: 'utf-8' }
);
const zipSize = (fs.statSync(zipFile).size / 1024 / 1024).toFixed(1);
console.log(`  完成 (${zipSize} MB)`);

// 4. 创建 GitHub Release
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  // 无 Token，输出手动步骤
  console.log(`\n📋 手动发布步骤：`);
  console.log(`   1. 打开 https://github.com/nefevcore/AgentChat/releases/new`);
  console.log(`   2. Tag: ${tag}`);
  console.log(`   3. Title: ${tag}`);
  console.log(`   4. 把 CHANGELOG.md 中 ## [${version}] 的内容粘进去`);
  console.log(`   5. 上传附件: release\\AgentChat-${tag}-win-x64.zip`);
  console.log(`\n✅ 构建完成，待手动发布。`);
} else {
  // 自动创建 Release
  try {
    const repo = 'nefevcore/AgentChat';
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
    const body = changelog.split('\n').slice(2).join('\n').trim(); // 去掉 "# Changelog" 标题

    // 创建 Release
    console.log(`\n> 创建 GitHub Release ${tag}...`);
    const createResult = JSON.parse(
      execSync(
        `curl -s -X POST "https://api.github.com/repos/${repo}/releases" ` +
        `-H "Authorization: token ${githubToken}" ` +
        `-H "Content-Type: application/json" ` +
        `-d ${JSON.stringify(JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }))}`,
        { cwd: ROOT, encoding: 'utf-8' }
      )
    );

    if (createResult.id) {
      // 上传 zip
      const uploadUrl = createResult.upload_url.replace(/\{\?.*\}$/, `?name=${encodeURIComponent(path.basename(zipFile))}`);
      console.log(`> 上传 ${path.basename(zipFile)}...`);
      execSync(
        `curl -s -X POST "${uploadUrl}" ` +
        `-H "Authorization: token ${githubToken}" ` +
        `-H "Content-Type: application/zip" ` +
        `--data-binary "@${zipFile}"`,
        { cwd: ROOT, encoding: 'utf-8' }
      );
      console.log(`\n✅ 发布完成！${createResult.html_url}`);
    } else {
      console.error('❌ 创建 Release 失败:', JSON.stringify(createResult).slice(0, 300));
    }
  } catch (err: any) {
    console.error('❌ GitHub 操作失败:', err.message);
    console.log(`\n请手动发布: https://github.com/nefevcore/AgentChat/releases/new`);
  }
}
