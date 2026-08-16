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
 *   - node/                   Node.js 便携版（首次运行从 node-portable.zip 自动解压）
 *   - dist/                   后端编译产物
 *   - webui/client/dist/      前端构建产物（自 src/ui/webui 构建后复制）
 *   - node_modules/           运行时依赖（仅 production）
 *   - scripts/                运行时脚本（start.bat, frontend-server.js）
 *   - workspace/              工作空间（Agent 配置、会话等）
 *   - start.bat       一键启动脚本（双击即可）
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

// Node.js 便携版版本（保持与 CI 和本地开发版本一致）
const NODE_VERSION = 'v24.18.0';
const NODE_ARCH = 'win-x64';
const NODE_ZIP = `node-${NODE_VERSION}-${NODE_ARCH}.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;

// ── 工具函数 ──

function sh(cmd: string, cwd?: string): void {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: 'inherit' });
}

/** 执行命令，容忍非零退出（tsc 有类型错误但 JS 仍会生成） */
function shTolerant(cmd: string, cwd?: string): void {
  console.log(`\n> ${cmd} (tolerant)`);
  try {
    execSync(cmd, { cwd: cwd ?? ROOT, stdio: 'inherit' });
  } catch {
    console.log(`  ⚠ 命令非零退出，继续...`);
  }
}

function copyDir(src: string, dest: string, ignore?: RegExp[]): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, ent.name);
    const dp = path.join(dest, ent.name);
    if (ignore?.some((r) => r.test(sp))) continue;
    if (ent.isDirectory()) copyDir(sp, dp, ignore);
    else fs.copyFileSync(sp, dp);
  }
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// ── Node.js 便携版 ──

async function downloadNode(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, NODE_ZIP);

  // 校验缓存完整性（大小 > 10MB 才视为有效，Node.js zip 约 90MB）
  if (fs.existsSync(cached) && fs.statSync(cached).size > 10 * 1024 * 1024) {
    console.log(`[Node.js] 使用缓存：${cached} (${(fs.statSync(cached).size / 1024 / 1024).toFixed(0)} MB)`);
    return cached;
  }
  if (fs.existsSync(cached)) {
    console.log(`[Node.js] 缓存损坏（${fs.statSync(cached).size} bytes），重新下载...`);
    fs.unlinkSync(cached);
  }

  console.log(`[Node.js] 下载 ${NODE_URL} ...`);
  await new Promise<void>((resolve, reject) => {
    https.get(NODE_URL, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location!, (r2) => {
          pipeline(r2, createWriteStream(cached)).then(resolve).catch(reject);
        });
        return;
      }
      pipeline(res, createWriteStream(cached)).then(resolve).catch(reject);
    }).on('error', reject);
  });

  console.log(`[Node.js] 已缓存到 ${cached}`);
  return cached;
}

/** 将 Node.js zip 复制到发布包，首次运行时由 start.bat 解压 */
function stageNode(zipPath: string): void {
  const dest = path.join(RELEASE, 'node-portable.zip');
  console.log(`[Node.js] 复制便携版 zip 到 ${dest}`);
  fs.copyFileSync(zipPath, dest);
  console.log(`[Node.js] 完成（约 ${(fs.statSync(dest).size / 1024 / 1024).toFixed(0)} MB，运行时自动解压）`);
}

// ── 组装发布包 ──

function assembleReleaseDir() {
  // 构建 tsconfig（路径别名映射）
  const tsconfig = {
    compilerOptions: {
      baseUrl: './dist',
      paths: {
        '@core/*':      ['./src/core/*'],
        '@agents/*':    ['./src/agents/*'],
        '@app/*':       ['./src/app/*'],
        '@plugins/*':   ['./src/plugins/*'],
        '@services/*':  ['./src/services/*'],
        '@llm/*':       ['./src/core/llm/*'],
        '@utils/*':     ['./src/utils/*'],
        '@shared/*':    ['./src/shared/*'],
      },
    },
  };
  fs.writeFileSync(path.join(RELEASE, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');

  // 复制运行时脚本（从 scripts/runtime/ 直接取，不内嵌模板）
  copyFile(path.join(ROOT, 'scripts', 'runtime', 'start.bat'), path.join(RELEASE, 'start.bat'));
  copyFile(path.join(ROOT, 'scripts', 'runtime', 'update.bat'), path.join(RELEASE, 'update.bat'));
  copyFile(path.join(ROOT, 'scripts', 'runtime', 'frontend-server.js'), path.join(RELEASE, 'scripts', 'frontend-server.js'));
  // 会话维护工具箱（start.bat 启动前执行 migrate --fix 数据迁移）
  copyFile(path.join(ROOT, 'scripts', 'session-maint.js'), path.join(RELEASE, 'scripts', 'session-maint.js'));
  // 配置迁移脚本（start.bat 启动前自动更新旧工作区配置到新默认值）
  copyFile(path.join(ROOT, 'scripts', 'update-config.js'), path.join(RELEASE, 'scripts', 'update-config.js'));

  // 复制构建产物
  copyDir(path.join(ROOT, 'dist'), path.join(RELEASE, 'dist'));
  // tsc 不复制 .json/.md 文件，手动补上（AgentLoader 扫描插件清单 / ensureWorkspaceFiles 复制指引用）
  for (const dir of ['builtin', 'builtin-math']) {
    copyFile(
      path.join(ROOT, 'src', 'plugins', dir, 'plugin.json'),
      path.join(RELEASE, 'dist', 'src', 'plugins', dir, 'plugin.json')
    );
  }
  // 工具开发指引模板（ensureWorkspaceFiles 首次运行时复制到 workspace/files/）
  for (const name of ['tool-dev-guide.md']) {
    copyFile(
      path.join(ROOT, 'docs', name),
      path.join(RELEASE, 'dist', 'src', 'plugins', 'builtin', name)
    );
  }
  copyDir(
    path.join(ROOT, 'src', 'ui', 'webui', 'dist'),
    path.join(RELEASE, 'webui', 'client', 'dist')
  );

  // 工作空间由运行时自动创建（src/app/index.ts ensureWorkspaceFiles），无需 release 预置

  // 使用说明
  const readme = `# AgentChat — 便携版

