// ============================================================
// ac-client-ui-tool/client/index.ts —— tool 基础件 client 半边
//（M27.2-2 出包之三；M28 P2 宿主退化终态）
//
// 职责 = 工具结果视图域宿主（席位 + 解析面 + 选举语义，零卡）：
//   · tool-card:result-view 席位声明（keyed presentation——精确名/
//     正则族/priority 选举；M27.2-1 自 hostLedger 代持转正）；
//   · 解析面 toolResultViews（resolve/registerToolResultView——
//     webui core/registry re-export 维持旧路径）+ toolLabel/toolIcon
//     展示词条（T9：per-tool 词条随卡行走留 P3 数据注册表化批次）。
// 内置卡批次 M28 P2 全部退役随域行（§2.2 镜像表）：bash → ui-shell、
// read/write/edit → ui-fs、web_search+浏览器族 → ui-web、browser →
// ui-browser、subagent → ui-subagent、todo → ui-todo（M27.1）、goal →
// ui-goal（M28 P1）。卸任一卡行 → 该卡回落文本渲染（解析面 election
// 未命中 → 默认渲染）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';

// SlotMap 类型化声明：tool 基础件拥有的席位词表（自 hostLedger 转正）
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 工具结果整卡视图（keyed presentation——D9/S2 升 keyed 选举） */
    'tool-card:result-view': { kind: 'list' };
  }
}

/** 席位键 + 视图 def 单源住 toolResultViews.ts（解析面——node 测试链不触 .vue）；本模块 re-export 维持旧导出面 */
export { SLOT_KEY } from './toolResultViews.ts';
export type { ToolResultViewDef } from './toolResultViews.ts';
import { SLOT_KEY } from './toolResultViews.ts';

/** tool 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const toolClientPlugin = clientPlugin({
  name: 'ac-client-ui-tool.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 工具结果视图席位（keyed presentation seat——D9 收编 S2；精确名/正则族/
    // priority 语义原样进选举——slot-tree §5.6 状态词汇宿主固定重申）
    ctx.slots.declare({
      key: SLOT_KEY,
      kind: 'list',
      public: true,
      description: '工具结果整卡视图（★toolResultViews 收编目标；D9 于 S2 升 keyed seat）',
      ownerProps: {
        // slot-tree §5 横切契约（D2 挂靠）：状态词汇宿主固定（OK/ERR/BLK +
        // running dots），插件只能附着不能换（除显式 replace seat）
        fixedStatusVocabulary: true,
      },
    });
  },
});

export default toolClientPlugin;
