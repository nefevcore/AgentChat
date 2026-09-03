// ============================================================
// desktop/main.mjs —— AgentChat 桌面壳（Electron 主进程）
//
// 职责唯一：把 dist 发布产物（agentchat.mjs 单文件后端 +
// plugin-catalog.json 插件目录清单 + WebUI 静态产物）以纯 Node 进程
// 拉起，并把窗口指到它的 127.0.0.1 监听地址上。
//
// 关键语义（与 npm 包形态同一条路径，见 src/ac-app/src/bootstrap.ts）：
//   · 后端 = spawn(process.execPath, [agentchat.mjs, --port, N]) +
//     ELECTRON_RUN_AS_NODE=1 —— 复用 Electron 自带 Node（≥20，满足
//     engines），不引入第二条运行时；
//   · 插件目录：bundle 同目录的 plugin-catalog.json 是生产源（0.8.1
//     落地的构建期清单），壳层再用 AGENTCHAT_PLUGIN_MANIFEST 显式指路
//     兜底——不复制也不绕开 npm 形态已验证的回退链；
//   · 数据根 = Electron userData（显式 AGENTCHAT_DATA_ROOT；不设则
//     bootstrap 会锚定"启动文件夹"，桌面形态下是安装目录甚至系统
//     目录，不可接受）；
//   · 端口：优先 3830，被占退避随机口（后端 EADDRINUSE 不炸进程但也
//     不换口，选口职责在壳）；WebUI 的 WS 走 location.host 同源拼接，
//     换口对前端无感；
//   · 单实例：壳层 requestSingleInstanceLock 先拦，后端数据根文件锁
//     只在壳锁失效时兜底；
//   · 生命周期：关窗 = 隐藏到托盘（Agent 社区的定时任务/自主节奏依赖
//     常驻进程）；托盘「退出」= 杀后端进程树（含 shell 工具子树）后退出。
// ============================================================
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

const DEFAULT_PORT = 3830;
const READY_TIMEOUT_MS = 45_000;
const EXIT_CONFIG = 78; // 与 ac-supervisor-core 的 EXIT_CONFIG 同值

// ---- 路径形态 ----
// packaged: <install>/resources/agentchat/（extraResources，不在 asar 内——
//           后端要以真实文件路径读同目录静态产物与清单）
// dev（electron .）: 仓库 dist/（需先 pnpm build:frontend && pnpm build:bundle）
const backendDir = app.isPackaged
  ? path.join(process.resourcesPath, 'agentchat')
  : path.join(app.getAppPath(), '..', 'dist');
const backendEntry = path.join(backendDir, 'agentchat.mjs');
const catalogManifest = path.join(backendDir, 'plugin-catalog.json');
const iconPath = path.join(import.meta.dirname, 'build', 'icon.png');

// 数据根锚定：显式 <appData>/AgentChat——不依赖 Electron 的 app 名解析
// （dev 形态 ESM 主进程不读 productName，userData 会变成 ac-desktop/，
// 与 packaged 形态漂移）；Windows %APPDATA%\AgentChat、Linux ~/.config/AgentChat。
const dataRoot = path.join(app.getPath('appData'), 'AgentChat');
const logDir = path.join(dataRoot, 'logs');
const backendLogPath = path.join(logDir, 'backend.log');
const LOG_TAIL_MAX = 300;

let mainWindow = null;
let tray = null;
let backend = null;
let quitting = false;
let fatalShown = false;
let trayNotified = false;
const logTail = [];

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  logTail.push(text);
  if (logTail.length > LOG_TAIL_MAX) logTail.shift();
  fs.appendFile(backendLogPath, `${text}\n`, () => undefined); // fail-soft
}

function tailText() {
  return logTail.slice(-30).join('\n');
}

// ------------------------------------------------------------
// 后端生命周期
// ------------------------------------------------------------
function spawnBackend(port) {
  backend = spawn(process.execPath, [backendEntry, '--port', String(port)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENTCHAT_DATA_ROOT: dataRoot,
      AGENTCHAT_PLUGIN_MANIFEST: catalogManifest,
      AGENTCHAT_DESKTOP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  log(`[desktop] 后端已拉起 pid=${backend.pid} → http://127.0.0.1:${port}`);

  backend.stdout.setEncoding('utf8');
  backend.stdout.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`[backend] ${line}`);
  });
  backend.stderr.setEncoding('utf8');
  backend.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`[backend:err] ${line}`);
  });
  backend.on('exit', (code, signal) => {
    log(`[desktop] 后端退出 code=${code ?? '?'} signal=${signal ?? '-'}`);
    if (!quitting) {
      const hint = code === EXIT_CONFIG
        ? '后端装载失败（配置/组合错误，退出码 78）。\n常见原因：数据根损坏或 cordis.patch.yml 非法。'
        : '后端进程意外退出。';
      fatal(`${hint}\n\n日志尾部：\n${tailText()}`);
    }
  });
  return backend;
}

