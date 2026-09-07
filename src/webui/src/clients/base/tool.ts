// ============================================================
// webui/src/clients/base/tool.ts —— tool 基础件（M27 S2：基础七件之三）
//
// D11/D19：tool 基础件职责 = 内置工具卡出厂贡献（tool-card:result-view
// keyed presentation seat 的出厂批次，D9 收编）。第三方/域插件工具卡经
// registerToolResultView（解析面不变）动态追加——同 match 后注册者替换。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { BUILTIN_TOOL_RESULT_VIEWS, SLOT_KEY, type ToolResultViewDef } from '../../core/registry/toolResultViews';

export const toolBasePlugin = clientPlugin({
  name: 'webui-base-tool',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    for (const [match, component] of BUILTIN_TOOL_RESULT_VIEWS) {
      const def: ToolResultViewDef = { match, component, priority: 0 };
      ctx.slots.register(SLOT_KEY, { id: String(match), component, meta: { def } });
    }
  },
});
