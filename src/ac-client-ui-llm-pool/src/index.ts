// ============================================================
// ac-client-ui-llm-pool —— llm-pool 域前端行（M28 P2 §5.2）
//
// Provider 连接池管理 UI：PoolManager（llm 连接/search 引擎）+
// 池更新编排 Host（settings:section 选举席贡献——settings 壳按
// selectedNode × meta.section 选举渲染）。数据经 settings 共享 store
//（useSettings——保存编排归 settings 壳）。
// 卸本行 → 模型管理/搜索引擎节消失（树仍在，内容区空态）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-llm-pool';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-llm-pool',
  label: '连接池管理（前端）',
  description: 'llm-pool 域前端行（M28 P2）：Provider 连接池/搜索引擎池管理（settings:section 选举席贡献）；与 ac-llm-pool 后端行双向可独立摘除',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-llm-pool',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
