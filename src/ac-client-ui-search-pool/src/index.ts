// ============================================================
// ac-client-ui-search-pool —— search-pool 域前端行
//（2026-11 自 ui-llm-pool 拆分：模型池与搜索池是两个对象——
//  llm 连接管理留 ui-llm-pool 严格镜像 ac-llm-pool；搜索池
//  自成一等行。后端无专属池服务：searchProviders 是 config.json
//  池表键，消费方 = ac-web-tools〔web_search 读 default:true
//  条目取缺省 provider/key〕——本行与消费方仅经 config RPC
//  契约面耦合，双向可独立摘除。）
//
// 视图资产：SearchPoolManager（池 CRUD）+ SearchPoolsHost
//（settings:section 选举席贡献——settings 壳按 selectedNode ×
// meta.section 选举渲染）。数据经 settings 共享 store（useSettings
// ——domain→base）+ 本包 searchPoolApi 写面。
// 卸本行 → 搜索引擎节与左树叶同步消失（D19 整枝退场）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-search-pool';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-search-pool',
  label: '搜索引擎池（前端）',
  description: 'search-pool 域前端行（2026-11 自 ui-llm-pool 拆分）：搜索引擎池管理（settings:section 选举席贡献 searchPools 节）；后端消费方 = ac-web-tools，无专属后端池服务',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-search-pool',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
