// ============================================================
// ac-client-ui-system —— system 域前端行（M28 P1 §4.1 原案）
//
// 版本弹窗 + 系统小 API（版本/备份/changelog/更新）。入口动作（更多
// 菜单的版本/备份按钮）住 sidebar——动作跨行消费合法；本行供弹窗
// 呈现与数据面。卸本行 → overlay 贡献消失（版本弹窗退出）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-system';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-system',
  label: '系统（前端）',
  description: 'system 域前端行（M28 P1）：版本弹窗（overlay 席位贡献）+ 版本/备份/changelog/更新数据面；入口动作住 sidebar（跨行消费）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-system',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
