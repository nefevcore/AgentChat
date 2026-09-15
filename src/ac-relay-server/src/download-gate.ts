// download-gate.ts —— 下载面配额门（remote-client-relay-plan §4.6）
//
//   · 全局 1000 次/月（可配 DL_GATE_QUOTA），只计安装包扩展名命中
//   · 计数持久化 /var/lib/agentchat-gate/count-<YYYYMM>.json（防重启丢失）
//   · 未超限 → X-Accel-Redirect 内部发文件（Nginx 发字节，Node 不转流量）
//   · 超限 → 403 JSON（主页可读）
//   · GET /api/quota → 剩余次数（主页展示用，不计入配额）
//   · GET /healthz → 存活（恒 200，无信息量）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PORT = Number(process.env.DL_GATE_PORT ?? 12700);
const ROOT = process.env.DL_GATE_ROOT ?? '/var/www/agentchat/downloads';
const STATE_DIR = process.env.DL_GATE_STATE ?? '/var/lib/agentchat-gate';
const QUOTA = Number(process.env.DL_GATE_QUOTA ?? 1000);
/** 计入配额的扩展名（manifest/主页/图标不计） */
const COUNTED = new Set(['.exe', '.msi', '.dmg', '.zip', '.apk', '.appimage', '.deb', '.rpm', '.exe.blockmap']);

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function statePath(): string {
  return join(STATE_DIR, `count-${monthKey()}.json`);
}

function readCount(): number {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8')) as { count?: number };
    return typeof j.count === 'number' ? j.count : 0;
  } catch {
    return 0;
  }
}

/** 写穿持久化（同步写——计数低频，简单即正确；tmp+rename 原子性） */
function writeCount(n: number): void {
  mkdirSync(dirname(statePath()), { recursive: true });
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ count: n, month: monthKey(), updatedAt: new Date().toISOString() }));
  renameSync(tmp, statePath());
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method not allowed' });
  }

  if (path === '/healthz') return json(res, 200, { ok: true });

  if (path === '/api/quota') {
    return json(res, 200, { ok: true, quota: QUOTA, used: readCount(), remaining: Math.max(0, QUOTA - readCount()), month: monthKey() });
  }

  // 安装包下载：配额门 + X-Accel-Redirect
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (COUNTED.has(ext)) {
    // URL 前缀归一：/downloads/<ver>/<file> 与 /<file> 皆可（ROOT 指向
    // 下载根目录；manifest 用 /downloads/ 前缀——nginx 扩展名路由的同域约定）
    const clean = path.replace(/^\/+/, '').replace(/^downloads\//, '');
    if (clean.includes('..') || clean.includes('\0')) {
      return json(res, 400, { ok: false, error: 'bad path' });
    }
    const file = join(ROOT, clean);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    const used = readCount();
    if (used >= QUOTA) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2592000' });
      return res.end(JSON.stringify({ ok: false, error: '本月下载配额已用完，下月恢复' }));
    }
    writeCount(used + 1);
    // Nginx internal location 发字节（限速/并发在 Nginx 侧）
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Accel-Redirect': `/_internal/${clean}` });
    return res.end();
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[download-gate] listening 127.0.0.1:${PORT} root=${ROOT} quota=${QUOTA}/月`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
