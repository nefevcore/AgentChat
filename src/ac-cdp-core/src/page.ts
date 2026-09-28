// ============================================================
// ac-cdp-core/src/page.ts —— 页面会话（单标签页 + 诊断采集）
//
// 一个 CdpPage = 一个 flat session（Target.attachToTarget flatten），
// 经同一条浏览器级连接路由。诊断采集（M3）在 session 建立时订阅：
// Network 请求生命周期（只记 method/url/status/耗时——默认不记
// header，防 cookie/token 入 LLM 上下文）、Runtime 控制台与异常、
// Log.entryAdded（CORS/网络层错误的来源）。环形缓冲 + marker 游标
// （logs since 语义）。弹窗 M1 只自动 dismiss。
// ============================================================
import type { CdpClient } from './client.ts';
import type { CdpRemoteObject, CdpSnapshotDoc } from './protocol.ts';

/** 控制台/日志条目（console + exception + Log 三源归一） */
export interface DiagConsoleEntry {
  seq: number;
  t: number;
  kind: 'console' | 'exception' | 'log';
  level: 'verbose' | 'info' | 'warning' | 'error';
  text: string;
  location?: string;
}

/** 网络请求条目（生命周期态：pending → done/failed） */
export interface DiagNetEntry {
  seq: number;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  durationMs?: number;
  state: 'pending' | 'done' | 'failed';
  errorText?: string;
  size?: number;
  /** 内部计时（不面向 LLM 序列化裁剪） */
  startT: number;
}

export interface CdpPageOptions {
  /** 环形缓冲容量（缺省 500） */
  bufferCapacity?: number;
  /** 单条文本截断（缺省 4000 字符） */
  textTruncate?: number;
}

const CONSOLE_LEVEL: Record<string, DiagConsoleEntry['level']> = {
  log: 'info', debug: 'verbose', info: 'info', warning: 'warning',
  error: 'error', assert: 'error', clear: 'info', dir: 'verbose',
  table: 'verbose', trace: 'verbose',
};

const KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
};

export class CdpPage {
  readonly client: CdpClient;
  readonly sessionId: string;
  readonly targetId: string;
  private cap: number;
  private truncateLen: number;
  private consoleBuf: DiagConsoleEntry[] = [];
  private netBuf: DiagNetEntry[] = [];
  private netIndex = new Map<string, DiagNetEntry>();
  private seqCounter = 0;

