// bridge.ts —— 桌面壳存储桥客户端（127.0.0.1:<port+1>/desktop-bridge/）
// 探活失败 = 非桌面形态 → 宿主隐藏本节（不报错）。
import { ref } from 'vue';

export interface StorageInfo {
  dataRoot: string;
  defaultDataRoot: string;
  customized: boolean;
  total: number;
  breakdown: Record<string, number>;
  platform: string;
}

function bridgeBase(): string {
  // 同源族推导：后端 3830 → 桥 3831（壳层 startBridge(port+1) 约定）
  const p = Number(location.port || (location.protocol === 'https:' ? 443 : 80));
  return `http://127.0.0.1:${p + 1}`;
}

export function useDesktopBridge() {
  const info = ref<StorageInfo | null>(null);
  const ready = ref(false);

  async function probe(): Promise<boolean> {
    try {
      const r = await fetch(`${bridgeBase()}/desktop-bridge/storage`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      info.value = await r.json();
      return true;
    } catch {
      return false;
    }
  }

  async function pick(): Promise<{ canceled: boolean; path: string | null }> {
    const r = await fetch(`${bridgeBase()}/desktop-bridge/storage/pick`, { method: 'POST' });
    if (!r.ok) throw new Error(`桥响应 ${r.status}`);
    return r.json();
  }

  async function setRoot(path: string, migrate: boolean): Promise<{ ok: boolean; restarting: boolean }> {
    const r = await fetch(`${bridgeBase()}/desktop-bridge/storage/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, migrate }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `桥响应 ${r.status}`);
    return j as { ok: boolean; restarting: boolean };
  }

  // 惰性探活（onMounted 由宿主触发）
  async function init() {
    ready.value = await probe();
  }
  void init();

  return { info, ready, pick, setRoot };
}
