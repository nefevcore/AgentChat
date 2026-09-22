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

// 数据根锚定：指针读取链（2026-09-16 存储管理裁决）
//   env AGENTCHAT_DATA_ROOT（调试/CI 覆盖）
//   > 注册表 HKCU\Software\AgentChat\DataRoot（预留：安装向导/企业部署写入面）
//   > <appData>/AgentChat/data-root.txt（设置面板「存储管理」写入面）
//   > 缺省 <appData>/AgentChat
// 指针文件放【缺省目录】而非数据根本身——数据根可被切换，缺省目录永远
// 先于一切存在（logs 在此），是稳定的引导配置锚点。指针失效（路径不可
// 写/不存在）= 回落缺省并在日志留痕，不 fatal（数据根切换错误不该阻止
// 应用启动——用户可再切回）。
const defaultDataRoot = path.join(app.getPath('appData'), 'AgentChat');
const pointerFile = path.join(defaultDataRoot, 'data-root.txt');

function readDataRootPointer() {
  if (process.env.AGENTCHAT_DATA_ROOT) return process.env.AGENTCHAT_DATA_ROOT;
  try {
    const reg = safeReadRegistry();
    if (reg) return reg;
  } catch { /* 注册表不可用（非 win / 权限）——跳过该层 */ }
  try {
    const p = fs.readFileSync(pointerFile, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
    if (p) log?.(`[desktop] 数据根指针失效（路径不存在），回落缺省：${p}`);
  } catch { /* 无指针文件 = 首次 */ }
  return defaultDataRoot;
}

/** win 注册表读取（预留通道；非 win 返回 null） */
function safeReadRegistry() {
  if (process.platform !== 'win32' || !app.isPackaged) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process');
    const out = execSync(
      `reg query HKCU\\Software\\AgentChat /v DataRoot 2>nul`,
      { encoding: 'utf8', timeout: 3000 },
    );
    const m = out.match(/DataRoot\s+REG_SZ\s+(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeDataRootPointer(p) {
  fs.mkdirSync(defaultDataRoot, { recursive: true });
  if (path.resolve(p) === path.resolve(defaultDataRoot)) {
    // 切回缺省 = 清指针（缺省本来就是回落值，指针文件没必要存在）
    try { fs.rmSync(pointerFile); } catch { /* 无文件 */ }
    return;
  }
  fs.writeFileSync(pointerFile, path.resolve(p), 'utf8');
}

const dataRoot = readDataRootPointer();
const logDir = path.join(defaultDataRoot, 'logs'); // 日志恒在缺省目录——数据根换了日志还能找到
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

// ---- 进程级兜底（P2）：壳主进程的异步错误此前零防护——listen EACCES 一类
// 错误经 EventEmitter throw 上炸 uncaughtException，Electron 默认弹
// "A JavaScript error occurred in the main process" 后整壳退出。
// 兜底策略 = 先留现场（落盘 backend.log + 尾队）再默认退出：壳职责薄
// （spawn/窗口/托盘），吞异常续跑有状态损坏风险，关键失败路径已有 fatal()。
process.on('uncaughtException', (err) => {
  log(`[desktop] uncaughtException: ${err && err.stack ? err.stack : String(err)}`);
  dialog.showErrorBox(
    'AgentChat 出错退出',
    `主进程发生未捕获异常：\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n\n完整日志：${backendLogPath}`,
  );
  quitting = true;
  killBackendTree();
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`[desktop] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

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

  // 刷新快捷键（窗口级 before-input-event，非 globalShortcut——托盘常驻
  // 不该全局劫持系统 F5）：F5 常规刷新 / Ctrl+F5 忽略缓存强刷。WebUI 自带
  // WS 断线重连与交互恢复协议（wire.ts），刷新只重建页面壳，后端常驻不受
  // 影响——这是"页面卡死"场景的手动保险丝（菜单已移除，Ctrl+R 无默认行为）。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.key !== 'F5') return;
    event.preventDefault();
    if (input.control) mainWindow.webContents.reloadIgnoringCache();
    else mainWindow.webContents.reload();
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
  // createFromPath 自动带上同名 icon@2x.png（32×32）作为 2x 表示；resize 到
  // 16pt 后双表示保留——Retina/HiDPI 屏由系统挑 2x rep，普通屏用 1x。
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
// 更新提醒（2026-09 分发自托管裁决 remote-client-relay-plan §4.6：
//   桌面安装包不再上 GitHub Releases——electron-updater feed 失效退役，
//   改 ~30 行 manifest 检查：下载面 manifest.json 比版本，有新版仅提醒
//   「前往下载」打开下载主页，三平台同构（macOS 本就只提醒，行为不变）。
//   sha256 校验在下载页侧（文件完整性以哈希为准）；静默自动升级
//   （NSIS /S + sha256）留作后续可选。fail-soft：检查失败静默跳过。）
// ------------------------------------------------------------
const DOWNLOAD_BASE = 'http://47.110.63.135';

async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let manifest;
    try {
      const res = await fetch(`${DOWNLOAD_BASE}/manifest.json`, { signal: controller.signal });
      if (!res.ok) return;
      manifest = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const latest = Array.isArray(manifest?.releases) && manifest.releases[0]?.version;
    if (typeof latest !== 'string' || latest === '') return;
    const current = app.getVersion();
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
      return 0;
    };
    if (cmp(latest, current) <= 0) return;
    log(`[desktop] 发现新版本 ${latest}（当前 ${current}）`);
    const n = new Notification({
      title: `AgentChat ${latest} 可用`,
      body: '点击前往下载页获取新版本安装包。',
    });
    n.on('click', () => { shell.openExternal(DOWNLOAD_BASE); });
    n.show();
  } catch (err) {
    log(`[desktop] 更新检查失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------
// 存储管理桥（P2：WebUI 设置面板「存储管理」的壳层半边）
//   独立回环 http server（pickedPort+1，WebUI 从 location.port 推导同源族）。
//   GET  /desktop-bridge/storage       —— 当前数据根 + 占用统计
//   POST /desktop-bridge/storage/pick  —— 原生目录选择对话框（Electron dialog）
//   POST /desktop-bridge/storage/set   —— 切换数据根（可选迁移）→ 壳层重启
//   只监听 127.0.0.1；仅桌面形态存在（WebUI 按 fetch 失败优雅隐藏面板）。
// ------------------------------------------------------------
let bridgeServer = null;

function dirSize(p) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) total += dirSize(full);
      else { try { total += fs.statSync(full).size; } catch { /* 并发删 */ } }
    }
  } catch { /* 不存在 */ }
  return total;
}

function storageInfo() {
  const breakdown = {};
  for (const sub of ['sessions', 'agents', 'workspace', 'logs', 'reports', 'backups']) {
    const p = path.join(dataRoot, sub);
    if (fs.existsSync(p)) breakdown[sub] = dirSize(p);
  }
  return {
    dataRoot,
    defaultDataRoot,
    customized: path.resolve(dataRoot) !== path.resolve(defaultDataRoot),
    total: dirSize(dataRoot),
    breakdown,
    platform: process.platform,
  };
}

/** 数据根切换：可选迁移（关后端→移动→指针→relaunch）。跨盘 fallback cp+校验。 */
async function setStorageRoot(newRoot, { migrate }) {
  const target = path.resolve(newRoot);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  if (path.resolve(target) !== path.resolve(dataRoot)) {
    const existing = fs.readdirSync(target);
    if (existing.length > 0) throw new Error(`目标目录非空（${existing.length} 项）——为防覆盖已有数据已拒绝。请选择空目录。`);
  }
  if (migrate && path.resolve(target) !== path.resolve(dataRoot)) {
    killBackendTree();
    await new Promise((resolve) => {
      const t = setInterval(() => { if (!backend || backend.exitCode !== null) { clearInterval(t); resolve(); } }, 200);
      setTimeout(() => { clearInterval(t); resolve(); }, 8000);
    });
    try {
      fs.renameSync(dataRoot, target); // 同盘原子
    } catch {
      // 跨盘（EXDEV）：cp + 大小校验 + 删源——失败保源不切换
      fs.cpSync(dataRoot, target, { recursive: true });
      const srcSize = dirSize(dataRoot);
      if (dirSize(target) < srcSize * 0.999) throw new Error('跨盘复制校验失败（目标小于源）——已保留原数据，未切换。');
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(logDir, { recursive: true }); // 日志锚点恒在缺省目录（rename 整根后被带走，重建）
  }
  writeDataRootPointer(target);
  log(`[desktop] 数据根已切换：${dataRoot} → ${target}（migrate=${migrate}），应用即将重启`);
  return { ok: true, restarting: true };
}

// 桥 CORS：桥口与页面口不同源（3831 vs 3830），页面 fetch 桥是跨源请求——
// 拦截有两层：① CSP connect-src（src/webui/index.html 已放行 http://127.0.0.1:*，
// 覆盖 pickedPort+1..+4 候选序列——2026-09-22 修复：此前只有 'self'，CSP 先于
// CORS 拦死桥探活 → 存储管理节静默降级隐藏）；② 本处 CORS 头，无则浏览器拦死
// （probe 失败 → 存储节永远隐藏，即便端口没被占）。
// 仅放行回环 Origin（与 ac-web-server checkRequestOrigin 同口径：局域网/外网一律拒）。
function isLoopbackOrigin(origin) {
  const h = origin.replace(/^https?:..(.)/i, '$1').replace(/:[0-9]+$/, '').toLowerCase();
  return h === 'localhost' || h === '[::1]' || h.startsWith('127.');
}

function bridgeCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isLoopbackOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function bridgeHandler(req, res, port) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  bridgeCors(req, res);
  if (req.method === 'OPTIONS') { // CORS 预检（简单请求本不需要，防御性应答）
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/desktop-bridge/storage' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(storageInfo()));
    return;
  }
  if (url.pathname === '/desktop-bridge/storage/pick' && req.method === 'POST') {
    dialog.showOpenDialog(mainWindow ?? undefined, { properties: ['openDirectory', 'createDirectory'] })
      .then((r) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ canceled: r.canceled, path: r.filePaths?.[0] ?? null }));
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e) }));
      });
    return;
  }
  if (url.pathname === '/desktop-bridge/storage/set' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { path: newRoot, migrate } = JSON.parse(body || '{}');
        if (typeof newRoot !== 'string' || !newRoot.trim()) throw new Error('缺少 path');
        const out = await setStorageRoot(newRoot, { migrate: migrate === true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
        // 给前端 1.5s 收响应，然后整壳重启（后端+窗口全部重来）
        setTimeout(() => { quitting = true; killBackendTree(); app.relaunch(); app.exit(0); }, 1500);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
}

/** resolve(实际监听口) / reject(listen 错误——EACCES/EADDRINUSE 等经 error 事件异步抵达) */
function startBridge(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => bridgeHandler(req, res, port));
    srv.once('error', (e) => {
      bridgeServer = null;
      reject(e);
    });
    srv.listen(port, '127.0.0.1', () => {
      bridgeServer = srv;
      log(`[desktop] 存储管理桥：http://127.0.0.1:${port}/desktop-bridge/`);
      resolve(port);
    });
  });
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
  // 存储管理桥：候选序列 pickedPort+1 → +4（WebUI 同序列探测）。listen 错误
  // （EACCES=Hyper-V/WinNAT 排除区、EADDRINUSE=被占）经 error 事件异步抵达，
  // 由 startBridge 的 Promise 化捕获——全部候选失败则桥退化不可用（设置面板
  // fetch 失败即隐藏该节，非致命，绝不上炸主进程）。
  for (const cand of [port + 1, port + 2, port + 3, port + 4]) {
    try { await startBridge(cand); break; }
    catch (e) {
      log(`[desktop] 桥候选口 ${cand} 不可用（${e.code ?? ''} ${e.message}），试下一个`);
    }
  }

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
  // macOS：关窗=收托盘后，点 dock 图标没有默认恢复路径——补 activate 恢复
  // （win/linux 不触发该事件，无影响）。
  app.on('activate', () => showMainWindow());
  app.whenReady().then(start);
  app.on('before-quit', () => {
    quitting = true;
    killBackendTree();
  });
}

// ---- 测试面导出（desktop-bridge.test.ts 驱动；Electron 主进程入口不受影响） ----
export { startBridge };
async function __testCloseBridge() {
  const srv = bridgeServer;
  bridgeServer = null;
  if (!srv) return;
  await new Promise((resolve) => srv.close(() => resolve()));
}
export { __testCloseBridge };