  private constructor(client: CdpClient, sessionId: string, targetId: string, options: CdpPageOptions) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.cap = options.bufferCapacity ?? 500;
    this.truncateLen = options.textTruncate ?? 4_000;
  }

  /** 事件接驳：owner 在 client 'event' 分发时喂入本 session 的事件 */
  handleEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const rid = String(params.requestId ?? '');
        const req = (params.request ?? {}) as { method?: string; url?: string };
        const cur = this.netIndex.get(rid);
        if (cur) {
          // 重定向链复用 requestId：条目更新为最终目的地
          cur.method = String(req.method ?? cur.method);
          cur.url = String(req.url ?? cur.url);
        } else {
          const entry: DiagNetEntry = {
            seq: ++this.seqCounter,
            requestId: rid,
            method: String(req.method ?? 'GET'),
            url: String(req.url ?? ''),
            resourceType: String(params.type ?? 'Other'),
            state: 'pending',
            startT: Date.now(),
          };
          this.netBuf.push(entry);
          this.netIndex.set(rid, entry);
          if (this.netBuf.length > this.cap) {
            const dropped = this.netBuf.shift();
            if (dropped) this.netIndex.delete(dropped.requestId);
          }
        }
        return;
      }
      case 'Network.responseReceived': {
        const res = (params.response ?? {}) as { status?: number };
        const cur = this.netIndex.get(String(params.requestId ?? ''));
        if (cur && cur.state === 'pending') {
          cur.status = Number(res.status ?? 0);
          cur.durationMs = Date.now() - cur.startT;
          cur.state = 'done'; // 乐观态；getResponseBody 的硬门槛（loadingFinished）在取体侧校验
        }
        return;
      }
      case 'Network.loadingFinished': {
        const cur = this.netIndex.get(String(params.requestId ?? ''));
        if (cur) {
          cur.state = 'done';
          cur.size = Number(params.encodedDataLength ?? cur.size ?? 0);
        }
        return;
      }
      case 'Network.loadingFailed': {
        const cur = this.netIndex.get(String(params.requestId ?? ''));
        if (cur) {
          cur.state = 'failed';
          cur.errorText = String(params.errorText ?? 'failed');
          cur.durationMs = Date.now() - cur.startT;
        }
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const parts = ((params.args ?? []) as Array<{ value?: unknown; description?: string }>)
          .map((a) => (a.value !== undefined ? String(a.value) : String(a.description ?? '')));
        this.pushConsole({
          seq: ++this.seqCounter,
          t: Date.now(),
          kind: 'console',
          level: CONSOLE_LEVEL[String(params.type ?? 'log')] ?? 'info',
          text: this.trunc(parts.join(' ')),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = (params.exceptionDetails ?? {}) as {
          text?: string; exception?: { description?: string; className?: string };
        };
        this.pushConsole({
          seq: ++this.seqCounter,
          t: Date.now(),
          kind: 'exception',
          level: 'error',
          text: this.trunc(d.exception?.description ?? (`${d.exception?.className ?? ''} ${d.text ?? ''}`.trim() || 'exception')),
        });
        return;
      }
      case 'Log.entryAdded': {
        const e = (params.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number };
        this.pushConsole({
          seq: ++this.seqCounter,
          t: Date.now(),
          kind: 'log',
          level: e.level === 'warning' || e.level === 'error' ? e.level : 'info',
          text: this.trunc(String(e.text ?? '')),
          location: e.url ? `${e.url}:${e.lineNumber ?? 0}` : undefined,
        });
        return;
      }
      case 'Page.javascriptDialogOpening': {
        // M1 只自动 dismiss（不 accept——accept 可能触发下载/导航）
        void this.client.send('Page.handleJavaScriptDialog', { accept: false }, this.sessionId).catch(() => undefined);
        return;
      }
      default:
        return;
    }
  }

  private pushConsole(entry: DiagConsoleEntry): void {
    this.consoleBuf.push(entry);
    if (this.consoleBuf.length > this.cap) this.consoleBuf.shift();
  }

  private trunc(s: string): string {
    return s.length > this.truncateLen ? s.slice(0, this.truncateLen) + '…' : s;
  }

  /** 当前 marker（logs since 语义的游标基线） */
  get marker(): number {
    return this.seqCounter;
  }

  /** 控制台条目（seq > since；level 起滤——'error' 含以上即仅 error） */
  consoleEntries(since: number, level?: DiagConsoleEntry['level']): DiagConsoleEntry[] {
    const order: DiagConsoleEntry['level'][] = ['verbose', 'info', 'warning', 'error'];
    const minIdx = level ? order.indexOf(level) : 0;
    return this.consoleBuf.filter((e) => e.seq > since && order.indexOf(e.level) >= minIdx);
  }

  /** 网络条目（seq > since） */
  netEntries(since: number): DiagNetEntry[] {
    return this.netBuf.filter((e) => e.seq > since);
  }

  /** error 概览（open 摘要）：console error 数 + 失败请求数 */
  errorOverview(since: number): { consoleErrors: number; failedRequests: number } {
    return {
      consoleErrors: this.consoleEntries(since, 'error').length,
      failedRequests: this.netEntries(since).filter((e) => e.state === 'failed').length,
    };
  }

  // ── 会话建立与域启用 ──────────────────────────────────────

  /** 新建标签页并建立 flat session（诊断域全启用 + Emulation 一致性初始化） */
  static async open(
    client: CdpClient,
    options: CdpPageOptions & {
      userAgent?: string;
      locale?: string;
      timezone?: string;
      viewport?: { width: number; height: number };
    } = {},
  ): Promise<CdpPage> {
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<{ sessionId: string }>(
      'Target.attachToTarget', { targetId, flatten: true },
    );
    const page = new CdpPage(client, sessionId, targetId, options);
    const s = sessionId;
    await Promise.all([
      client.send('Page.enable', {}, s),
      client.send('Runtime.enable', {}, s),
      client.send('Network.enable', {}, s),
      client.send('Log.enable', {}, s),
    ]);
    // Emulation 一致性初始化（光改 UA 字符串会造成指纹自相矛盾）
    const emu: Array<[string, Record<string, unknown>]> = [];
    if (options.userAgent) {
      emu.push(['Emulation.setUserAgentOverride', { userAgent: options.userAgent }]);
    }
    if (options.locale) emu.push(['Emulation.setLocaleOverride', { locale: options.locale }]);
    if (options.timezone) emu.push(['Emulation.setTimezoneOverride', { timezoneId: options.timezone }]);
    const vp = options.viewport ?? { width: 1280, height: 720 };
    emu.push(['Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
    }]);
    for (const [method, params] of emu) await client.send(method, params, s);
    return page;
  }

  /** 会话级命令捷径 */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId, timeoutMs);
  }

  // ── 页面操作 ──────────────────────────────────────────────

  /** 导航（domcontentloaded 语义：loadEventFired 或超时即返回；settleMs 额外静置） */
  async navigate(url: string, timeoutMs = 30_000, settleMs = 0): Promise<{ url: string; title: string }> {
    const loaded = this.client.waitForEvent('Page.loadEventFired', this.sessionId, timeoutMs);
    await this.send('Page.navigate', { url });
    await loaded;
    if (settleMs > 0) await new Promise<void>((r) => setTimeout(r, settleMs));
    const [{ value: href }, { value: title }] = await Promise.all([
      this.evalExpr('location.href'),
      this.evalExpr('document.title'),
    ]);
    return { url: String(href ?? url), title: String(title ?? '') };
  }

  /**
   * 表达式求值（returnByValue；undefined 结果返回 null）。
   * function 结果带可读报错（IIFE 漏写调用括号的高频笔误——
   * returnByValue 下序列化为 {} 静默丢失，2026-10-09 复盘决断）。
   */
  async evalExpr(expression: string, awaitPromise = false): Promise<{ value: unknown }> {
    const r = await this.send<{ result: CdpRemoteObject; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'evaluate 失败');
    }
    const ro = r.result;
    if (ro.type === 'function') {
      throw new Error('eval 返回了 function 本体而非调用结果——疑似 IIFE 漏写调用括号：`(() => { ... })` 应为 `(() => { ... })()`（末尾缺 ()）');
    }
    if (ro.subtype === 'promise') {
      throw new Error('eval 返回了未等待的 Promise——请改为同步取值，或用 (async () => { ... })() 形态并在内部 await 后返回结果（本工具不等待 Promise，序列化会变 {} 静默丢失）');
    }
    if (ro.unserializableValue !== undefined) {
      return { value: Number.isNaN(Number(ro.unserializableValue)) ? ro.unserializableValue : Number(ro.unserializableValue) };
    }
    return { value: ro.value ?? null };
  }

  /** DOM 快照（布局 + 绘制序） */
  async snapshot(): Promise<CdpSnapshotDoc> {
    return this.send<CdpSnapshotDoc>('DOMSnapshot.captureSnapshot', {
      computedStyles: [], includeDOMRects: true, includePaintOrder: true,
    });
  }

  /** 坐标点击（Input 合成 trusted 事件） */
  async click(x: number, y: number): Promise<void> {
    const common = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased' });
  }

  /** 移动悬停 */
  async hover(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { x, y, type: 'mouseMoved' });
  }

  /** 插入文本（触发完整输入事件链） */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /** 按键（常见键映射虚拟键码） */
  async press(key: string): Promise<void> {
    const code = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const common = {
      type: '', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      ...(code === 32 ? { text: ' ' } : {}),
    };
    await this.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' });
    await this.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  }

  /** 滚动（trusted 手势） */
  async scroll(direction: 'up' | 'down', amountPx: number): Promise<void> {
    await this.send('Input.synthesizeScrollGesture', {
      x: 0, y: 0,
      ...(direction === 'down' ? { yDistance: amountPx } : { yDistance: -amountPx }),
      speed: 2000,
    });
  }

  /** 截图（base64 PNG） */
  async screenshot(fullPage: boolean): Promise<string> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png', ...(fullPage ? { captureBeyondViewport: true } : {}),
    });
    return r.data;
  }

  /**
   * 取响应体。协议硬约束：仅可在该 requestId 的 loadingFinished 之后
   * 调用（快速 XHR 竞态必报 -32000）——缓冲里 state!=='done' 或已逐出
   * 时如实报原因（fail-soft 带原因，不重试掩盖）。
   */
  async responseBody(requestId: string, maxLen: number): Promise<{ body: string; truncated: boolean }> {
    const entry = this.netIndex.get(requestId);
    if (!entry) throw new Error(`无此请求 ${requestId}（缓冲已逐出或未发出）`);
    if (entry.state === 'pending') throw new Error(`请求 ${requestId} 尚未完成（loadingFinished 后才可取体）`);
    if (entry.state === 'failed') throw new Error(`请求 ${requestId} 已失败: ${entry.errorText ?? ''}`);
    const r = await this.send<{ body: string; base64Encoded: boolean }>(
      'Network.getResponseBody', { requestId },
    ).catch((err: unknown) => {
      // 导航清空后缓冲逐出语义：-32000 统一转可读原因
      throw new Error(`取响应体失败（${requestId}）: ${err instanceof Error ? err.message : String(err)}`);
    });
    const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf-8') : r.body;
    return { body: body.length > maxLen ? body.slice(0, maxLen) : body, truncated: body.length > maxLen };
  }
}
