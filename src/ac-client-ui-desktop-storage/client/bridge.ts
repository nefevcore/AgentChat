// bridge.ts —— 桌面壳存储桥客户端（127.0.0.1:<p+1..p+4>/desktop-bridge/）
// 壳层按 pickedPort+1 → +4 依序试绑（EACCES=WinNAT 排除区 / EADDRINUSE=被占
// 时顺延），前端同序列探测：探活失败 = 非桌面形态或桥不可用 → 宿主隐藏本节。
import { ref } from 'vue';

export interface StorageInfo {
  dataRoot: string;
  defaultDataRoot: string;
  customized: boolean;
  total: number;
  breakdown: Record<string, number>;
  platform: string;
}

/** 页面端口（dev vite 3831 / 生产壳 pickedPort；无端口形态按协议缺省） */
function pagePort(): number {
  return Number(location.port || (location.protocol === 'https:' ? 443 : 80));
}

/** 壳桥候选基址序列（与 desktop/main.mjs start() 的 for 候选序列同款） */
function bridgeCandidates(): string[] {
  const p = pagePort();
  return [1, 2, 3, 4].map((d) => `http://127.0.0.1:${p + d}`);
}

/** 探得的桥基址（null = 未探活/不可用）；init 成功后由 pick/setRoot 复用 */
let bridgeBase: string | null = null;

async function probeBase(base: string): Promise<StorageInfo | null> {
  try {
    const r = await fetch(`${base}/desktop-bridge/storage`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return (await r.json()) as StorageInfo;
  } catch {
    return null;
  }
}

export function useDesktopBridge() {
  const info = ref<StorageInfo | null>(null);
  const ready = ref(false);

  /** 依序探测候选口；首个探活成功者胜出并缓存基址 */
  async function init(): Promise<void> {
    for (const base of bridgeCandidates()) {
      const data = await probeBase(base);
      if (data) {
        bridgeBase = base;
        info.value = data;
        ready.value = true;
        return;
      }
    }
    ready.value = false;
  }

  /** 未探活基址（非桌面形态/桥全候选失败）——调用方已在 ready=false 下不可达，防御性兜底 */
  function requireBase(): string {
    if (!bridgeBase) throw new Error('存储桥不可用（非桌面形态或端口探测失败）');
    return bridgeBase;
  }

  async function pick(): Promise<{ canceled: boolean; path: string | null }> {
    const r = await fetch(`${requireBase()}/desktop-bridge/storage/pick`, { method: 'POST' });
    if (!r.ok) throw new Error(`桥响应 ${r.status}`);
    return r.json();
  }

  async function setRoot(path: string, migrate: boolean): Promise<{ ok: boolean; restarting: boolean }> {
    const r = await fetch(`${requireBase()}/desktop-bridge/storage/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, migrate }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `桥响应 ${r.status}`);
    return j as { ok: boolean; restarting: boolean };
  }

  void init();

  return { info, ready, pick, setRoot };
}
