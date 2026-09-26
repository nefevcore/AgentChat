// ============================================================
// scripts/m35-download-verify.mjs —— M3.5 下载面端到端验证
//
// 验收行：「下载面装 APK；版本更新提醒走通」。本脚本覆盖前半句——
// 真起一个下载面进程，走 HTTP 把 APK 取下来并**逐字节校验 sha256**，
// 以及配额门/路径穿越/清单不计配额等边界。后半句（版本提醒）由真机验证。
//
// 用法：node scripts/m35-download-verify.mjs [apk路径]
// ============================================================
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const APK = resolve(process.argv[2] ?? 'mobile/app/android/app/build/outputs/apk/debug/app-debug.apk');
const TMP = resolve('.dsh/tmp/m35-dl');
const ROOT = join(TMP, 'downloads');
const STATE = join(TMP, 'state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond || !extra ? '' : '  → ' + extra));
  if (!cond) failures++;
}

if (!existsSync(APK)) { console.error('APK 不存在: ' + APK + '（先构建）'); process.exit(2); }
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(ROOT, 'android'), { recursive: true });
mkdirSync(STATE, { recursive: true });

// 布一个下载面目录：安卓包 + 一个主页（后者不该计配额）
cpSync(APK, join(ROOT, 'android', 'AgentChat-1.0.0.apk'));
writeFileSync(join(ROOT, 'index.html'), '<html><body>AgentChat</body></html>');

// ---- 起 gate（配额设 2，便于验证超限分支）----
const gate = spawn(process.execPath, [
  'scripts/download-gate.mjs',
  '--root', ROOT,
  '--port', '0',
  '--quota', '2',
  '--state', STATE,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
gate.stdout.setEncoding('utf8');
gate.stdout.on('data', (d) => { out += d; });
gate.stderr.setEncoding('utf8');
gate.stderr.on('data', (d) => process.stderr.write('[gate] ' + d));

let base = null;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  const m = out.match(/监听 http:\/\/127\.0\.0\.1:(\d+)/);
  if (m) { base = 'http://127.0.0.1:' + m[1]; break; }
  if (gate.exitCode !== null) { console.error('gate 提前退出'); process.exit(2); }
}
if (!base) { console.error('gate 未就绪'); gate.kill(); process.exit(2); }
console.log('下载面 ' + base);

try {
  // 1) 主页可达且不计配额
  const home = await fetch(base + '/index.html');
  check('主页可达', home.status === 200);
  const q1 = await (await fetch(base + '/api/quota')).json();
  check('主页不计配额', q1.used === 0, JSON.stringify(q1));
  check('配额初值正确', q1.quota === 2 && q1.remaining === 2, JSON.stringify(q1));

  // 2) manifest 可达且不计配额（浏览行为）
  writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify([{ platform: 'android', version: '1.0.0' }], null, 2));
  const mf = await fetch(base + '/downloads/manifest.json'.replace('/downloads', ''));
  check('manifest 可达', mf.status === 200);
  const q2 = await (await fetch(base + '/api/quota')).json();
  check('manifest 不计配额', q2.used === 0, JSON.stringify(q2));

  // 3) **下载 APK 并逐字节校验**（验收前半句的核心）
  const dlUrl = base + '/android/AgentChat-1.0.0.apk';
  const dl = await fetch(dlUrl);
  check('APK 下载 200', dl.status === 200, 'status=' + dl.status);
  check('Content-Type 正确', (dl.headers.get('content-type') ?? '').includes('android.package-archive'), dl.headers.get('content-type'));
  const bytes = Buffer.from(await dl.arrayBuffer());
  const local = readFileSync(APK);
  const dlSha = createHash('sha256').update(bytes).digest('hex');
  const localSha = createHash('sha256').update(local).digest('hex');
  check('下载字节与源文件 sha256 一致', dlSha === localSha, dlSha.slice(0, 16) + ' vs ' + localSha.slice(0, 16));
  check('下载字节数一致', bytes.byteLength === local.byteLength, bytes.byteLength + ' vs ' + local.byteLength);
  writeFileSync(join(TMP, 'downloaded.apk'), bytes);
  const q3 = await (await fetch(base + '/api/quota')).json();
  check('APK 下载计入配额', q3.used === 1, JSON.stringify(q3));

  // 4) 配额用尽 → 403（流量费硬顶）
  const dl2 = await fetch(dlUrl);
  check('第二次下载仍 200（配额 2 未满）', dl2.status === 200);
  const dl3 = await fetch(dlUrl);
  const body3 = await dl3.text();
  check('超限 403', dl3.status === 403, 'status=' + dl3.status);
  check('超限有明确文案', body3.includes('配额'), body3.slice(0, 80));
  const q4 = await (await fetch(base + '/api/quota')).json();
  check('配额剩 0', q4.remaining === 0, JSON.stringify(q4));
  // 超限后非安装包仍可取（浏览不受配额影响）
  check('超限后主页仍可达', (await fetch(base + '/index.html')).status === 200);

  // 5) 路径穿越防护
  const esc = await fetch(base + '/../../package.json');
  check('路径穿越被拒', esc.status === 404, 'status=' + esc.status);
  const esc2 = await fetch(base + '/%2e%2e%2f%2e%2e%2fpackage.json');
  check('编码穿越被拒', esc2.status === 404, 'status=' + esc2.status);

  // 6) 方法闸
  const post = await fetch(base + '/index.html', { method: 'POST' });
  check('非 GET/HEAD 被拒', post.status === 405, 'status=' + post.status);
} finally {
  gate.kill();
}

console.log(failures === 0 ? '\nM3.5 下载面验证全部通过 ✅' : '\n失败 ' + failures + ' 项 ❌');
process.exit(failures === 0 ? 0 : 1);

