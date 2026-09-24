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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { Readable } from 'node:stream';
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
// 更新面（2026-09 用户裁决：不做静默安装；静默预下载免打扰）：
//   启动 15s 首查 + 每 4h 复查下载面 manifest.json——有新版即后台静默
//   下载安装包（size + sha256 双校验，哈希以 gen-manifest 为准），下载
//   完成不提醒；用户打开版本面板时经桥看到就绪态，点「安装」才拉起
//   安装程序——win = NSIS 向导（覆盖安装自动带出原目录：NSIS 自读
//   HKCU InstallLocation 预填 $INSTDIR，非壳层职责）；mac = 挂载 dmg；
//   linux = 文件管理器定位 AppImage 手动替换。桥不可达或 manifest 无
//   本平台包 → 前端回落下载页外链（同旧版行为）。fail-soft：检查/
//   下载失败静默留痕，绝不打断使用。
// ------------------------------------------------------------
const DOWNLOAD_BASE = 'http://47.110.63.135';

// 暂存区：缺省数据根下 updates/（数据根可被用户迁移，更新暂存属应用
// 自管区，锚在恒在的缺省目录——与日志目录同策略）。
const updatesDir = path.join(defaultDataRoot, 'updates');
const updateStateFile = path.join(updatesDir, 'update.json');

let lastManifest = null;      // 最近一次成功拉取的 manifest（状态面/手动下载复用）
let dlInFlight = false;       // 下载互斥（定时复查与手动触发并发防护）
let dlProgress = null;        // {version, fileName, received, total}——内存进度，GET 即时读
let installLaunched = false;  // 安装只发一次（面板重复点击防护）
let installLauncherOverride = null; // 测试注入（替代真实拉起）

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

async function fetchUpdateManifest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${DOWNLOAD_BASE}/manifest.json`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 本机安装包挑选（manifest releases[0] → platform/arch/扩展名评分最高者；
 *  纯函数（platform/arch 参数化），测试直驱）。blockmap = 增量更新残料，排除。 */
function pickUpdateAsset(manifest, platform = process.platform, arch = process.arch) {
  const releases = manifest && Array.isArray(manifest.releases) ? manifest.releases : [];
  if (releases.length === 0 || !releases[0]) return null;
  const rel = releases[0];
  const plat = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const ar = arch === 'arm64' ? 'arm64' : 'x64';
  const EXT_SCORE = {
    windows: { '.exe': 3, '.msi': 2 },
    macos: { '.dmg': 3, '.zip': 2 },
    linux: { '.appimage': 3, '.deb': 2, '.rpm': 2 },
  };
  let best = null;
  let bestScore = -1;
  for (const f of Array.isArray(rel.files) ? rel.files : []) {
    if (!f || f.platform !== plat || typeof f.url !== 'string') continue;
    if (/blockmap$/i.test(String(f.name ?? ''))) continue;
    const ext = path.extname(String(f.name ?? '')).toLowerCase();
    const score = (f.arch === ar ? 4 : f.arch === 'all' ? 2 : 0) + ((EXT_SCORE[plat] ?? {})[ext] ?? 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best ? { ...best, version: typeof rel.version === 'string' ? rel.version : '' } : null;
}

function readUpdateState() {
  try {
    const st = JSON.parse(fs.readFileSync(updateStateFile, 'utf8'));
    return st && typeof st === 'object' ? st : null;
  } catch {
    return null; // 无状态文件/损坏 = 未下载
  }
}

function writeUpdateState(st) {
  try {
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(updateStateFile, JSON.stringify(st, null, 2), 'utf8');
  } catch (e) {
    log(`[desktop] 更新状态写入失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 清理暂存区非保留文件（旧版本包/断点半包；update.json 除外） */
async function cleanupUpdateFiles(keep) {
  try {
    for (const ent of await fs.promises.readdir(updatesDir)) {
      if (ent === 'update.json') continue;
      // 保留在途 .part：跨重启续传（断点字节不再白下）
      if (typeof keep === 'string' && keep && (ent === keep || ent === `${keep}.part`)) continue;
      await fs.promises.rm(path.join(updatesDir, ent), { force: true, recursive: true });
    }
  } catch { /* 目录不存在 = 无可清理 */ }
}

