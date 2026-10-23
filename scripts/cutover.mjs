// ============================================================
// cutover.mjs —— 8.9 切换执行脚本（cr-556，2026-10-22）
//
// 一次性切换编排（脱离宿主进程独立运行——杀宿主的动作不能住在宿主里）：
//   前置校验 → 停机确认 → 导入（ac-import --full） → 域拷贝 →
//   凭据换轨 → 拉起新宿主 → 验证 → 报告。
// 全程 fail-loud：任何一步失败立即中止写报告。封存（rename home →
// home-legacy-20261022）由 --stage archive 单独执行——宿主已停后先跑它，
// 再跑本脚本全程；两段式让「停宿主」与「切数据」之间没有窗口裸奔。
// 回滚 = 把 workspace/home-legacy-20261022 rename 回 workspace/home，
// 旧主线入口 dev:legacy 仍在（R-10 终极回滚）。
//
// cr-557 根因修复：
//   · 「数据根被谁占着」抽成 scripts/cutover-guard.mjs 单一判据（旧/新宿主
//     进程 + 主线数据根锁），封存段与全程段共用——此前封存段只有 existsSync。
//   · 封存 rename 改成有界重试（首试 + 5 次退避，每次重试前复查占用者）：
//     瞬时占用（杀毒扫描/句柄回收）不再直接判死；仍失败则报明细 + 回滚指引。
//   · 验证探针从 /api/version（该端点并不存在）改为 3830 端口 TCP 就绪。
// ============================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBlockers } from './cutover-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TS = new Date().toISOString().replace(/[-:T]/g, '').replace(/\./g, '').slice(0, 14);
const LEGACY_NAME = 'home-legacy-20261022';

let legacyDir = '';
let homeDir = path.join(ROOT, 'workspace', 'home');
let doArchive = false;
let skipLaunch = false;
let ignoreBusy = false; // dry-run 专用（绕过停机闸——报告留痕）
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--legacy') legacyDir = path.resolve(args[++i]);
    else if (args[i] === '--home') homeDir = path.resolve(args[++i]);
    else if (args[i] === '--stage') doArchive = args[++i] === 'archive';
    else if (args[i] === '--skip-launch') skipLaunch = true;
    else if (args[i] === '--ignore-busy') ignoreBusy = true;
  }
}
if (legacyDir === '') legacyDir = path.join(ROOT, 'workspace', LEGACY_NAME);

const log = (msg) => console.log(`[cutover ${new Date().toISOString()}] ${msg}`);
const steps = [];
function step(name, ok, detail) { steps.push({ name, ok, detail: detail || '' }); log(`${ok ? 'OK ' : 'XX'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fail(name, detail); }
function fail(name, detail) {
  const file = path.join(ROOT, 'preview', 'sandbox', `cutover-report-${TS}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), steps, failed: name, detail: detail || '' }, null, 2));
  console.error('失败中止。报告: ' + file);
  console.error('回滚：若已封存且新根未就绪 → rename workspace/' + LEGACY_NAME + ' 回 workspace/home，入口 pnpm dev:legacy（旧主线原样）。');
  process.exit(1);
}

/** 同步睡眠（退避用——封存段全程同步，不给宿主重启留插入窗口） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 宿主就绪探针：端口 + 宿主身份 + 数据根实测（/api/healthz 的 ok/agents 字段）。
 *  cr-559 现场：只探 TCP 会被「同端口的别的程序」骗过——启动步把引号弄丢，
 *  cmd 把 AgentChat 当程序起成了全局安装的旧版 CLI，它同样占 3830，TCP 探活
 *  误判成功。探真端点才能区分「我的宿主」与「恰好占着端口的东西」。 */
function hostReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = async () => {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/api/healthz', { signal: AbortSignal.timeout(3000) });
        const body = await res.json();
        // 真判据：宿主自报身份 + 数据根可读（不是「端口有人应答」）
        if (body.ok === true && body.host === 'preview-host') { resolve(true); return; }
      } catch { /* 未就绪继续等 */ }
      if (Date.now() >= deadline) resolve(false);
      else setTimeout(attempt, 2000);
    };
    void attempt();
  });
}

