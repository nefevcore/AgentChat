#!/usr/bin/env node
// ============================================================
// scripts/e2e-bundle.mjs —— 发布产物全链 e2e（cr-703 followups 1.2）
//
// 与 build-bundle 后的静态冒烟（HTTP 200 / 通道播种）互补，本脚本锁**双入口
// spawn 链**：从 dist/agentchat.mjs 起 true 宿主 → WS RPC 建/选 Agent → user
// 发一条消息 → 邮局投递信封 → 宿主 spawn dist/shell.mjs 真 壳 → 壳内 mock
// provider 回执 → 账本终稿落盘 → 全链进程可退。失败非零退出并**保留数据根
// 现场**（不删——排障用）。
//
// 用法：node scripts/e2e-bundle.mjs（先 pnpm build:bundle 产出 dist/）
//       --keep  成功后也保留数据根（默认成功即清）
// ============================================================
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const hostEntry = path.join(dist, 'agentchat.mjs');

const KEEP = process.argv.includes('--keep');

if (!fs.existsSync(hostEntry)) {
  console.error('[e2e-bundle] dist/agentchat.mjs 缺席——先 pnpm build:bundle');
  process.exit(1);
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bundle-e2e-'));
console.log(`[e2e-bundle] 数据根：${dataRoot}`);

let host = null;
let ws = null;
let failed = false;

function fail(msg) {
  console.error(`[e2e-bundle] ✗ ${msg}`);
  failed = true;
  process.exitCode = 1;
}

// 前置清理（仅失败退出路径——成功路径最后统一收）
process.on('exit', (code) => {
  if (code === 0 && !KEEP) {
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }
  } else {
    console.error(`[e2e-bundle] 数据根现场保留：${dataRoot}`);
  }
});

/** 等 HTTP 端口就绪（根路径 200——web-server 静态面） */
async function waitHttp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error(`web 端口 ${timeoutMs}ms 未就绪`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** WS 连接 + 等 ws/ready 首帧；返回 { ws, call } RPC 面 */
function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pending = new Map();
    let seq = 0;
    sock.once('open', () => {
      sock.once('message', (data) => {
        const m = JSON.parse(String(data));
        if (m.type === 'ws/ready') {
          const call = (method, params = {}) => new Promise((res2, rej2) => {
            const requestId = 'e2e-' + (++seq);
            pending.set(requestId, { res2, rej2 });
            sock.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
          });
          sock.on('message', (data) => {
            const m2 = JSON.parse(String(data));
            if (m2.type === 'rpc/result' && pending.has(m2.data?.requestId)) {
              const p = pending.get(m2.data.requestId);
              pending.delete(m2.data.requestId);
              if (m2.data.ok) p.res2(m2.data.result);
              else p.rej2(new Error(m2.data.error ?? 'rpc 失败'));
            }
          });
          resolve({ ws: sock, call });
        } else {
          reject(new Error('首帧非 ws/ready：' + JSON.stringify(m)));
        }
      });
    });
    sock.once('error', reject);
  });
}

