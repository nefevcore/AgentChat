// ============================================================
// ac-client-ui-desktop-storage —— 桌面壳「存储管理」前端行
//（数据根可配置 P2，2026-09-16 裁决）
//
// 后端半边仅是 boot graph 声明（declareClient——webui 按图装载 client
// 模块）；实际数据面全在壳层桥（127.0.0.1:<port+1>/desktop-bridge/），
// 前端自探活，非桌面形态（无桥）节自动隐藏。
// 卸本行 → 设置面板「存储管理」节与左树叶同步消失（D19 整枝退场）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-desktop-storage';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-desktop-storage',
  label: '存储管理（前端）',
  description: '桌面壳数据根设置节（数据根可配置 P2）：壳层存储桥消费 + 目录选择 + 数据迁移 UI；非桌面形态自动降级隐藏',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-desktop-storage',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
