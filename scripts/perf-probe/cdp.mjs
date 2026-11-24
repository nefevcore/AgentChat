// ============================================================
// cdp.mjs —— CDP 客户端最小面（P0-B cr-1296）
// 经 adb forward 的 DevTools socket 连目标（Android 浏览器 /
// WebView / desktop Chrome 同形）。只做本批采集需要的面：
//   attach / send / eval / navigate / onEvent
// 长任务、rAF 直方图、CPU profile 由 probe.mjs 编排。
// ============================================================
import WebSocket from 'ws';

let msgId = 0;
const pending = new Map();

/** 连接一个 CDP 目标（页面级 ws url），返回命令面 */
export async function attach(host, port, wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  const handlers = new Set();
  const events = [];
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} ${msg.error.data ?? ''}`.trim()));
      else res(msg.result);
      return;
    }
    // 事件面：Domain.event（Runtime.consoleAPICalled 等）
    if (msg.method !== undefined) {
      const rec = { method: msg.method, params: msg.params ?? {}, ts: Date.now() };
      events.push(rec);
      for (const h of handlers) {
        try { h(rec); } catch { /* 观察面失败不拖垮采集 */ }
      }
    }
  });
  const cdp = {
    ws,
    events,
    onEvent(h) { handlers.add(h); },
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval(expression, { awaitPromise = false, returnByValue = true } = {}) {
      const r = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise, returnByValue, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`eval 异常: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
      }
      return r.result?.value;
    },
    async navigate(url, { waitMs = 1500 } = {}) {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url });
      // 不等 loadEventFired（WS 长连不触发 load 完成）——静默窗后即取控
      await new Promise((r) => setTimeout(r, waitMs));
    },
    async close() {
      ws.removeAllListeners();
      try { ws.close(); } catch { /* already closed */ }
    },
  };
  return cdp;
}

/** 列出目标（page 级）——host:port CDP HTTP 面 */
export async function listTargets(host, port) {
  const res = await fetch(`http://${host}:${port}/json`);
  const arr = await res.json();
  return arr.filter((t) => t.type === 'page');
}
