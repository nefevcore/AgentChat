// ============================================================
// ac-client-ui-onboarding —— 首启向导前端行
//（first-run-onboarding-plan，cr-298）
//
// 五步覆盖层向导：用户设置 / 模型设置 / 搜索设置 / Agent 设置 /
// 界面导览。首启（localStorage 无标记）boot 就绪后自动弹；走完或
// 跳过即写标记；重播经活动栏「更多」菜单（activity-bar:more-menu
// 数据席位，批 4）。表单复用既有数据面（跨包 import 先例：
// ActivityBar import systemApi / useAgentSettings import settings
// api——D2 裁决放行）。
//
// 可摘除性：卸本行 → overlay 席位与菜单项随 fiber 回收，首启不再
// 弹；被复用行零改动。反向：ui-llm-pool/ui-search-pool 缺席 → 对应
// 步骤降级为静态说明 + 深链按钮，不得崩（席位/RPC 失败静默降级）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-onboarding';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-onboarding',
  label: '新手引导（前端）',
  description: '首启向导：五步覆盖层（用户/模型/搜索/Agent/导览），首启自动弹一次，更多菜单可重播；纯增量前端行',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber）
  const off = ctx.webui.declareClient({
    name: 'ui-onboarding',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
