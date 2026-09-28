// ============================================================
// ac-web-tools/src/browser.ts —— 浏览器 Service（ctx.browser）v2
//
// 2026-09-26 CDP 直连改造（src/docs/browser-cdp-plan.md）：
//   · 执行层从「Python + playwright 守护进程」换成 Node 原生 CDP
//     （ac-cdp-core 纯库）——协议实现可单测可 typecheck，桌面
//     分发零 Python 依赖（Windows 宿主必装 Edge = Chromium）
//   · 生命周期骨架保留（惰性启动 / boot 超时 / 世代计数 / dispose
//     杀进程——C4 教训全保留）；「杀 Python」换成「树杀 Chrome +
//     关 ws」
//   · FIFO 单命令队列退役：CDP 命令 id 配对天然可并发；仅保留
//     动作级互斥锁（导航/快照期间防并发抢页面）
//   · 感知（M2）+ 诊断（M3）以新 action 出现：elements/read/scroll/
//     wait/logs/response_body/tabs——LLM 可见工具面形态不变
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import {
  CdpClient, CdpPage, killTree, launchBrowser, removeProfile,
  extractElements, extractText, serializeElements,
  type LaunchedBrowser,
} from 'ac-cdp-core';

export interface BrowserRowOptions {
  /** 显式覆盖浏览器可执行文件（测试/调试注入） */
  executablePath?: string;
  /**
   * CDP ws endpoint 直连（测试注入 fake endpoint——替换真实拉起）。
   * 与 executablePath 互斥；给出时不再 spawn 浏览器。
   */
  cdpEndpoint?: string;
  /** 单动作缺省超时毫秒（缺省 35000） */
  timeoutMs?: number;
  /** boot 握手超时毫秒（缺省 60000；C4 拒绝式收束语义保留） */
  bootTimeoutMs?: number;
  /** 空闲回收毫秒（缺省 300000；0 = 不回收） */
  idleTimeoutMs?: number;
  /** headful 调试（缺省 headless） */
  headful?: boolean;
  /** UA / locale / timezone 覆盖（缺省真实 UA 探测） */
  userAgent?: string;
  locale?: string;
  timezone?: string;
}

/** 单动作结果（序列化前的内部形；LLM 面截断纪律见 index.ts） */
export interface BrowserActionOutput {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

interface LaunchConfig {
  executablePath?: string;
  headful?: boolean;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  bootTimeoutMs: number;
}

const DEFAULT_IDLE_MS = 300_000;

export class BrowserService extends Service {
  private timeoutMs: number;
  private idleMs: number;
  private launchCfg: LaunchConfig;
  /** 测试注入的 fake endpoint（cdpEndpoint 配置） */
  private endpointOverride?: string;
  /** 数据根（profile/截图落位）——boot 时从 workspace 解析 */
  private dataRoot?: string;

  private launched: LaunchedBrowser | null = null;
  private client: CdpClient | null = null;
  private page: CdpPage | null = null;
  private bootPromise: Promise<void> | null = null;
  private generation = 0;
  /** 动作级互斥锁（导航/快照原子性——多会话共享单页面） */
  private lock: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastElements: ReturnType<typeof extractElements> = [];

  constructor(ctx: Context, options: BrowserRowOptions = {}) {
    super(ctx, 'browser');
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.endpointOverride = options.cdpEndpoint;
    this.launchCfg = {
      executablePath: options.executablePath,
      headful: options.headful,
      userAgent: options.userAgent,
      locale: options.locale,
      timezone: options.timezone,
      bootTimeoutMs: options.bootTimeoutMs ?? 60_000,
    };
    // 注册即归属：服务卸载（行摘除/进程收尾）→ 树杀 Chrome + 关 ws + 删 profile
    this.ctx.fiber.effect(() => () => this.shutdown(), 'browser.chrome');
  }

  get running(): boolean {
    return this.client !== null && !this.client.closed && this.launched !== null;
  }

  /** 数据根（软依赖 workspace；缺省 cwd/data） */
  private root(): string {
    if (!this.dataRoot) {
      const ws = this.ctx.get('workspace', false) as { root: string } | undefined;
      this.dataRoot = ws?.root ?? path.resolve('./data');
    }
    return this.dataRoot;
  }

  private profileDir(): string {
    return path.join(this.root(), 'browser-profile');
  }

  private screenshotDir(): string {
    return path.join(this.root(), 'screenshots');
  }

