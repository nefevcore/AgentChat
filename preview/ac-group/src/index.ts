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

export const name = 'ac-group';

export const inject = ['agents', 'conversation'];

/** 行配置（透传 GroupService 构造） */
export interface GroupRowOptions {
  /** 数据根（给定即启用持久化；群目录 = <root>/groups） */
  root?: string;
  /** 本体轮转阈值（总 token；缺省 500_000） */
  archiveTokens?: number;
  /** 轮转后本体保留尾部 token 预算（缺省 30_000） */
  keepTokens?: number;
  /** 群历史回放加载预算（缺省 30_000） */
  loadLimitTokens?: number;
  /** 派生窗重派生阈值（M21/D6·D5；缺省 100_000） */
  rederiveTokens?: number;
}

export function apply(ctx: Context, options: GroupRowOptions = {}) {
  ctx.plugin(GroupService, options);
}

export { GroupService, GROUP_HINT_META } from './service.ts';
export { wrapGroupMsg, escapeMsgAttr } from './view.ts';
export type { GroupMsgViewParams } from './view.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
