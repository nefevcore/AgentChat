// ============================================================
// ac-singles —— 独立会话插件行
//
// 元数据 owning 服务（<root>/singles/<sid>/session.json）。跨域读取
// （agents/workspace/session）在服务方法内经 ctx.get 可选解析——
// 缺服务时校验放行（投递/统计在各自域兜底），本行不硬依赖任何服务。
// config（{ root? }）：数据根，与各持久化行同根约定。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { SinglesService } from './service.ts';

export const name = 'ac-singles';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'singles',
  label: '独立会话',
  description: '独立会话元数据（ctx.singles）：绑定 Agent 或回落默认预设路由（分区会话视图）',
  automatic: true,
};

/** 行配置（透传 SinglesService 构造） */
export interface SinglesRowOptions {
  /** 数据根目录（缺省 './data'；元数据目录 = <root>/singles） */
  root?: string;
}

export function apply(ctx: Context, options: SinglesRowOptions = {}) {
  ctx.plugin(SinglesService, options);
}

export { SinglesService } from './service.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