  /**
   * 惰性启动（并发共享一次 boot；fail-loud）。流程：清 profile（ephemeral
   * 语义——Chrome 136+ 自定义 user-data-dir 是调试端口开关生效的前提，
   * 恰由 ephemeral 清空兜底）→ spawn → DevToolsActivePort 轮询 →
   * /json/version → ws 连接 → 开页面会话。
   */
  private boot(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.bootPromise) return this.bootPromise;
    const gen = ++this.generation;
    this.bootPromise = this.doBoot().then(
      () => { if (gen === this.generation) this.armIdleTimer(); },
      (err: unknown) => { this.teardown(); throw err; },
    ).finally(() => { this.bootPromise = null; });
    return this.bootPromise;
  }

  private async doBoot(): Promise<void> {
    if (this.endpointOverride) {
      this.client = await CdpClient.connect(this.endpointOverride, {
        connectTimeoutMs: Math.min(this.launchCfg.bootTimeoutMs, 10_000),
        commandTimeoutMs: this.timeoutMs,
      });
      this.launched = { child: null as never, port: 0, version: { Browser: 'fake', webSocketDebuggerUrl: this.endpointOverride }, webSocketDebuggerUrl: this.endpointOverride } as LaunchedBrowser;
      this.wireEvents();
      this.page = await CdpPage.open(this.client, this.emuOptions());
      return;
    }
    // ephemeral：boot 清空 profile（残留锁 = 上代僵尸，直接清）+ 截图目录确保
    fs.rmSync(this.profileDir(), { recursive: true, force: true });
    fs.mkdirSync(this.screenshotDir(), { recursive: true });
    this.launched = await launchBrowser({
      userDataDir: this.profileDir(),
      executablePath: this.launchCfg.executablePath,
      headless: !this.launchCfg.headful,
      bootTimeoutMs: this.launchCfg.bootTimeoutMs,
    });
    this.client = await CdpClient.connect(this.launched.webSocketDebuggerUrl, {
      connectTimeoutMs: Math.min(this.launchCfg.bootTimeoutMs, 10_000),
      commandTimeoutMs: this.timeoutMs,
    });
    this.wireEvents();
    this.page = await CdpPage.open(this.client, this.emuOptions());
  }

  private emuOptions() {
    return {
      // 真实 UA（无覆盖时由 CDP 默认——headless new 模式 UA 自带 HeadlessChrome
      // 标记，显式覆盖去掉它是 stealth 基础项；浏览器自身 UA 经 evalExpr 取）
      userAgent: this.launchCfg.userAgent,
      locale: this.launchCfg.locale ?? 'zh-CN',
      timezone: this.launchCfg.timezone ?? 'Asia/Shanghai',
      viewport: { width: 1280, height: 720 },
    };
  }

  /** ws 事件分发：全部事件先喂诊断缓冲（sessionId 匹配才进 page） */
  private wireEvents(): void {
    this.client!.on('event', (ev: { method: string; params: Record<string, unknown>; sessionId?: string }) => {
      if (this.page && ev.sessionId === this.page.sessionId) this.page.handleEvent(ev.method, ev.params);
    });
    this.client!.on('close', () => {
      // 意外断线：世代推进 + 清状态（下次调用重新 boot——拒绝式收束）
      if (this.client?.closed && this.launched) {
        this.generation++;
        this.teardown();
      }
    });
  }

  private async teardown(): Promise<void> {
    this.clearIdleTimer();
    // 优雅关优先（Browser.close 让浏览器进程自退——启动器进程早已自退时
    // killTree 的 pid 是无效的，树杀兜底也够不到真浏览器进程）
    const client = this.client;
    this.client = null;
    this.page = null;
    const child = this.launched?.child;
    this.launched = null;
    if (client && !client.closed) {
      try { await client.send('Browser.close', {}, undefined, 3_000); } catch { /* 已亡 */ }
      client.close();
    }
    if (child) killTree(child);
    removeProfile(this.profileDir(), this.ctx.logger);
    this.lastElements = [];
  }

  private shutdown(): void {
    this.generation++;
    void this.teardown();
  }

