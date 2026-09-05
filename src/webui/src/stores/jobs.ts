// ============================================================
// stores/jobs.ts —— 后台任务/子Agent 清单共享数据源
//
// 运行跟踪面板消费；刷新时机全事件化（无轮询）：
//   · 首次使用初始拉取（ensureStarted 幂等，app 生命周期单订阅）
//   · job/started · job/settled WS 帧 → 重拉 jobs/list
// 服务未装载/旧后端无 RPC → fetchJobs null → jobs 维持 null
// （面板渲染空态，不报错）。
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { wireRpc } from '../api/wire.ts';
import { fetchJobs, killJob, type WireJob } from '../api/jobs.ts';

export const useJobsStore = defineStore('jobs', () => {
  /** null = 面不可用（未装载/拉取失败）；空数组 = 无任务 */
  const jobs = ref<WireJob[] | null>(null);
  /** kill 请求进行中的任务 id（按钮态） */
  const killing = ref(new Set<string>());

  let started = false;
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return; // started/settled 连发时合并为一次在途请求
    inFlight = true;
    try {
      const next = await fetchJobs();
      if (next !== null) jobs.value = next;
    } finally {
      inFlight = false;
    }
  }

  /** 请求取消：本地即时标记 killing，终态经 job/settled 帧回投后刷新 */
  async function kill(id: string): Promise<void> {
    killing.value = new Set(killing.value).add(id);
    try {
      await killJob(id);
      await refresh();
    } finally {
      const done = new Set(killing.value);
      done.delete(id);
      killing.value = done;
    }
  }

  /** 首次使用启动（幂等）：初始拉取 + 事件帧订阅（app 生命周期常驻） */
  function ensureStarted(): void {
    if (started) return;
    started = true;
    void refresh();
    wireRpc.onWireEvent((type) => {
      if (type === 'job/started' || type === 'job/settled') void refresh();
    });
  }

  return { jobs, killing, refresh, kill, ensureStarted };
});