const DL_MAX_ATTEMPTS = 3;
const DL_RETRY_BASE_MS = 1500;
let dlRetryDelayMs = DL_RETRY_BASE_MS; // 测试注入 0（免真实等待）

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已有 .part 字节数（不存在 = 0） */
async function partBytes(partPath) {
  try { return (await fs.promises.stat(partPath)).size; } catch { return 0; }
}

/**
 * 单次传输：从 .part 已有字节处续传（HTTP Range）→ { sha256, received, resumed }。
 * 传输中断（网络抖动/服务器提前断流）抛错给调用方，.part 保留供下次续传
 * ——这是「重试不再白下 90MB」的关键：sha256 无状态可恢复，续传时把已有
 * 前缀重新并入累计哈希即可得到全量摘要。
 */
async function transferToPart(partPath, expectedSize, url) {
  let received = await partBytes(partPath);
  // 残留字节超过标称大小 = 异常残料（旧版本包/中断错位），丢弃重来
  if (expectedSize !== null && received > expectedSize) {
    await fs.promises.rm(partPath, { force: true });
    received = 0;
  }
  const hash = createHash('sha256');
  if (received > 0) {
    if (expectedSize !== null && received === expectedSize) {
      // 字节已齐（上次卡在校验/改名阶段）——复核哈希即可，不重复下载
      const h = await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(partPath);
        rs.on('error', reject);
        rs.on('data', (c) => { hash.update(c); });
        rs.on('end', () => resolve(hash));
      });
      return { sha256: h.digest('hex'), received, resumed: true };
    }
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(partPath);
      rs.on('error', reject);
      rs.on('data', (c) => { hash.update(c); });
      rs.on('end', resolve);
    });
  }
  const res = await fetch(url, received > 0 ? { headers: { range: `bytes=${received}-` } } : {});
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  if (!res.body) throw new Error('下载失败：响应无实体');
  if (received > 0 && res.status !== 206) {
    // 服务器忽略 Range（下载面未开断点续传）→ 从头写，语义仍正确
    log('[desktop] 服务器未响应 206（不支持断点续传），从头下载');
    await fs.promises.rm(partPath, { force: true });
    received = 0;
  }
  if (dlProgress) dlProgress.received = received;
  const out = fs.createWriteStream(partPath, { flags: received > 0 ? 'a' : 'w' });
  let written = received;
  try {
    // fetch body 是 Web ReadableStream——转 Node 流（单遍流式哈希，92MB 不驻内存）
    for await (const chunk of Readable.fromWeb(res.body)) {
      hash.update(chunk);
      written += chunk.length;
      if (dlProgress) dlProgress.received = written;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    throw err;
  }
  return { sha256: hash.digest('hex'), received: written, resumed: received > 0 };
}

/**
 * 静默下载 + 双校验（size + sha256）。
 * 韧性（2026-09 用户裁决追加）：断点续传 + 指数退避重试——传输中断/不完整
 * 保留 .part 续传，哈希不符（字节损坏）丢弃 .part 重下（坏前缀不可续传）。
 * 原子性：全程写 <file>.part，校验通过才 rename 为正式名——任何时刻进程被
 * 杀都不会留下「看似就绪实则半包」的文件。
 */