  /** 空闲回收（懒拉起：拉起时才 arm；收敛即清） */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.ctx.logger.info('[browser] 空闲回收（%Cms）', this.idleMs);
      this.shutdown();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 互斥锁内执行动作（导航/快照原子性） */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    this.armIdleTimer();
    return run;
  }

  /**
   * 执行单动作（LLM 工具面入口）。未知动作抛错（schema enum 已拦，
   * 双保险）。诊断动作（logs/response_body）不需 boot 页面（缓冲随
   * 会话存活）——但缓冲在 page 里，未 boot 时如实报未启动。
   */
  async run(action: string, args: Record<string, unknown>): Promise<BrowserActionOutput> {
    // close 短路径：未启动时无需先拉起浏览器再关（幂等回收语义）
    if (action === 'close' && !this.running) return { ok: true, output: { closed: true } };
    try {
      await this.boot();
    } catch (err: unknown) {
      throw new Error(`浏览器启动失败（下次调用将重试）: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!this.page) throw new Error('browser 会话不可用（启动失败）');
    return this.exclusive(() => this.runUnlocked(action, args));
  }

  private async runUnlocked(action: string, args: Record<string, unknown>): Promise<BrowserActionOutput> {
    const p = this.page!;
    const str = (k: string, d = ''): string => (typeof args[k] === 'string' ? args[k] as string : d);
    const num = (k: string, d: number): number => {
      const v = Number(args[k]);
      return Number.isFinite(v) ? v : d;
    };
    switch (action) {
      case 'open': {
        let url = str('url');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const markerBefore = p.marker;
        const nav = await p.navigate(url, this.timeoutMs, num('waitMs', 0));
        const errors = p.errorOverview(markerBefore);
        // 导航后旧元素索引全数失效（新页面新 DOM）——清空防误点击
        this.lastElements = [];
        return { ok: true, output: { url: nav.url, title: nav.title, ...errors, marker: p.marker } };
      }
      case 'read': {
        const maxLen = Math.min(num('maxLen', 8000), 20_000);
        const snap = await p.snapshot();
        const { text, title } = extractText(snap, maxLen);
        return { ok: true, output: { url: (await p.evalExpr('location.href')).value, title, text, length: text.length } };
      }
      case 'elements': {
        const snap = await p.snapshot();
        const refs = extractElements(snap, { width: 1280, height: 720 });
        this.lastElements = refs;
        const lines = serializeElements(refs);
        return { ok: true, output: { count: refs.length, elements: lines.slice(0, 100), marker: p.marker } };
      }
      case 'click': {
        const target = await this.resolveClickTarget(args);
        await p.click(target.x, target.y);
        await new Promise<void>((r) => setTimeout(r, 300));
        const [{ value: href }, { value: title }] = await Promise.all([
          p.evalExpr('location.href'), p.evalExpr('document.title'),
        ]);
        return { ok: true, output: { clicked: target.desc, url: String(href ?? ''), title: String(title ?? '') } };
      }
      case 'hover': {
        const target = await this.resolveClickTarget(args);
        await p.hover(target.x, target.y);
        return { ok: true, output: { hovered: target.desc } };
      }
      case 'type': {
        const target = await this.resolveClickTarget(args);
        await p.click(target.x, target.y);
        await p.insertText(str('text'));
        return { ok: true, output: { typed: str('text').slice(0, 80) } };
      }
      case 'press': {
        await p.press(str('key', 'Enter'));
        return { ok: true, output: { pressed: str('key', 'Enter') } };
      }
      case 'scroll': {
        const direction = str('direction', 'down') === 'up' ? 'up' : 'down';
        const amount = Math.min(num('amount', 600), 5000);
        await p.scroll(direction, amount);
        await new Promise<void>((r) => setTimeout(r, 250));
        const [{ value: y }, { value: h }] = await Promise.all([
          p.evalExpr('window.scrollY'), p.evalExpr('document.body.scrollHeight'),
        ]);
        return { ok: true, output: { direction, amount, scrollY: Number(y ?? 0), pageHeight: Number(h ?? 0) } };
      }
      case 'wait': {
        const ms = Math.min(num('ms', 1000), 30_000);
        const text = str('text');
        if (text) {
          const found = await p.evalExpr(
            'new Promise((resolve) => {' +
              'const t = setTimeout(() => { obs.disconnect(); resolve(false); }, ' + Math.min(ms, this.timeoutMs) + ');' +
              'const finish = (v) => { clearTimeout(t); obs.disconnect(); resolve(v); };' +
              'let obs = new MutationObserver(() => { if (document.body && document.body.innerText.includes(' + JSON.stringify(text) + ')) finish(true); });' +
              'if (document.body && document.body.innerText.includes(' + JSON.stringify(text) + ')) finish(true);' +
              'else obs.observe(document, { subtree: true, childList: true, characterData: true });' +
              '})',
            true,
          );
          return { ok: true, output: { found: Boolean(found.value), text } };
        }
        await new Promise<void>((r) => setTimeout(r, ms));
        return { ok: true, output: { waited: ms } };
      }
      case 'screenshot': {
        const name = str('name') || `shot_${Date.now().toString(36)}.png`;
        const safe = name.replace(/[^\w.-]/g, '_');
        const data = await p.screenshot(str('fullPage') === 'true' || args.fullPage === true);
        const dir = this.screenshotDir();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, safe.endsWith('.png') ? safe : safe + '.png');
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return { ok: true, output: { file, relPath: 'screenshots/' + path.basename(file) } };
      }
      case 'logs': {
        const since = num('since', 0);
        const kind = str('kind', 'all');
        const level = str('level', '');
        const out: Record<string, unknown> = { marker: p.marker };
        if (kind === 'all' || kind === 'console') {
          const entries = p.consoleEntries(since, (level || undefined) as never);
          out.console = entries.map((e) => ({ seq: e.seq, level: e.level, kind: e.kind, text: e.text.slice(0, 400) }));
        }
        if (kind === 'all' || kind === 'network') {
          out.network = p.netEntries(since).map((e) => ({
            seq: e.seq, method: e.method, url: e.url.slice(0, 200), status: e.status,
            state: e.state, ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          }));
        }
        if (kind === 'error') {
          const errs = p.consoleEntries(since, 'error');
          const failed = p.netEntries(since).filter((e) => e.state === 'failed');
          out.console = errs.map((e) => ({ seq: e.seq, level: e.level, text: e.text.slice(0, 400) }));
          out.network = failed.map((e) => ({ seq: e.seq, url: e.url.slice(0, 200), error: e.errorText }));
        }
        return { ok: true, output: out };
      }
      case 'response_body': {
        const body = await p.responseBody(str('requestId'), Math.min(num('maxLen', 4000), 20_000));
        return { ok: true, output: { ...body } };
      }
      case 'tabs': {
        const targets = await this.client!.send<{ targetInfos: Array<{ targetId: string; type: string; title: string; url: string }> }>('Target.getTargets');
        const pages = targets.targetInfos.filter((t) => t.type === 'page');
        return { ok: true, output: { tabs: pages.map((t, i) => ({ index: i, id: t.targetId.slice(0, 8), title: t.title.slice(0, 80), url: t.url.slice(0, 120), active: t.targetId === this.page?.targetId })) } };
      }
      case 'content': {
        // 退役别名（保留一个版本期）：正文抽取同 read
        return this.runUnlocked('read', { maxLen: args.maxLen ?? 5000 });
      }
      case 'html': {
        // 退役别名（保留一个版本期）：正文抽取同 read（原 daemon 的源码面已并入正文 debug）
        return this.runUnlocked('read', { maxLen: args.maxLen ?? 5000 });
      }
      case 'eval': {
        // 结果保留 JSON 类型（数字/布尔/对象直出，不再字符串化——2026-10-09
        // 复盘：双重 stringify 迫使消费方手工 Number() 解包）。function/Promise
        // 误用在 evalExpr 层报可读错误（RemoteObject type/subtype 信号）
        const r = await p.evalExpr(str('js'), false);
        return { ok: true, output: { result: r.value } };
      }
      case 'close': {
        this.shutdown();
        return { ok: true, output: { closed: true } };
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }

  /**
   * 点击目标解析：ref 优先（元素索引坐标——当帧有效），selector 降级
   * （evalExpr 解析中心点；覆盖不到 shadow 节点时 ref 是主路径）。
   */
  private async resolveClickTarget(args: Record<string, unknown>): Promise<{ x: number; y: number; desc: string }> {
    const ref = Number(args.ref);
    if (Number.isInteger(ref) && ref > 0) {
      if (ref > this.lastElements.length) throw new Error(`ref ${ref} 不在当前索引（elements 重取后再试）`);
      const el = this.lastElements[ref - 1]!;
      return { x: el.x, y: el.y, desc: `ref ${ref} <${el.tag}>` };
    }
    const selector = typeof args.selector === 'string' ? args.selector : '';
    if (selector) {
      const r = await this.page!.evalExpr(
        '(() => { const e = document.querySelector(' + JSON.stringify(selector) + ');' +
        'if (!e) return null; const r = e.getBoundingClientRect();' +
        'return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()',
      );
      const v = r.value as { x: number; y: number; w: number; h: number } | null;
      if (!v || v.w <= 0 || v.h <= 0) throw new Error(`selector 无匹配或不可见: ${selector}`);
      return { x: Math.round(v.x), y: Math.round(v.y), desc: `selector ${selector}` };
    }
    throw new Error('click 需要 ref（elements 索引）或 selector 之一');
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 浏览器会话（ac-web-tools 提供）：动作执行 + dispose 树杀 Chrome */
    browser: BrowserService;
  }
}
