// ============================================================
// ac-client-ui-group/src/index.ts —— 前端行宿主半边（webui-v3 零功能形态）
//
// 图成员资格 = 行存在性（webui 基座文档 link: 装载锚——cr-1117 起
// declareClient 声明注册表随旧链退役）；client 半边经 wire 装载，
// 席位贡献/服务面全在 client/。extension 自述保留（extension-catalog
// 聚合消费——插件目录 label 数据源）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-group';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-group',
  label: '群聊（前端）',
  description: 'group 域前端行：群聊投影 ctx.groups（群列表/活跃群/选中协调；boot graph 条目声明 + client 半边装载；与 ac-group 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
