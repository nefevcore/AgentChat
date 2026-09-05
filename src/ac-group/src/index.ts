// ============================================================
// ac-group —— 群拓扑插件行
//
// inject ['agents', 'conversation']：agents = 成员校验（Agent 是数据）；
// conversation = 参与者投递（busy=steer / idle=新 run，handle=gid~member）。
// config（{ root?, archiveTokens?, keepTokens?, loadLimitTokens? }）：
// root 给定即启用持久化（成员表 group.json + 本体 messages.jsonl +
// 轮转 archive/；缺省纯内存——测试/演示）。缺服务时本行 PENDING，
// 服务到位自动激活。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { GroupService } from './service.ts';
import type { GroupRowOptions } from './service.ts';

export const name = 'ac-group';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'group',
  label: '群聊',
  description: '群聊服务（ctx.group）：成员表 + 群投递 + 群聊行为契约（决策点注入）+ 群记忆属主（group/* 事件）',
  automatic: true,
  fields: [
    { name: 'contractText', type: 'text', default: '', description: '群聊行为契约文本（怎么回/直接输出无效/沉默权/不刷屏）——注入在每个群 run 的"回/不回"决策点（历史尾部、触发消息之前；系统提示词位置会注意力稀释失效）。留空使用内置正典。自定义文案建议按 Agent 分组 A/B 观察沉默率与回复质量' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '群聊行为契约注入', description: '群桶 run 启动前把契约插到历史尾部、触发消息之前（沉默权/不刷屏/send_group 语义——两次真实事故沉淀的实测文案）' },
  ],
};

export const inject = ['agents', 'conversation'];

export function apply(ctx: Context, options: GroupRowOptions = {}) {
  ctx.plugin(GroupService, options);
}

export { GroupService, GROUP_HINT_META, isGroupHint, GROUP_CONTRACT_TEXT } from './service.ts';
export type { GroupRowOptions } from './service.ts';
export type { GroupMsgViewParams } from './view.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
