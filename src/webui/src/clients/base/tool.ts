// ============================================================
// webui/src/clients/base/tool.ts —— tool 基础件（M27 S2：基础七件之三）
//
// D11/D19：tool 基础件职责 = 内置工具卡出厂贡献（tool-card:result-view
// keyed presentation seat 的出厂批次，D9 收编）。第三方/域插件工具卡经
// registerToolResultView（解析面不变）动态追加——同 match 后注册者替换。
// M27.2-1：席位声明自 hostLedger 代持转正（tool-card:result-view——
// tool 域 owning 件）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { BUILTIN_TOOL_RESULT_VIEWS, SLOT_KEY, type ToolResultViewDef } from '../../core/registry/toolResultViews';

// SlotMap 类型化声明：tool 基础件拥有的席位词表（自 hostLedger 转正）
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 工具结果整卡视图（keyed presentation——D9/S2 升 keyed 选举） */
    'tool-card:result-view': { kind: 'list' };
  }
}

export const toolBasePlugin = clientPlugin({
  name: 'webui-base-tool',
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
    for (const [match, component] of BUILTIN_TOOL_RESULT_VIEWS) {
      const def: ToolResultViewDef = { match, component, priority: 0 };
      ctx.slots.register(SLOT_KEY, { id: String(match), component, meta: { def } });
    }
  },
});