async function main() {
  // ① 起宿主 bundle（mock provider 档）
  console.log('[e2e-bundle] ① spawn 宿主 dist/agentchat.mjs --mock-provider …');
  host = spawn(process.execPath, [hostEntry, '--data-root', dataRoot, '--mock-provider', '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTCHAT_HOME: dist, AGENTCHAT_VERSION_JSON: path.join(dist, 'version.json') },
  });
  const hostLines = [];
  host.stdout.on('data', (c) => { const s = String(c); hostLines.push(s); process.stdout.write('[host] ' + s); });
  host.stderr.on('data', (c) => process.stderr.write('[host:err] ' + String(c)));
  const bootLine = await waitFor(hostLines, (l) => /boot 完成：\d+ 行装配/.test(l), 60_000, '宿主 boot 完成');
  const port = Number(/web 端口 (\d+)/.exec(bootLine)?.[1] ?? 0);
  if (port === 0) throw new Error('未能从 boot 输出解析 web 端口：' + bootLine);
  await waitHttp(port);
  console.log(`[e2e-bundle] 宿主就绪（端口 ${port}）`);

  // ② WS 连接 + RPC 面
  const conn = await connect(port);
  ws = conn.ws;
  call = conn.call;

  // ③ 建 Agent（走 agents/create RPC）
  console.log('[e2e-bundle] ③ 建 Agent …');
  const created = await call('agents/create', { name: 'bundle-e2e' });
  const agentId = created?.config?.id ?? created?.agent?.id ?? created?.id;
  if (!agentId) throw new Error('agents/create 未返回 id：' + JSON.stringify(created));
  console.log(`[e2e-bundle] Agent: ${agentId}`);

  // ④ user 发一条消息 → 信封投递 → 宿主 spawn dist/shell.mjs
  console.log('[e2e-bundle] ④ user 发消息（应触发壳 spawn 链）…');
  const sent = await call('conversation/deliver', { agentId, message: 'bundle e2e 第一问', requestId: 'e2e-r1' });
  const convId = sent?.uuid;
  if (!convId) throw new Error('conversation/deliver 未返回 uuid：' + JSON.stringify(sent));
  console.log(`[e2e-bundle] 会话: ${convId}`);

  // ⑤ 等账本终稿：agents/<id>/sessions/<uuid>/ 下出现 finish=stop 的收束行
  console.log('[e2e-bundle] ⑤ 等账本终稿（壳 mock 回执落盘）…');
  const ledgerDir = path.join(dataRoot, 'agents', agentId, 'sessions', convId);
  const deadline = Date.now() + 90_000;
  let settled = false;
  while (Date.now() < deadline) {
    if (hasReply(ledgerDir, 'e2e-r1')) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!settled) {
    fail(`账本终稿超时（90s）：${ledgerDir}`);
    console.error('[e2e-bundle] 壳诊断：宿主输出尾行——');
    for (const l of hostLines.slice(-20)) console.error('  ' + l.trim());
    return;
  }
  console.log('[e2e-bundle] 账本终稿已落盘 ✓');

  // ⑥ 全链可退：WS 关 → 宿主 SIGTERM 优雅退 → 进程收
  console.log('[e2e-bundle] ⑥ 收面：WS 关 + 宿主优雅退 …');
  ws.close();
  const exited = new Promise((resolve) => host.on('exit', (code, signal) => resolve({ code, signal })));
  host.kill('SIGTERM');
  const r = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('宿主 15s 未退出')), 15_000))]);
  console.log(`[e2e-bundle] 宿主已退（code=${r.code}）`);
  console.log('[e2e-bundle] ✓ 全链通过：dist 宿主 → RPC → 信封 → dist 壳 → 账本终稿 → 可退');
}

/** 行缓冲等待：lines 里出现匹配行即返回该行 */
async function waitFor(lines, match, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = lines.find(match);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`${what} 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 账本目录是否已有 agent 终稿行（回执 message_id 形态 reply-<requestId>）。
 * * 判据取 mock 回执的终稿行（非 journal finish 字段——mock 档收束行
 * 不带该字段；以回执 MessageID 为锚最贴近「链路闭环」语义）。 */
function hasReply(dir, requestId) {
  try {
    const text = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
    return text.includes('"message_id":"reply-' + requestId + '"');
  } catch { /* 尚未落盘 */ }
  return false;
}

let call = null;

main().then(() => {
  /* 结果经 process.exitCode 报告 */
}).catch((err) => {
  fail(err?.stack ?? String(err));
}).finally(() => {
  // 失败兜底：宿主仍活则强杀（现场已在 exit 钩子保留）
  if (host && host.exitCode === null) { try { host.kill('SIGKILL'); } catch { /* 尽力 */ } }
});
