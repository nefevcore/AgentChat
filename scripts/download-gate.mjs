// ============================================================
// scripts/download-gate.mjs —— 下载面（公开静态 + 全局配额门）（M3.5）
//
// 方案 §4.6「下载面防护四件套」的 Node 那两件：
//   · **全局配额门**：Nginx 做不了跨重启的全局计数，故由本进程计数、
//     **持久化在磁盘**（count-<YYYYMM>.json），跨重启/重部署都连续；
//   · **只计安装包**：主页/manifest/图标命中不计配额（它们是浏览行为，
//     不是下载行为）；
//   · **不过手字节**（--behind-nginx）：未超限时回 `X-Accel-Redirect`，
//     由 Nginx 从内部 location 直接发文件——Node 只做计数与判权，
//     大文件（90MB+）不经它转发，进程内存与 CPU 都不受影响。
//     本地/小规模可直接用 Node 发字节（缺省模式）。
//   · **GET /api/quota**：剩余次数（主页展示用）。
//
// 另两件（同 IP 限流 limit_req/limit_conn/limit_rate、账单告警）属 Nginx 与
// 云监控职责——见 src/docs 的部署段。
//
// 用法：
//   node scripts/download-gate.mjs --root <静态根> [--port 18080] [--quota 200]
//        [--state <计数目录>] [--behind-nginx --internal-prefix /__dl]
// ============================================================
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** 计入配额的文件类型（安装包；其余走公开静态不计） */
const INSTALLER_EXT = new Set(['.apk', '.exe', '.dmg', '.zip', '.appimage', '.msi']);

function argOf(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(flag + ' 缺值');
  return v;
}

const argv = process.argv.slice(2);
const root = resolve(argOf(argv, '--root', 'downloads'));
const port = Number(argOf(argv, '--port', '18080'));
const quota = Number(argOf(argv, '--quota', '200'));
const stateDir = resolve(argOf(argv, '--state', '.dsh/tmp/download-gate'));
const behindNginx = argv.includes('--behind-nginx');
const internalPrefix = argOf(argv, '--internal-prefix', '/__dl');

if (!existsSync(root)) {
  console.error('[gate] 静态根不存在: ' + root);
  process.exit(1);
}
mkdirSync(stateDir, { recursive: true });

/** 当月计数文件（按月分片——跨月自动归零，无需定时任务） */
function statePath(now = new Date()) {
  const ym = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(stateDir, 'count-' + ym + '.json');
}

/** 读计数（缺失/损坏一律当 0——计数不该阻断服务） */
function readCount() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    return { used: Number(raw.used) || 0, byFile: raw.byFile || {} };
  } catch {
    return { used: 0, byFile: {} };
  }
}

function bumpCount(fileName) {
  const c = readCount();
  c.used += 1;
  c.byFile[fileName] = (c.byFile[fileName] || 0) + 1;
  // 原子性够用：单进程单线程，写失败也不影响已发出的响应
  writeFileSync(statePath(), JSON.stringify(c, null, 2) + '\n');
  return c;
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.byteLength),
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** 路径解析（防穿越：解析后必须仍在静态根内） */
function resolveUnderRoot(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // 配额查询（主页展示；不计配额）
  if (path === '/api/quota') {
    const c = readCount();
    json(res, 200, { quota, used: c.used, remaining: Math.max(0, quota - c.used), month: statePath().replace(/^.*count-/, '').replace(/\.json$/, '') });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const file = resolveUnderRoot(path);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    // 404 也要有日志：静默 404 会让「客户端为什么拿不到清单」变成瞎猜
    // （实测踩过：URL 比静态根多一层目录，现象与「网络不通」无法区分）
    console.log('[gate] 404 ' + path);
    json(res, 404, { error: 'not found' });
    return;
  }

  const name = file.slice(root.length + 1).split(sep).join('/');
  const isInstaller = INSTALLER_EXT.has(extname(file).toLowerCase());

  if (isInstaller) {
    const c = readCount();
    if (c.used >= quota) {
      // 超限不给字节——这是流量费的硬顶（方案 §4.6 的成本数学）
      json(res, 403, { error: '本月下载配额已用完', quota, used: c.used });
      console.log('[gate] 拒绝 ' + name + '（配额 ' + c.used + '/' + quota + '）');
      return;
    }
    bumpCount(name);
  }

  const size = statSync(file).size;
  const headers = {
    'content-length': String(size),
    'content-type': contentTypeOf(file),
    'accept-ranges': 'none',
    // 公开产物可缓存（同版本字节不变；带 sha256 的客户端仍会校验）
    'cache-control': isInstaller ? 'no-store' : 'public, max-age=300',
  };

  if (behindNginx) {
    // 不过手字节：让 Nginx 从内部 location 发（本进程只计数与判权）
    res.writeHead(200, { ...headers, 'x-accel-redirect': internalPrefix + '/' + name });
    res.end();
  } else {
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  }
  console.log('[gate] ' + (isInstaller ? '下载' : '公开') + ' ' + name + ' (' + size + 'B)');
});

function contentTypeOf(file) {
  const e = extname(file).toLowerCase();
  if (e === '.apk') return 'application/vnd.android.package-archive';
  if (e === '.json') return 'application/json; charset=utf-8';
  if (e === '.html') return 'text/html; charset=utf-8';
  if (e === '.exe') return 'application/vnd.microsoft.portable-executable';
  if (e === '.zip') return 'application/zip';
  return 'application/octet-stream';
}

server.listen(port, '127.0.0.1', () => {
  // 打印**实际**端口（port=0 时由系统分配——验证脚本靠这行拿地址）
  const actual = server.address().port;
  console.log('[gate] 监听 http://127.0.0.1:' + actual + '  root=' + root);
  console.log('[gate] 配额 ' + quota + '/月  状态 ' + statePath());
  console.log('[gate] 模式 ' + (behindNginx ? 'behind-nginx（X-Accel-Redirect ' + internalPrefix + '）' : '直接发字节'));
});

