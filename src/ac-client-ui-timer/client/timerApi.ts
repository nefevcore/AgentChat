// ============================================================
// ac-client-ui-timer/client/timerApi.ts —— 定时任务数据面
//（M29 P1-3c 自 settings/api.ts 归域迁入——T3「数据面跟域走」：
// 视图已随行（TimerPane/GlobalTimerHost），数据面随视图归位）
//
// 形态：rpc 必传（消费组件/编排侧经 rpc 契约面 + seam 取用）。
// 全局定时任务（globalConfig.timer.tasks）= 全局配置域，读写在
// settings api（getGlobalConfig/saveGlobalConfig）——不在此。
// ============================================================
import type { TimerEntry } from 'ac-client-ui-settings/client/types.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export type { TimerEntry };

/** Agent 定时任务清单（timer/entries） */
export async function getAgentTimers(agentId: string, rpc: Rpc): Promise<{ entries: TimerEntry[] }> {
  const r = await rpc.call<{ entries?: TimerEntry[] }>('timer/entries', { agentId });
  return { entries: r.entries ?? [] };
}

/** 保存 Agent 定时任务（timer/save；回显保存值） */
export async function saveAgentTimers(agentId: string, entries: TimerEntry[], rpc: Rpc): Promise<{ entries: TimerEntry[] }> {
  await rpc.call('timer/save', { agentId, entries });
  return { entries };
}
