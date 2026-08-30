// ============================================================
// stores/runs.ts —— Agent 运行跟踪共享数据源
//
// 侧边栏「运行」面板与主区「运行矩阵」视图共用同一份快照轮询
// （单一 timer，不因两处组件同时挂载而翻倍请求）：
//   · 3s 轮询 /api/runs（页面不可见时跳过该轮）
//   · 1s 本地时钟 now（运行时长递增显示）
// 首次使用自动启动，常驻 app 生命周期（监控型数据，开销可忽略）。
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchRuns } from '../api/runs';
import type { RunsSnapshot } from '../api/runs';

export const useRunsStore = defineStore('runs', () => {
  const snapshot = ref<RunsSnapshot | null>(null);
  const loadError = ref('');
  const loading = ref(false);
  const now = ref(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 拉取快照。**内容未变化时保留原对象引用**（只更新 generatedAt）——
   * 3s 轮询若每次都替换对象，会触发矩阵 400+ 格子的 computed 级联重算与
   * 全量 patch（实测卡顿主因）；引用不变则派生全部短路，零渲染。
   */
  async function refresh(): Promise<void> {
    // in-flight 防护：3s 轮询无守卫时，慢响应（>3s）乱序完成会把已更新的
    // snapshot 回滚成旧快照（矩阵数据"回跳/闪烁"）
    if (inFlight) return;
    inFlight = true;
    loading.value = true;
    try {
      const next = await fetchRuns();
      loadError.value = '';
      const cur = snapshot.value;
      if (cur && signature(cur) === signature(next)) {
        cur.generatedAt = next.generatedAt; // 仅时间戳变化（响应式小更新，只影响快照时间显示）
        return;
      }
      snapshot.value = next;
    } catch (err: any) {
      loadError.value = err?.message ?? String(err);
    } finally {
      inFlight = false;
      loading.value = false;
    }
  }
  let inFlight = false;

  /** 快照内容签名（剔除每次必变的 generatedAt） */
  function signature(s: RunsSnapshot): string {
    const { generatedAt: _drop, ...rest } = s;
    return JSON.stringify(rest);
  }

  /** 首次使用时启动轮询（幂等）；组件无需 stop（app 生命周期常驻） */
  function ensurePolling(): void {
    if (pollTimer) return;
    void refresh();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
    tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  return { snapshot, loadError, loading, now, refresh, ensurePolling, stopPolling };
});
