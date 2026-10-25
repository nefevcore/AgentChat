// ============================================================
// ac-client-ui-remote —— 「远程设备」设置节前端行（P1）
//
// 消费 ac-remote-link 的 remote/* RPC 面（devices/pair/revoke/status）。
// 卸本行 → 设置面板「远程设备」节与左树叶同步消失；remote-link 后端
// 行不受影响（RPC 面仍在——CLI/loopback 客户端照用）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-remote';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-remote',
  label: '远程设备（前端）',
  description: '远程设备设置节：设备列表/吊销 + 配对二维码展示 + SAS 比对（remote-link P1）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-remote',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}