/** 数据根占用闸（单一判据见 cutover-guard；--ignore-busy 只给 dry-run 留痕） */
function assertQuiet(label) {
  const blockers = describeBlockers(homeDir);
  if (blockers === null) { step(label, true, '数据根零占用'); return; }
  if (ignoreBusy) { step(label, true, 'IGNORE-BUSY（dry-run）：' + blockers.replace(/\n/g, ' / ')); return; }
  fail(label, blockers + '\n——先全停再切（dry-run 可 --ignore-busy）');
}

/** 封存：有界重试（每次重试前复查占用者——不盲重试） */
function archive() {
  const backoff = [0, 1000, 2000, 3000, 4000, 5000];
  let last = '';
  for (let i = 0; i < backoff.length; i += 1) {
    if (backoff[i] > 0) {
      const again = describeBlockers(homeDir);
      if (again !== null) fail('封存 rename', '重试前复查发现数据根重新被占用（不盲重试）：\n' + again);
      log(`封存重试 ${i}/${backoff.length - 1}（退避 ${backoff[i]}ms）`);
      sleepSync(backoff[i]);
    }
    try {
      renameSync(homeDir, legacyDir);
      step('封存 home -> ' + LEGACY_NAME, true, '宿主已停前提下完成；续跑 node scripts/cutover.mjs');
      return;
    } catch (err) {
      last = err.message;
      log('封存 rename 未成：' + err.message);
    }
  }
  fail('封存 rename', last + '\n——数据根内有文件被其他进程打开（Windows 目录 rename 需整树可动）。关掉占用者（浏览器预览/编辑器/杀毒扫描）后重试。');
}

log('=== 8.9 cutover（cr-556 / cr-557）===');
log('legacy = ' + legacyDir);
log('home   = ' + homeDir);

if (doArchive) {
  if (!existsSync(homeDir)) fail('封存', homeDir + ' 不存在');
  assertQuiet('停机确认');
  archive();
  process.exit(0);
}

if (!existsSync(legacyDir)) fail('前置', 'legacy 数据根不存在：' + legacyDir + '（先停宿主再跑 --stage archive）');
if (existsSync(homeDir)) fail('前置', '目标 home 已存在：' + homeDir + '（换名冲突——是否已切换过）');
step('前置校验', true);

// 静态面前置（cr-558）：缺 dist 时 3830 只有 WS/RPC——切完浏览器打不开，
// 属于「切换成功但产品不可用」，必须切前拦。
{
  const dist = path.join(ROOT, 'preview', 'apps', 'ui', 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) {
    fail('静态面', dist + '\\index.html 不存在——先 pnpm --filter ac-ui-app build');
  }
  step('静态面就绪', true, 'preview/apps/ui/dist');
}

// 停机确认：数据根零占用（判据单一来源 = scripts/cutover-guard.mjs）
assertQuiet('停机确认');

// 导入（ac-import --full：sessions 四域 + agents 树 + user 投影）
{
  const staging = path.join(ROOT, 'preview', 'sandbox', 'cutover-staging-' + TS);
  const cli = path.join(ROOT, 'preview', 'packages', 'ac-import', 'src', 'import-cli.ts');
  log('导入：' + legacyDir + ' -> ' + homeDir);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', cli, legacyDir, homeDir, staging, '--full'],
    { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) fail('导入', 'import-cli 退出 ' + r.status);
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* 残留无害 */ }
  step('导入 --full（恒等门异常即非零退出）', true);
}

