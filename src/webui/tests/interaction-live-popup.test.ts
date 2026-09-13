// ============================================================
// tests/interaction-live-popup.test.ts —— live ask_questions 弹窗复现（真浏览器）
//
// 背景（2026-09-12 反馈）：Agent 调 ask_questions 后【弹窗根本不出现】
// （不是刷新丢失——是提问时就没有作答入口），用户只能重启后端。
// 后端侧已验证健康：interactions.jsonl 有 4 条 pending 落盘（用户实测残留），
// opened 帧广播正常——问题锁定前端渲染链。
//
// 本测试用与用户完全同构的栈：bootTree 后端 + src/webui/dist 托管 +
// Playwright 真浏览器（msedge）——页面打开 → 发消息触发 ask_questions →
// 断言 .interaction-bar 出现（用户反馈该场景不出现）。
// 运行：AGENTCHAT_VISUAL=1 npx vitest run src/webui/tests/interaction-live-popup.test.ts
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WS from 'ws';

const RUN = !!process.env.AGENTCHAT_VISUAL;
const SKIP_BUILD = !!process.env.AGENTCHAT_VISUAL_SKIP_BUILD;
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = process.env.AGENTCHAT_REPO_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
const DIST_DIR = join(REPO_ROOT, 'src', 'webui', 'dist');

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

let port = 0;
let dataRoot: string;
type Tree = { ctx: any; fibers: Map<string, any> };
let tree: Tree;

const seeded: Array<() => void> = [];
process.on('unhandledRejection', () => undefined);

beforeAll(async function setup() {
  if (!RUN) return;
  if (!SKIP_BUILD) {
    execSync('pnpm --filter ac-webui-app build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-live-popup-'));
  (globalThis as any).WebSocket = WsSocketShim;
  (globalThis as any).location = { protocol: 'http:', host: '127.0.0.1', origin: 'http://127.0.0.1', search: '' };
  (globalThis as any).window = globalThis;
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { bootTree } = await import('../../ac-app/src/index.ts');
  tree = await bootTree({
    session: { root: dataRoot },
    singles: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
    'web-server': { port: 0, staticDir: DIST_DIR },
  });
  // scripted LLM：首步 ask_questions（挂起），结果回来后收束
  await tree.ctx.plugin({
    name: 'mock-askq',
    inject: ['llm'],
    apply(ctx: any) {
      ctx.llm.register('askq', () => ({
        stream: async function* (input: Record<string, unknown>) {
          const msgs = (input.messages as Array<{ role?: string; content?: string }>) ?? [];
          const asked = msgs.some((m) => m.role === 'tool');
          const hasAssistant = msgs.some((m) => m.role === 'assistant');
          if (!hasAssistant) {
            yield { delta: '', toolCalls: [{ index: 0, id: 'askq-1', name: 'ask_questions' }] };
            yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ questions: [{ question: '选 A 还是 B？', options: ['A', 'B'] }] }) }] };
            yield { delta: '', finish: 'tool_calls' };
          } else if (!asked) {
            yield { delta: '等待中' };
            yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 2 } };
          } else {
            yield { delta: '已收到回答' };
            yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 2 } };
          }
        },
      }), { models: ['mock-1'] });
    },
  } as never);
  // 托管 dist 的 web 服务器：port 0 → ready 后回填 location.host（种子连接用）
  port = await tree.ctx.webServer.ready();
  (globalThis as any).location.host = `127.0.0.1:${port}`;
  (globalThis as any).location.origin = `http://127.0.0.1:${port}`;
  const { setWireSocketFactory, wireRpc } = await import('../src/api/wire.ts');
  setWireSocketFactory(WsSocketShim as never);
  // 种子：Agent + single 会话
  const { createAgent } = await import('ac-client-ui-agents/client');
  const { createSingle } = await import('ac-client-ui-singles/client');
  await createAgent({ id: 'helper', name: '小助手', provider: 'askq', llm: { model: 'mock-1' }, tools: { include: ['ask_questions'] } }, wireRpc);
  const { session } = await createSingle({ agentId: 'helper' }, wireRpc);
  (globalThis as any).__sid = session.id;
}, 120_000);

afterAll(async () => {
  if (!RUN) return;
  for (const fiber of [...tree.fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  await import('node:fs').then((fs) => fs.rmSync(dataRoot, { recursive: true, force: true }));
}, 60_000);

describe.runIf(RUN)('live ask_questions 弹窗（真浏览器）', () => {
  it('页面打开 → single 会话发消息 → run 挂起 ask_questions → .interaction-bar 应出现', { timeout: 120_000 }, async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ channel: CHANNEL as never });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[console:${msg.type()}]`, msg.text().slice(0, 400));
    });

    const sid = (globalThis as any).__sid as string;
    // localStorage 预置：上次上下文 = 该 single 会话（刷新恢复语义同款）
    await page.addInitScript((sid: string) => {
      localStorage.setItem('agentchat.lastContext', JSON.stringify({ kind: 'single', id: sid }));
    }, sid);

    await page.goto(`http://127.0.0.1:${port}/`);
    // 等应用就绪（活动栏）
    await page.waitForSelector('[title="Agent 列表"], [title="会话列表"]', { timeout: 30_000 });
    // 等 restoreLastSingle 完成（会话标题可见或输入框出现）
    await page.waitForSelector('textarea, .chat-input', { timeout: 30_000 });
    await page.waitForTimeout(1000);

    // 发消息触发 run → ask_questions 挂起
    const input = page.locator('textarea, .chat-input textarea, .chat-input input').first();
    await input.fill('帮我选一下');
    await input.press('Enter');

    // 核心断言：live 弹窗出现（用户反馈此场景不出现）
    await page.waitForSelector('.interaction-bar', { timeout: 20_000 });
    const q = await page.locator('.ib-title').first().textContent();
    expect(q).toContain('选 A 还是 B？');

    // 作答（点选项 → 末题需点提交按钮——DSH 分页语义）→ run 收束 → 最终回复可见
    await page.locator('.ib-option').first().click();
    await page.locator('.ib-btn.primary').click();
    await page.waitForSelector('text=已收到回答', { timeout: 30_000 });

    await browser.close();
  });
});
