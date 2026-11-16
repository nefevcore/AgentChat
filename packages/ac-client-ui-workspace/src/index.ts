// ============================================================
// ac-client-ui-workspace/src/index.ts —— 前端行宿主半边（webui-v3 零功能形态）
//
// 图成员资格 = 行存在性（webui 基座文档 link: 装载锚——cr-1117 起
// declareClient 声明注册表随旧链退役）；client 半边经 wire 装载，
// 席位贡献/服务面全在 client/。extension 自述保留（extension-catalog
// 聚合消费——插件目录 label 数据源）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-workspace';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-workspace',
  label: '工作区（前端）',
  description: 'workspace 域前端行（M28 P1 行完整）：ctx.workspaceBoard 工作区投影 + 文件预览（aux preview 选区多 tab 面板 + overlay 零渲染意图宿主）+ 工作区树（aside 席位选区条目——def id workspace，自带 rail 收起态资产，2026-09-11 构造对齐·层级修正）+ 路径选择/上传/目录浏览数据面；与 ac-workspace 后端行双向可独立摘除',
  automatic: true,
};

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