/** 杀后端进程树：先礼后兵（3s 后 taskkill /F /T——shell 工具孙进程不孤儿） */
function killBackendTree() {
  if (!backend || backend.exitCode !== null) return;
  const pid = backend.pid;
  backend.kill();
  setTimeout(() => {
    if (!backend || backend.exitCode !== null) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      backend.kill('SIGKILL');
    }
  }, 3000).unref();
}

// ------------------------------------------------------------
// 端口与就绪探测
// ------------------------------------------------------------
function listenProbe(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    // port=0 = 让内核分配；必须取 address().port（参数 0 不是端口）
    srv.listen(port, '127.0.0.1', () => {
      const actual = srv.address()?.port ?? port;
      srv.close(() => resolve(actual));
    });
  });
}

/** 优先缺省口，被占退避随机口（close 与后端 listen 之间的窗口极小，可接受） */
async function pickPort() {
  try {
    return await listenProbe(DEFAULT_PORT);
  } catch {
    /* 3830 被占 */
  }
  const port = await listenProbe(0);
  log(`[desktop] 缺省端口 ${DEFAULT_PORT} 被占用，退避随机端口 ${port}`);
  return port;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume(); // 丢弃正文，只要状态码
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

/** 轮询 / 直至后端静态站可服务（后端退出由 exit 处理器另行触发 fatal） */
async function waitForReady(port) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await httpGet(url) === 200) return true;
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ------------------------------------------------------------
// 窗口 / 托盘
// ------------------------------------------------------------
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'AgentChat',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      // WebUI 是普通 Web 应用（同 npm 形态，CSP 由前端产物自带）；
      // 不开 nodeIntegration，不需要 preload。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    // 关窗 = 收进托盘：Agent 社区（定时任务/主动发言）依赖常驻进程。
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
      if (!trayNotified && Notification.isSupported()) {
        trayNotified = true;
        new Notification({
          title: 'AgentChat 仍在运行',
          body: '社区已最小化到托盘，Agent 的定时任务与自主对话持续进行。点击托盘图标可回到主窗口；「退出」才会真正停止。',
        }).show();
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链走系统浏览器；站内只允许同源导航
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });

  mainWindow.loadURL(url);
}

function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (!fs.existsSync(iconPath)) return; // 无图标不成托盘（图标随包必带）
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('AgentChat');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 AgentChat', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMainWindow());
}

// ------------------------------------------------------------
// 自动更新（fail-soft：发布在公开仓库 Releases，匿名可检查）
// ------------------------------------------------------------
async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    await autoUpdater.checkForUpdatesAndNotify();
    log('[desktop] 自动更新检查完成');
  } catch (err) {
    log(`[desktop] 自动更新检查失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------
// 启动编排
// ------------------------------------------------------------
function fatal(message) {
  if (fatalShown) return;
  fatalShown = true;
  dialog.showErrorBox('AgentChat 启动失败', `${message}\n\n完整日志：${backendLogPath}`);
  quitting = true;
  app.quit();
}

async function start() {
  await fs.promises.mkdir(logDir, { recursive: true });
  log(`[desktop] 启动（${app.isPackaged ? 'packaged' : 'dev'}）后端目录：${backendDir}`);

  if (!fs.existsSync(backendEntry)) {
    fatal(`后端 bundle 缺失：${backendEntry}\n安装可能不完整，请重新安装 AgentChat。`);
    return;
  }

  const port = await pickPort();
  spawnBackend(port);

  if (!await waitForReady(port)) {
    fatal(`后端 ${READY_TIMEOUT_MS / 1000} 秒内未就绪（http://127.0.0.1:${port}/）。\n\n日志尾部：\n${tailText()}`);
    return;
  }
  log(`[desktop] 后端就绪，加载 WebUI`);

  createWindow(`http://127.0.0.1:${port}/`);
  createTray();
  setTimeout(checkForUpdates, 15_000).unref();
}

// ---- 单实例锁（壳层先拦；后端数据根文件锁兜底） ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.nefevcore.agentchat');
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(start);
  app.on('before-quit', () => {
    quitting = true;
    killBackendTree();
  });
}
