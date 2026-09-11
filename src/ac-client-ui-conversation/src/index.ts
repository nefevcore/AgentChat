// ============================================================
// ac-client-ui-conversation —— conversation 基础件前端行
//（M27.2-2 出包之五）
//
// 基础七件之一（phase:'base'——封印前批次装载）：会话域。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// client 半边资产（ownership §3.2 落点；M28 P1 域资产归位后形态）：
//   · ctx.sessions 会话服务（FeedCore 信息流 + ChatCore 动作——rpc 经
//     RpcClientFace 契约面注入）；
//   · message:final-view / conversation:dock-widget 席位声明 + 内置消息
//     视图出厂批次 + talk 视角出厂贡献（slots.inject 声明存活期效应）；
//   · 会话类型（types）/feed 纯函数层（feed）/chatOps/历史回放 API
//    （historyApi）/追踪与媒体小件 + ConversationView 族视图（域核心视图，
//    T6/T8 tier 0）。名册消费面经 roster 取用口（ac-client-ui-agents
//    rosterAccess——M28 §4.2 agentsStore 门面退役）。
// M28 P1 域资产归位迁出：groupApi/skillsApi/goalApi/useGoalTracking/
// GoalBar/rosterApi/fileApi/EntryPickerModal/FilePreviewModal（随域行
// 走——group/skill/goal/agents/workspace）。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-conversation';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-conversation',
  label: '会话（前端）',
  description: 'conversation 基础件前端行：会话域（ctx.sessions 信息流/动作核心 + message:final-view/conversation:dock-widget 席位 + 会话类型/工具链/历史 API；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-conversation',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
