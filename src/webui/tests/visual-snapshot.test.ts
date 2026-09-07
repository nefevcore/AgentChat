// ============================================================
// webui/tests/visual-snapshot.test.ts —— M27 D23-B 视觉快照基线/回归
//
// 「基线先行」：S1 动第一行代码【之前】对现状拍基线——先锁现状、再重构，
// 顺序是本保险成立的前提。此后各阶段验收：快照 diff 全绿才过
// （白名单 = 计划内有意行为改进；白名单外任何像素差异即回归）
// 白名单登记（计划内有为变更，随基线重建并记录）：
//   · S3（2026-11）：插件目录/配置页出现 `runview` 行（ac-client-runview
//     client-only 行入册——扩展目录随行集生长的既定语义；M27.1 该行
//     改名 ui-runview）；07/08 两景。
//   · S3-1a（2026-11）：插件目录/配置页事件树出现
//     `webui/boot-graph-changed` 事件行（ac-webui boot graph 变更通知 +
//     ws-bridge 转发监听入链——热通道既定语义）；07/08 两景，23px 级。
//   · M27.1（2026-11）：插件目录/配置页出现 `ui-<域>` 行（六域前端行
//     ac-client-ui-* 逐域入册：todo/jobs/workspace/singles/groups/agents，
//     收尾 runview 改名 ui-runview——D19 改裁：前端插件一律
//     ac-client-ui-* 包，扩展目录随行集生长的既定语义）；07/08 两景，
//     每域一次基线重建。
//
// 环境：与 portb-e2e 同款「bootTree + 真 WS」——in-process 服务器托管
// src/webui/dist（测试前自动重建，保证 dist 与 src 同步），Playwright
// 真浏览器（channel msedge，可用 PLAYWRIGHT_CHANNEL 覆盖）驱动 UI。
// 基线集（深浅双主题 ×）：桌面名册 / 聊天流（工具卡+思维链+final）/
// 会话列表 / 运行清单 / 运行矩阵 / 设置弹窗（含插件库三页签）/ 移动端
// 抽屉与收起。
//
// 运行：AGENTCHAT_VISUAL=1 pnpm vitest run src/webui/tests/visual-snapshot.test.ts
// 重建基线：AGENTCHAT_VISUAL=1 AGENTCHAT_VISUAL_UPDATE=1 同上
// 跳过重建 dist（加速迭代）：AGENTCHAT_VISUAL_SKIP_BUILD=1
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import WS from 'ws';

const RUN = !!process.env.AGENTCHAT_VISUAL;
const UPDATE = !!process.env.AGENTCHAT_VISUAL_UPDATE;
const SKIP_BUILD = !!process.env.AGENTCHAT_VISUAL_SKIP_BUILD;
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = process.env.AGENTCHAT_REPO_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
const DIST_DIR = join(REPO_ROOT, 'src', 'webui', 'dist');
const BASELINE_DIR = join(HERE, '__screenshots__');

/** 固定时钟锚点（消息相对时间等 Date 派生物的确定性来源） */
const FROZEN_NOW = new Date('2026-11-20T12:00:00+08:00').getTime();

// ---- ws 垫（与 portb-e2e 同款：种子走 node 侧客户端栈） ----
class WsSocketShim {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private sock: WS;
  constructor(url: string | URL) {
    this.sock = new WS(url.toString());
    this.sock.on('open', () => this.onopen?.({}));
    this.sock.on('message', (data) => this.onmessage?.({ data: data.toString() }));
    this.sock.on('close', () => this.onclose?.({}));
    this.sock.on('error', () => this.onerror?.({}));
  }
  get readyState(): number { return this.sock.readyState; }
  send(text: string): void { this.sock.send(text); }
  close(): void { this.sock.close(); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WsSocketShim;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: '127.0.0.1', origin: 'http://127.0.0.1', search: '' };
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

type Tree = { ctx: { webServer: { ready(): Promise<number> }; router?: unknown; plugin(p: unknown): unknown }; fibers: Map<string, { uid: number | null; dispose(): Promise<void> }> };
let tree: Tree;
let dataRoot: string;
let port = 0;
let browser: import('playwright').Browser | undefined;

// ---- 快照比较 ----
function compare(name: string, buf: Buffer): void {
  const file = join(BASELINE_DIR, `${name}.png`);
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return;
  }
  const base = PNG.sync.read(fs.readFileSync(file));
  const shot = PNG.sync.read(buf);
  if (base.width !== shot.width || base.height !== shot.height) {
    throw new Error(`[visual] ${name}：尺寸漂移 ${base.width}x${base.height} → ${shot.width}x${shot.height}（白名单外差异即回归）`);
  }
  const diff = new PNG({ width: base.width, height: base.height });
  // threshold 0.02：吸收 GPU/字体光栅化的亚像素抖动（偶发 1-2px 抗锯齿
  // 舍入差，重跑即消）；结构性/语义变化（色移 > ~5/255、布局位移）仍全量计数
  const count = pixelmatch(base.data, shot.data, diff.data, base.width, base.height, { threshold: 0.02 });
  if (count > 0) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    // 失败取证：diff（红掩膜）+ current（当前实拍）——差异区域定位用
    fs.writeFileSync(join(BASELINE_DIR, `${name}.diff.png`), PNG.sync.write(diff));
    fs.writeFileSync(join(BASELINE_DIR, `${name}.current.png`), PNG.sync.write(shot));
    throw new Error(
      `[visual] ${name}：${count} 像素差异（M27 D23-B：白名单外任何像素差异即回归、阻断验收；diff 见 __screens__/${name}.diff.png；有意变更请 AGENTCHAT_VISUAL_UPDATE=1 重建并记录白名单）`,
    );
  }
}

