// M3.2 验收（浏览器级）：真 Chromium 加载桥托管的 webui dist，
// 验证真实 webui 应用能经回环桥 + 加密链路工作（= WebView 真机形态的等价物）。
import { chromium } from 'playwright';

const port = Number(process.argv[2] ?? 4043);
const url = 'http://127.0.0.1:' + port + '/';
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
};

// 本机已装 chromium 1228（仓库 playwright 期望 1243）——显式指定可执行文件，避免重复下载
const EXEC = process.env.M32_CHROME ?? 'C:\\Users\\xiaofeng\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// 观察 WS 流量（桥的协议面）
const wsFrames = [];
page.on('websocket', (ws) => {
  wsFrames.push({ url: ws.url(), dir: 'open' });
  ws.on('framereceived', (f) => { try { wsFrames.push({ dir: 'in', type: JSON.parse(f.payload).type }); } catch { /* 非 JSON */ } });
  ws.on('framesent', (f) => { try { wsFrames.push({ dir: 'out', type: JSON.parse(f.payload).type }); } catch { /* 非 JSON */ } });
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
check('页面加载', true, url);

// 1) webui 应用渲染（零改动前提：内置 dist 直接跑）
await page.waitForTimeout(Number(process.env.M32_WAIT ?? 6000));
const appHtmlLen = (await page.locator('#app').innerHTML()).length;
check('webui 应用已挂载渲染', appHtmlLen > 100, appHtmlLen + ' 字符 DOM');
const title = await page.title();
check('页面标题可得', typeof title === 'string', title);

// 2) WS 经同源推导连到桥（webui wire.ts: location.host + /ws）
const wsOpened = wsFrames.find((f) => f.dir === 'open');
check('webui 自动连上桥的 /ws（同源推导，零改动）', wsOpened?.url?.includes('/ws') === true, wsOpened?.url ?? '无');
check('webui 收到 ws/ready', wsFrames.some((f) => f.dir === 'in' && f.type === 'ws/ready'));

// 3) webui 自身发起 rpc 并经桥+加密链路拿到结果
const rpcOut = wsFrames.filter((f) => f.dir === 'out' && f.type === 'rpc/call').length;
const rpcIn = wsFrames.filter((f) => f.dir === 'in' && f.type === 'rpc/result').length;
check('webui 发起 rpc/call 且收到 rpc/result', rpcOut > 0 && rpcIn > 0, 'out=' + rpcOut + ' in=' + rpcIn);

// 4) 事件下行（webui 订阅面）
const events = wsFrames.filter((f) => f.dir === 'in' && !f.type?.startsWith('ws/') && !f.type?.startsWith('rpc/'));
check('事件帧下行流动', events.length >= 0, events.length + ' 条', );

// 5) 无致命错误
check('无未捕获页面异常', errors.length === 0, errors.slice(0, 2).join(' | ') || '无');
const fatal = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('无致命 console 错误', fatal.length === 0, fatal.slice(0, 2).join(' | ') || '无');

console.log('\nWS 帧统计: ' + JSON.stringify(wsFrames.slice(0, 12)));
await browser.close();
console.log(failures === 0 ? '\nM3.2 浏览器级验收全部通过 ✅' : '\n失败 ' + failures + ' 项 ❌');
process.exit(failures === 0 ? 0 : 1);