## 快速开始（无需安装任何东西！）

1. **双击 \`start.bat\`**
2. 浏览器会自动打开 http://localhost:3831
3. 侧边栏「更多」→「设置」→ 找「模型管理」配置 API Key

## 系统要求

- Windows 10/11 x64
- 无需安装 Node.js（已内嵌便携版）
- 无需管理员权限
- 完全绿色，删除文件夹即卸载
- 支持在线更新：双击 \`update.bat\`（start.bat 启动时也会提示更新）

## 端口

- 前端: http://localhost:3831
- 后端 API: http://localhost:3830
- WebSocket: ws://localhost:3831/ws

## 配置

- Agent 配置：\`workspace\\default\\agents\\\`
- 全局配置：\`workspace\\default\\config.json\`
`;
  fs.writeFileSync(path.join(RELEASE, '使用说明.md'), readme, 'utf-8');
}

// ── 安装运行时依赖 ──

function installRuntimeDeps() {
  // pnpm monorepo：复制 package.json / pnpm-lock.yaml / pnpm-workspace.yaml，
  // 并把 src 工作区包一起复制进去，使 workspace:* 链接在发布包内自包含。
  copyFile(path.join(ROOT, 'package.json'), path.join(RELEASE, 'package.json'));
  copyFile(path.join(ROOT, 'pnpm-lock.yaml'), path.join(RELEASE, 'pnpm-lock.yaml'));
  copyFile(path.join(ROOT, 'pnpm-workspace.yaml'), path.join(RELEASE, 'pnpm-workspace.yaml'));
  copyDir(path.join(ROOT, 'src'), path.join(RELEASE, 'src'), [/(^|[\\/])node_modules([\\/]|$)/]);

  sh('pnpm install --prod --frozen-lockfile', RELEASE);

  // 清理 lock 文件，但保留 package.json / pnpm-workspace.yaml / src（node_modules 链接指向 src）
  fs.rmSync(path.join(RELEASE, 'pnpm-lock.yaml'));
}

// ── 主流程 ──

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  AgentChat Release Builder');
  console.log('═══════════════════════════════════════\n');

  // 1. 清理
  console.log('[1/6] 清理旧发布目录...');
  if (fs.existsSync(RELEASE)) {
    try { fs.rmSync(RELEASE, { recursive: true }); }
    catch {
      for (const ent of fs.readdirSync(RELEASE)) {
        try { fs.rmSync(path.join(RELEASE, ent), { recursive: true }); }
        catch { /* skip locked */ }
      }
    }
  }
  fs.mkdirSync(RELEASE, { recursive: true });

  // 2. 构建
  console.log('[2/6] 构建后端...');
  shTolerant('pnpm build');

  // 验证构建产物存在
  if (!fs.existsSync(path.join(ROOT, 'dist', 'src', 'app', 'index.js'))) {
    console.error('❌ 构建失败：dist/src/app/index.js 未生成');
    process.exit(1);
  }

  console.log('[3/6] 构建前端...');
  sh('pnpm build', path.join(ROOT, 'src', 'ui', 'webui'));

  // 4. 组装目录
  console.log('[4/6] 组装发布目录...');
  assembleReleaseDir();

  // 5. 安装依赖
  console.log('[5/6] 安装运行时依赖...');
  installRuntimeDeps();

  // 6. 嵌入 Node.js
  console.log('[6/6] 嵌入 Node.js 便携版...');
  const zipPath = await downloadNode();
  stageNode(zipPath);

  // 最终验证：node-portable.zip 必须存在且大于 10MB
  const nodeZip = path.join(RELEASE, 'node-portable.zip');
  if (!fs.existsSync(nodeZip) || fs.statSync(nodeZip).size < 10 * 1024 * 1024) {
    console.error(`❌ node-portable.zip 丢失或异常（${fs.existsSync(nodeZip) ? fs.statSync(nodeZip).size + ' bytes' : '不存在'}），发布包不完整！`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`  ✓ 发布包已生成：${RELEASE}`);
  console.log('═══════════════════════════════════════');
  console.log('\n将该文件夹打包为 .zip 即可分发。');
  console.log('用户解压后只需：配置 API 密钥 → 双击 start.bat\n');
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});
