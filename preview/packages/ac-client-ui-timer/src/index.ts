// ============================================================
// ac-client-ui-timer —— timer 域前端行（M28 P1 §4.1 原案）
//
// 视图资产行：TimerPane（Agent 定时任务编辑，含编辑弹窗）+ aux
// 聚合面板（TimersPanel——A3 起唯一全局任务入口）。数据面
//（timer/entries 读写）住本行 timerApi（M29 P1-3c 归域）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-timer';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-timer',
  label: '定时任务（前端）',
  description: 'timer 域前端行：Agent 定时任务编辑视图（TimerPane）+ timers aux 聚合面板（全局任务唯一入口）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-timer',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
