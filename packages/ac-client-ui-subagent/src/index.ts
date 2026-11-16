// ============================================================
// ac-client-ui-subagent/src/index.ts —— 前端行宿主半边（webui-v3 零功能形态）
//
// 图成员资格 = 行存在性（webui 基座文档 link: 装载锚——cr-1117 起
// declareClient 声明注册表随旧链退役）；client 半边经 wire 装载，
// 席位贡献/服务面全在 client/。extension 自述保留（extension-catalog
// 聚合消费——插件目录 label 数据源）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-subagent';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-subagent',
  label: '子Agent 工具卡·会话视角（前端）',
  description: 'subagent 域前端行：subagent 工具卡（action 分发清单卡）+ 子 Agent 会话只读视角（运行跟踪面板点击进入——历史回放，工具卡/思维链经 steps[] 落盘重建）',
  automatic: true,
};

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
