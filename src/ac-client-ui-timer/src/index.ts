// ============================================================
// ac-client-ui-timer —— timer 域前端行（M28 P1 §4.1 原案）
//
// 视图资产行：TimerPane（Agent 定时任务编辑，含编辑弹窗）。数据面
//（timer/entries 读写）住 settings api（Agent 配置写侧编排）；
// 全局 sys.timer 页签贡献随 P2 settings 退化落位（SettingsPanel
// 内联块届时经 settings:main-view 席位迁入本行——裁决注记见
// m28 计划执行进度段）。
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
  description: 'timer 域前端行（M28 P1）：Agent 定时任务编辑视图（TimerPane）；全局 sys.timer 页签贡献随 P2 settings 退化落位',
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
