/**
 * build-release.ts
 *
 * 构建零依赖、便携分发的发布包到 release/AgentChat/ 目录。
 * 内嵌 Node.js 便携版，用户无需安装任何东西，解压即用。
 *
 * 用法：
 *   npx tsx scripts/build-release.ts
 *
 * 产出 release/AgentChat/ 包含：
 *   - node/                   Node.js 便携版（无需系统安装 Node.js）
 *   - dist/                   后端编译产物
 *   - webui/client/dist/      前端构建产物
 *   - node_modules/           运行时依赖（仅 production）
 *   - workspace/              工作空间（Agent 配置、会话等）
 *   - 启动AgentChat.bat       一键启动脚本（双击即可）
 *   - 使用说明.md
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release', 'AgentChat');
const CACHE_DIR = path.join(ROOT, '.cache');

// Node.js 版本 —— 与当前开发环境一致
const NODE_VERSION = 'v22.12.0';
const NODE_ARCH = 'win-x64';
const NODE_ZIP = `node-${NODE_VERSION}-${NODE_ARCH}.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;

// ---- 工具函数 ----

function sh(cmd: string, cwd?: string): void {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: 'inherit' });
}

function copyDir(src: string, dest: string, ignore?: RegExp[]): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, ent.name);
    const dp = path.join(dest, ent.name);
    if (ignore?.some((r) => r.test(sp))) continue;
    if (ent.isDirectory()) {
      copyDir(sp, dp, ignore);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// ---- 下载 Node.js 便携版 ----

async function downloadNode(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, NODE_ZIP);

  if (fs.existsSync(cached)) {
    console.log(`[Node.js] 使用缓存：${cached}`);
    return cached;
  }

  console.log(`[Node.js] 下载 ${NODE_URL} ...`);
  await new Promise<void>((resolve, reject) => {
    https.get(NODE_URL, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // 跟随重定向
        https.get(res.headers.location!, (r2) => {
          const ws = createWriteStream(cached);
          pipeline(r2, ws).then(resolve).catch(reject);
        });
        return;
      }
      const ws = createWriteStream(cached);
      pipeline(res, ws).then(resolve).catch(reject);
    }).on('error', reject);
  });

  console.log(`[Node.js] 已缓存到 ${cached}`);
  return cached;
}

function extractNode(zipPath: string, destDir: string): void {
  // Node.js 官方 zip 内有一层顶层目录 node-v{VERSION}-win-x64/
  // 我们解压后把内容提取到 node/ 目录
  console.log(`[Node.js] 解压到 ${destDir} ...`);

  // 使用 PowerShell 解压（Windows 内置，无依赖）
  const tmpDir = path.join(RELEASE, '_node_tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  sh(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`);

  // 找到解压后的内层目录
  const inner = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-'));
  if (!inner) throw new Error('无法找到 Node.js 解压目录');

  const nodeDir = path.join(destDir);
  if (fs.existsSync(nodeDir)) fs.rmSync(nodeDir, { recursive: true });

  // 移动内容到 node/
  copyDir(path.join(tmpDir, inner), nodeDir);

  // 清理临时目录
  fs.rmSync(tmpDir, { recursive: true });

  console.log('[Node.js] 解压完成');
}

// ---- 主流程 ----

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  AgentChat Release Builder (Portable)');
  console.log('═══════════════════════════════════════\n');

  // 清理旧发布目录（删除内容，忽略锁定错误）
  if (fs.existsSync(RELEASE)) {
    console.log('[1/7] 清理旧发布目录...');
    try { fs.rmSync(RELEASE, { recursive: true }); }
    catch {
      // 文件被锁定时递归删除会失败，逐个清理
      for (const ent of fs.readdirSync(RELEASE)) {
        const p = path.join(RELEASE, ent);
        try { fs.rmSync(p, { recursive: true }); }
        catch { /* skip locked */ }
      }
    }
  }
  fs.mkdirSync(RELEASE, { recursive: true });

  // 构建后端
  console.log('[2/7] 构建后端 TypeScript...');
  sh('npm run build');

  // 构建前端
  console.log('[3/7] 构建前端 Vue...');
  sh('npm run build', path.join(ROOT, 'webui', 'client'));

  // 复制后端产物
  console.log('[4/7] 复制后端...');
  copyDir(path.join(ROOT, 'dist'), path.join(RELEASE, 'dist'));

  // 生成 tsconfig.json（供 tsconfig-paths 运行时解析路径别名）
  const releaseTsconfig = {
    compilerOptions: {
      baseUrl: './dist',
      paths: {
        '@core/*': ['./src/core/*'],
        '@routing/*': ['./src/routing/*'],
        '@llm/*': ['./src/llm/*'],
        '@discovery/*': ['./src/discovery/*'],
        '@global/*': ['./src/global/*'],
      },
    },
  };
  fs.writeFileSync(
    path.join(RELEASE, 'tsconfig.json'),
    JSON.stringify(releaseTsconfig, null, 2),
    'utf-8'
  );

  // 复制前端产物
  copyDir(
    path.join(ROOT, 'webui', 'client', 'dist'),
    path.join(RELEASE, 'webui', 'client', 'dist')
  );

  // 创建干净的工作空间（不含测试数据）
  console.log('[5/7] 创建干净工作空间...');
  const wsDir = path.join(RELEASE, 'workspace', 'default');
  fs.mkdirSync(path.join(wsDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'rooms'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'files'), { recursive: true });

  // 复制全局配置
  copyFile(
    path.join(ROOT, 'workspace', 'default', 'config.json'),
    path.join(wsDir, 'config.json')
  );

  // 只包含一个最小 user 虚拟 Agent（框架必需），排除头像等二进制文件
  copyDir(
    path.join(ROOT, 'workspace', 'default', 'agents', 'user'),
    path.join(wsDir, 'agents', 'user'),
    [/avatar/i]
  );

  // 生成 .env.example 模板
  const envExample = `# ============================================
# AgentChat API Keys
# ============================================
# Rename this file to .env and fill in your keys

DEEPSEEK_API_KEY=sk-your-key-here
OPENAI_API_KEY=sk-your-key-here
`;
  fs.writeFileSync(path.join(wsDir, '.env.example'), envExample, 'utf-8');

  // 安装 production 依赖
  console.log('[6/7] 安装运行时依赖...');
  copyFile(path.join(ROOT, 'package.json'), path.join(RELEASE, 'package.json'));
  copyFile(path.join(ROOT, 'package-lock.json'), path.join(RELEASE, 'package-lock.json'));
  sh('npm ci --omit=dev', RELEASE);

  // 下载并嵌入 Node.js 便携版
  console.log('[7/7] 嵌入 Node.js 便携版...');
  const zipPath = await downloadNode();
  extractNode(zipPath, path.join(RELEASE, 'node'));

  // 复制前端静态服务脚本
  copyFile(
    path.join(ROOT, 'scripts', 'frontend-server.js'),
    path.join(RELEASE, 'frontend-server.js')
  );

  // 生成服务器辅助脚本 _server.bat
  const serverBat = `@echo off
chcp 65001 >nul
title AgentChat Server

echo.
echo ============================================
echo   AgentChat Server
echo   Close this window to stop
echo ============================================
echo.

:: Start frontend static server on 3831 (proxies /api to 3830)
start "" /B node\\node.exe frontend-server.js

:: Start main backend on 3830
node\\node.exe -r tsconfig-paths/register dist\\src\\index.js 2>&1

echo.
echo ============================================
echo   Server stopped - check errors above
echo ============================================
pause
`;
  fs.writeFileSync(path.join(RELEASE, '_server.bat'), serverBat, 'utf-8');

  // 生成主启动脚本
  const batContent = `@echo off
chcp 65001 >nul
title AgentChat Launcher

cd /d "%~dp0"

:: check critical files
if not exist "node\\node.exe" (
    echo [ERROR] node\\node.exe not found
    pause
    exit /b 1
)
if not exist "dist\\src\\index.js" (
    echo [ERROR] dist\\src\\index.js not found
    pause
    exit /b 1
)

:: first-time guide
if not exist "workspace\\default\\.env" (
    echo.
    echo ============================================
    echo   Welcome to AgentChat!
    echo ============================================
    echo.
    echo   Create workspace\\default\\.env with:
    echo     DEEPSEEK_API_KEY=sk-your-key
    echo     OPENAI_API_KEY=sk-your-key
    echo.
    echo ============================================
    echo.
    echo Press any key to continue...
    pause >nul
)

echo.
echo ============================================
echo   AgentChat is starting...
echo ============================================
echo.

:: launch server in new window
start "AgentChat Server" cmd /k _server.bat

:: wait for backend on 3830
echo Waiting for backend on port 3830...
set /a N=0
:loop
timeout /t 2 /nobreak >nul
set /a N+=1
powershell -Command "try { Invoke-WebRequest http://localhost:3830/api/agents -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto open
if %N% lss 15 goto loop

echo.
echo [WARNING] Backend did not respond within 30s.
echo Check the AgentChat Server window for errors.
echo.
pause
exit /b 1

:open
echo.
echo Backend ready, opening browser on port 3831...
start "" http://localhost:3831

echo.
echo ============================================
echo   AgentChat is running!
echo   Backend API:  http://localhost:3830
echo   Frontend:    http://localhost:3831
echo   Close the Server window to stop.
echo ============================================
echo.

timeout /t 3 /nobreak >nul
exit
`;

  fs.writeFileSync(path.join(RELEASE, '启动AgentChat.bat'), batContent, 'utf-8');

  // 生成使用说明
  const readme = `# AgentChat —— 便携版

## 快速开始（无需安装任何东西！）

1. 在 \`workspace\\default\\\` 下创建 \`.env\` 文件，填入 API 密钥：
   \`\`\`
   DEEPSEEK_API_KEY=sk-your-key
   OPENAI_API_KEY=sk-your-key
   \`\`\`
2. **双击 \`启动AgentChat.bat\`**
3. 浏览器会自动打开 http://localhost:3831

## 系统要求

- Windows 10/11 x64
- 无需安装 Node.js（已内嵌便携版）
- 无需管理员权限
- 完全绿色，删除文件夹即卸载

## 配置

- Agent 配置：\`workspace\\default\\agents\\\`
- 全局配置：\`workspace\\default\\config.json\`
`;
  fs.writeFileSync(path.join(RELEASE, '使用说明.md'), readme, 'utf-8');

  // 删除 package.json（不需要用户看到）
  fs.rmSync(path.join(RELEASE, 'package.json'));
  fs.rmSync(path.join(RELEASE, 'package-lock.json'));

  console.log('\n═══════════════════════════════════════');
  console.log(`  ✓ 发布包已生成：${RELEASE}`);
  console.log('═══════════════════════════════════════');
  console.log('\n将该文件夹打包为 .zip 即可分发。');
  console.log('用户解压后只需：配置 API 密钥 → 双击 启动AgentChat.bat\n');
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});

