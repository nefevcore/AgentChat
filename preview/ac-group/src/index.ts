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

export const inject = ['agents', 'conversation'];

export function apply(ctx: Context, options: GroupRowOptions = {}) {
  ctx.plugin(GroupService, options);
}

export { GroupService, GROUP_HINT_META, isGroupHint } from './service.ts';
export type { GroupRowOptions } from './service.ts';
export type { GroupMsgViewParams } from './view.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
