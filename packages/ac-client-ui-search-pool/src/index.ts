// ============================================================
// ac-client-ui-search-pool/src/index.ts —— 前端行宿主半边（webui-v3 零功能形态）
//
// 图成员资格 = 行存在性（webui 基座文档 link: 装载锚——cr-1117 起
// declareClient 声明注册表随旧链退役）；client 半边经 wire 装载，
// 席位贡献/服务面全在 client/。extension 自述保留（extension-catalog
// 聚合消费——插件目录 label 数据源）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-search-pool';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-search-pool',
  label: '搜索引擎池（前端）',
  description: 'search-pool 域前端行（2026-09-11 自 ui-llm-pool 拆分）：搜索引擎池管理（settings:section 选举席贡献 searchPools 节）；后端消费方 = ac-web-tools，无专属后端池服务',
  automatic: true,
};

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