async function downloadInstallerAsync(asset) {
  const fileName = path.basename(String(asset.name ?? `agentchat-${asset.platform}-${asset.arch}`));
  const dest = path.join(updatesDir, fileName);
  const partPath = `${dest}.part`;
  const expectedSize = typeof asset.size === 'number' ? asset.size : null;
  const expectedSha = typeof asset.sha256 === 'string' ? asset.sha256.toLowerCase() : null;
  const url = new URL(asset.url, `${DOWNLOAD_BASE}/`).href;
  dlInFlight = true;
  dlProgress = { version: asset.version, fileName, received: 0, total: expectedSize ?? 0 };
  try {
    await fs.promises.mkdir(updatesDir, { recursive: true });
    writeUpdateState({
      version: asset.version, fileName,
      size: expectedSize, sha256: expectedSha,
      status: 'downloading', startedAt: new Date().toISOString(),
    });
    let lastErr = null;
    let delay = dlRetryDelayMs;
    for (let attempt = 1; attempt <= DL_MAX_ATTEMPTS; attempt++) {
      try {
        const { sha256, received } = await transferToPart(partPath, expectedSize, url);
        if (expectedSize !== null && received !== expectedSize) {
          const e = new Error(`传输不完整（${received}/${expectedSize} 字节），将续传`);
          e.incomplete = true;
          throw e;
        }
        if (expectedSha && sha256 !== expectedSha) {
          const e = new Error('sha256 校验失败（字节损坏）');
          e.corrupt = true;
          throw e;
        }
        // 通过：原子落位（Windows rename 不覆盖既有项，先清）
        await fs.promises.rm(dest, { force: true });
        await fs.promises.rename(partPath, dest);
        if (process.platform === 'linux' && /\.appimage$/i.test(dest)) {
          fs.chmodSync(dest, 0o755); // AppImage 可执行（linux 形态手动替换用）
        }
        writeUpdateState({
          version: asset.version, fileName,
          size: expectedSize, sha256: expectedSha,
          status: 'ready', downloadedAt: new Date().toISOString(),
        });
        log(`[desktop] 新版安装包就绪：${fileName}（${(received / 1048576).toFixed(1)} MB，sha256 通过${attempt > 1 ? `，第 ${attempt} 次尝试` : ''}）`);
        await cleanupUpdateFiles(fileName);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // 坏字节不可续传（会把损坏前缀带进最终哈希），丢弃重下
        if (err && err.corrupt) {
          await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
          if (dlProgress) dlProgress.received = 0;
        }
        if (attempt < DL_MAX_ATTEMPTS) {
          log(`[desktop] 下载尝试 ${attempt}/${DL_MAX_ATTEMPTS} 失败（${msg}），${Math.round(delay)}ms 后重试`);
          await sleep(delay);
          delay *= 2;
        }
      }
    }
    throw lastErr ?? new Error('下载失败');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[desktop] 安装包下载失败（已试 ${DL_MAX_ATTEMPTS} 次）：${msg}`);
    // 半包留在 .part：下次检查/手动重试可继续续传；正式名不会有半成品
    const prev = readUpdateState();
    writeUpdateState({ ...(prev ?? {}), version: asset.version, fileName, status: 'failed', error: msg, failedAt: new Date().toISOString() });
  } finally {
    dlInFlight = false;
    dlProgress = null;
  }
}

async function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const manifest = await fetchUpdateManifest();
    if (!manifest) return;
    lastManifest = manifest;
    const latest = Array.isArray(manifest.releases) && manifest.releases[0]?.version;
    if (typeof latest !== 'string' || latest === '') return;
    const current = app.getVersion();
    if (cmpVersion(latest, current) <= 0) return;
    log(`[desktop] 发现新版本 ${latest}（当前 ${current}）——后台静默预下载`);
    const asset = pickUpdateAsset(manifest);
    if (!asset) { log('[desktop] manifest 无本平台安装包，跳过预下载'); return; }
    if (dlInFlight) return;
    const st = readUpdateState();
    if (st?.status === 'ready' && st.version === latest
        && fs.existsSync(path.join(updatesDir, String(st.fileName ?? '')))) return; // 已就绪
    downloadInstallerAsync(asset).catch(() => undefined); // 内部自捕，fail-soft
  } catch (err) {
    log(`[desktop] 更新检查失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeAppVersion() {
  try { return app.getVersion(); } catch { return '0.0.0'; }
}

/** 桥状态面（GET /desktop-bridge/update 的 JSON 体） */
function updateStatusJson() {
  const latest = Array.isArray(lastManifest?.releases) && lastManifest.releases[0]?.version;
  const st = readUpdateState();
  const out = {
    current: safeAppVersion(),
    latest: typeof latest === 'string' ? latest : null,
    latestUrl: `${DOWNLOAD_BASE}/`,
    supported: typeof latest === 'string' ? pickUpdateAsset(lastManifest) !== null : null,
    status: 'idle', version: null, fileName: null, size: null,
    received: 0, total: 0, error: null,
  };
  if (dlProgress) {
    Object.assign(out, { status: 'downloading', version: dlProgress.version, fileName: dlProgress.fileName, received: dlProgress.received, total: dlProgress.total, size: dlProgress.total });
    return out;
  }
  if (!st) return out;
  out.version = st.version ?? null;
  out.fileName = st.fileName ?? null;
  out.size = st.size ?? null;
  out.error = st.error ?? null;
  if (st.status === 'failed') out.status = 'failed';
  else if (st.status === 'ready' && typeof st.fileName === 'string' && fs.existsSync(path.join(updatesDir, st.fileName))) {
    // 就绪但已被更新版本取代 → 视作待重下（检查器会拉新版并清旧包）
    out.status = out.latest && cmpVersion(out.latest, String(st.version ?? '0.0.0')) > 0 ? 'idle' : 'ready';
  }
  return out;
}

/** 拉起安装程序并整壳退场（win=安装向导覆盖原目录；mac=挂载 dmg；
 *  linux=定位文件手动替换）。拉起异常仍退场——用户可手动运行暂存包。 */
async function launchInstaller(file) {
  if (installLauncherOverride) { await installLauncherOverride(file); return; }
  log(`[desktop] 拉起安装程序：${file}`);
  try {
    if (process.platform === 'win32') {
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      await shell.openPath(file);
    } else {
      shell.showItemInFolder(file);
    }
  } catch (err) {
    log(`[desktop] 安装程序拉起异常（仍退场）: ${err instanceof Error ? err.message : String(err)}`);
  }
  quitting = true;
  killBackendTree();
  setTimeout(() => app.exit(0), 500).unref();
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
  // ---- 更新面（前端版本面板：状态查询 / 手动触发下载 / 拉起安装）----
  if (url.pathname === '/desktop-bridge/update' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(updateStatusJson()));
    return;
  }
  if (url.pathname === '/desktop-bridge/update/download' && req.method === 'POST') {
    // 手动触发（面板打开且已在检查中）：仍需拉一次 manifest 拿最新条目；
    // 下载中幂等返回（不重复起流）。
    (async () => {
      try {
        if (dlInFlight) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"started":false,"reason":"in-flight"}'); return; }
        let manifest = lastManifest;
        try { manifest = await fetchUpdateManifest(); if (manifest) lastManifest = manifest; } catch { /* 离线兜底用上次 */ }
        const asset = manifest ? pickUpdateAsset(manifest) : null;
        if (!asset) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"started":false,"reason":"no-asset"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ started: true, version: asset.version }));
        downloadInstallerAsync(asset).catch(() => undefined);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    })();
    return;
  }
  if (url.pathname === '/desktop-bridge/update/install' && req.method === 'POST') {
    const st = readUpdateState();
    const body = JSON.stringify({
      ok: false,
      error: st?.status === 'ready' ? '' : '安装包未就绪',
    });
    if (st?.status !== 'ready' || typeof st.fileName !== 'string'
        || !fs.existsSync(path.join(updatesDir, st.fileName))) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}');
    if (!installLaunched) {
      installLaunched = true;
      launchInstaller(path.join(updatesDir, st.fileName)).catch((e) => {
        log(`[desktop] 安装拉起失败: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
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
  // 更新面：先清暂存区断点残料（半包/无状态包），再定时静默检查
  // （15s 首查 + 4h 复查——长驻形态不漏发版；下载完成不提醒，面板见）。
  cleanupUpdateFiles(readUpdateState()?.fileName ?? null).catch(() => undefined);
  setTimeout(checkForUpdates, 15_000).unref();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000).unref();
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

// ---- 测试面导出（desktop-bridge.test.ts / desktop-update.test.ts 驱动；Electron 主进程入口不受影响） ----
export { startBridge };
export { pickUpdateAsset, readUpdateState, updateStatusJson, cmpVersion, downloadInstallerAsync };
export { updatesDir as __testUpdatesDir };
/** 测试注入口：替代真实安装器拉起（避免测试态真起进程/弹挂载） */
export function __testSetInstallLauncher(fn) { installLauncherOverride = fn; }
/** 测试注入口：重试退避延时（0 = 用例免等待） */
export function __testSetRetryDelay(ms) { dlRetryDelayMs = ms; }
export { transferToPart, partBytes };
async function __testCloseBridge() {
  const srv = bridgeServer;
  bridgeServer = null;
  if (!srv) return;
  await new Promise((resolve) => srv.close(() => resolve()));
}
export { __testCloseBridge };