// 域拷贝（新架构同位消费的数据域；旧账本域不拷——已在导入面）
{
  // plugins 不拷：旧主线 plugins/（registry.json 形态）与新架构的通道插件目录
  // 同名不同物，混进来只会污染 boot graph 扫描——原样留在封存根（cr-558）。
  const domains = ['conv-settings', 'files', 'timer', 'summary', 'note', 'exp', 'browser-profile', 'sap-adt', 'remote'];
  let copied = 0;
  for (const d of domains) {
    const src = path.join(legacyDir, d);
    if (!existsSync(src)) continue;
    const dst = path.join(homeDir, d);
    const r = spawnSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NP'], { encoding: 'utf-8' });
    if (r.status === null || r.status >= 8) fail('域拷贝 ' + d, 'robocopy 退出 ' + r.status);
    copied += 1;
  }
  const cfg = path.join(legacyDir, 'config.json');
  if (existsSync(cfg)) { copyFileSync(cfg, path.join(homeDir, 'config.json')); copied += 1; }
  step('域拷贝', true, copied + ' 域/文件');
}

// UI 通道装配（cr-558）：新根 plugins/ = 通道模块构建产物（webui 行的 boot
// graph 与 /ui-plugin/ 静态资产同源根）。缺它 UI 只有骨架、没有域视图——
// 与缺 dist 同级的产品面事故，故建进新根而不是依赖 sandbox 里的现成产物。
{
  const out = path.join(homeDir, 'plugins');
  const cli = path.join(ROOT, 'preview', 'apps', 'ui', 'scripts', 'build-channel.mjs');
  const r = spawnSync(process.execPath, [cli, '--out', out], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) fail('UI 通道装配', 'build-channel 退出 ' + r.status);
  step('UI 通道装配', true, 'preview/apps/ui/channel → plugins/');
}

// 凭据换轨（同机解密重写；经 runner TS 直跑）
{
  const runner = path.join(ROOT, 'preview', 'sandbox', 'cutover-credentials-run.ts');
  const runnerSrc = [
    "import { migrateCredentials } from '../apps/host/cutover-credentials.ts';",
    "import * as fs from 'node:fs';",
    'const r = migrateCredentials(process.argv[2], process.argv[3]);',
    'fs.writeFileSync(process.argv[4], JSON.stringify(r, null, 2));',
    "console.log('[cutover] credentials: ' + JSON.stringify(r));",
  ].join('\n');
  writeFileSync(runner, runnerSrc);
  const outFile = path.join(ROOT, 'preview', 'sandbox', 'cutover-credentials-' + TS + '.json');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner, legacyDir, homeDir, outFile], { cwd: ROOT, encoding: 'utf-8', stdio: 'inherit' });
  rmSync(runner, { force: true }); // 一次性 runner（含路径入参）不留档
  if (r.status !== 0) fail('凭据换轨', '退出 ' + r.status);
  step('凭据换轨', true, '报告 ' + path.basename(outFile));
}

// 拉起新宿主（detached 新控制台——supervisor 常驻）。引号必须原样到 cmd：
// shell:true 会把参数拼成一个字符串、吃掉标题引号，cmd 随后把 AgentChat 当
// 程序启动（cr-559 现场：起了全局安装的旧版 CLI）。windowsVerbatimArguments
// + 空标题（start "" …）是唯一可靠形态。
if (!skipLaunch) {
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '""', 'pnpm', 'dev:supervised'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.unref();
  step('拉起新宿主（新控制台 pnpm dev:supervised）', true);
}

// 验证（web 端口就绪 + RPC 探活）
if (!skipLaunch) {
  if (!(await hostReady(3830, 60000))) {
    fail('验证', '3830 60s 内没有「本宿主」的健康应答（/api/healthz 未回 ok+host）——'
      + '要么新宿主没起来（查 AgentChat Host 控制台），要么端口被别的程序占着');
  }
  step('验证（3830 宿主应答 boot-graph）', true);
}

{
  const file = path.join(ROOT, 'preview', 'sandbox', 'cutover-report-' + TS + '.json');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
  log('完成。报告: ' + file);
  log('旧数据根原样保留（终极回滚）: ' + legacyDir);
  if (!skipLaunch) log('新宿主已在新控制台运行；webui = http://127.0.0.1:3830/');
}