async function shot(page: import('playwright').Page, name: string): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.querySelectorAll('.loading, .spinner').forEach((n) => n.remove?.());
  });
  await page.waitForTimeout(120);
  compare(name, await page.screenshot({ fullPage: false }));
}

/**
 * 快照时间 = 服务器墙钟（轮询 loading + Vue 重渲染会还原 live 值，
 * pin 文本存在竞态）→ 隐藏元素（保留布局盒）——回归检测不锁墙钟字形。
 */
async function pinSnapTime(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.snap-time').forEach((el) => {
      (el as HTMLElement).style.visibility = 'hidden';
    });
  });
}

/** 拍一组场景（当前主题由 localStorage 预置） */
async function captureSet(context: import('playwright').BrowserContext, theme: 'light' | 'dark'): Promise<void> {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`[visual:pageerror:${theme}]`, err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[visual:console:${theme}]`, msg.text().slice(0, 300));
  });
  await page.clock.install({ now: FROZEN_NOW });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('[title="Agent 列表"]', { timeout: 20_000 });
  await page.waitForSelector('text=小助手', { timeout: 20_000 });
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; caret-color: transparent !important; }' });

  // ① 桌面三栏全貌：名册
  await shot(page, `${theme}-01-roster`);

  // ② 聊天流：选中 Agent → 历史载入（工具卡 + 思维链 + final）
  await page.locator('text=小助手').first().click();
  await page.waitForSelector('text=工具结果已处理', { timeout: 20_000 });
  await shot(page, `${theme}-02-chat`);

  // ③ 会话列表面板
  await page.click('[title="会话列表"]');
  await page.waitForTimeout(300);
  await shot(page, `${theme}-03-sessions`);

  // ④ 运行清单面板
  await page.click('[title="Agent 运行跟踪"]');
  await page.waitForSelector('text=运行总览', { timeout: 10_000 });
  await shot(page, `${theme}-04-runs-panel`);

  // ⑤ 运行矩阵（主区全幅）；快照时间固定文案（几何不变）
  await page.click('.overview-leaf');
  await page.waitForTimeout(400);
  await pinSnapTime(page);
  await shot(page, `${theme}-05-matrix`);

  // ⑥ 设置弹窗（默认页）+ 插件库三页签（背景矩阵头部墙钟同样固定）
  await page.click('[title="全局设置"]');
  await page.waitForSelector('.sp-panel', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await pinSnapTime(page);
  await shot(page, `${theme}-06-settings`);
  await page.click('.sp-tree-leaf:has-text("插件库")');
  await page.waitForSelector('.pl-tabs', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await pinSnapTime(page);
  await shot(page, `${theme}-07-settings-plugins-catalog`);
  await page.click('.pl-tab:has-text("插件配置")');
  await page.waitForTimeout(400);
  await pinSnapTime(page);
  await shot(page, `${theme}-08-settings-plugins-config`);
  await page.click('.pl-tab:has-text("插件市场")');
  // 自动搜索经服务器侧固定失败 → 两源静默容错 → 确定性空态
  await page.waitForSelector('.pl-market .pl-empty', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await pinSnapTime(page);
  await shot(page, `${theme}-09-settings-plugins-market`);
  await page.click('.sp-close');
  await page.waitForTimeout(300);

  await page.close();
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_DIR) || !SKIP_BUILD) {
    execSync('pnpm --filter ac-webui-app build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-visual-'));
  const { bootTree } = await import('../../ac-app/src/index.ts');
  tree = (await bootTree({
    session: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
    'web-server': { port: 0, staticDir: DIST_DIR },
  })) as unknown as Tree;
  // 插件市场 tab 打开即自动搜索（npm/github 真网络）→ 服务器侧 fetch
  // 包装为固定失败：市场页签锁定为确定性错误态（视觉基线不锁第三方内容）
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('registry.npmjs.org') || url.includes('api.github.com')) {
      return Promise.reject(new Error('visual-baseline: 市场源离线（固定错误态）'));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  // scripted provider：首轮工具调用 + 思维链，后续轮 final（内容确定性；
  // 计数器分轮——否则每轮都要求工具 → 无限工具循环，见 portb-e2e 同款）
  let scriptedTurn = 0;
  await tree.ctx.plugin({
    name: 'mock-visual-llm',
    inject: ['llm'],
    apply(ctx: { llm: { register(name: string, factory: () => unknown, meta: Record<string, unknown>): unknown } }) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* () {
            if (scriptedTurn++ === 0) {
              yield { delta: '', reasoning: '先想想这个问题' };
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"preview"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '工具结果已处理，这是用于视觉基线的最终回复。' };
              yield { delta: '', finish: 'stop', usage: { prompt: 12, completion: 34 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  } as never);
  port = await tree.ctx.webServer.ready();
  (globalThis as unknown as { location: { host: string } }).location.host = `127.0.0.1:${port}`;

  // 种子：建档 + 一轮对话（历史落盘；浏览器侧选中即见）
  const { setWireSocketFactory, wireRpc } = await import('../src/api/wire.ts');
  setWireSocketFactory(WsSocketShim as unknown as typeof WebSocket);
  const { createAgent } = await import('../src/api/roster.ts');
  const created = await createAgent({ id: 'helper', name: '小助手', provider: 'scripted', llm: { model: 'mock-1' }, tools: { include: ['hello'] } });
  if (!created.success) throw new Error(`visual seed: 建档失败 ${JSON.stringify(created)}`);
  await (tree.ctx as unknown as { router: { send(agentId: string, msg: string, opts: Record<string, unknown>): Promise<unknown> } }).router.send(
    'helper', '请用工具打个招呼', { sender: 'user', source: 'user', conversationId: 'helper~user' },
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const hist = await wireRpc.call<{ records?: Array<{ role: string; content?: string }> }>('session/history', { conversationId: 'helper~user' });
    if ((hist.records ?? []).some((r) => r.role === 'agent' && (r.content ?? '').includes('工具结果已处理'))) break;
    if (Date.now() > deadline) throw new Error('visual seed: 对话未在 30s 内完成');
    await new Promise((r) => setTimeout(r, 200));
  }

  const pw = await import('playwright');
  try {
    browser = await pw.chromium.launch({ channel: CHANNEL });
  } catch (e) {
    console.warn(`[visual] channel "${CHANNEL}" 启动失败（${(e as Error).message.split('\n')[0]}）——尝试默认 chromium`);
    browser = await pw.chromium.launch();
  }
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (tree) for (const fiber of [...tree.fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!RUN)('D23-B 视觉快照（基线先行）', () => {
  it('深浅双主题 × 桌面/设置/移动端基线集 diff 全绿', { timeout: 300_000 }, async () => {
    expect(browser, '浏览器不可用（安装 Edge 或设 PLAYWRIGHT_CHANNEL）').toBeDefined();
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser!.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await context.addInitScript((t) => localStorage.setItem('agentchat.theme', t), theme);
      await captureSet(context, theme);

      // 移动端（≤768px 左抽屉）
      const mctx = await browser!.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await mctx.addInitScript((t) => localStorage.setItem('agentchat.theme', t), theme);
      const mpage = await mctx.newPage();
      await mpage.clock.install({ now: FROZEN_NOW });
      await mpage.goto(`http://127.0.0.1:${port}/`);
      await mpage.waitForSelector('[title="Agent 列表"]', { timeout: 20_000 });
      await mpage.addStyleTag({ content: '* { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
      await mpage.waitForTimeout(300);
      await shot(mpage, `${theme}-10-mobile-collapsed`);
      await mpage.click('[title="Agent 列表"]');
      await mpage.waitForSelector('text=小助手', { timeout: 10_000 });
      await shot(mpage, `${theme}-11-mobile-drawer`);
      await mctx.close();
      await context.close();
    }
  });
});
