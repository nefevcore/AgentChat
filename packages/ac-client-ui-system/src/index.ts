// ============================================================
// ac-client-ui-system/src/index.ts —— 前端行宿主半边（webui-v3 零功能形态）
//
// 图成员资格 = 行存在性（webui 基座文档 link: 装载锚——cr-1117 起
// declareClient 声明注册表随旧链退役）；client 半边经 wire 装载，
// 席位贡献/服务面全在 client/。extension 自述保留（extension-catalog
// 聚合消费——插件目录 label 数据源）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-system';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-system',
  label: '系统（前端）',
  description: 'system 域前端行（M28 P1）：版本弹窗（overlay 席位贡献）+ 版本/备份/changelog/更新数据面；入口动作住 layout（跨行消费）',
  automatic: true,
};

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
