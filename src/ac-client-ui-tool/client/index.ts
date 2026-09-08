// ============================================================
// ac-client-ui-tool/client/index.ts —— tool 基础件 client 半边
//（M27.2-2 出包之三：原 webui/src/clients/base/tool.ts 迁入升行包）
//
// 职责 = 工具结果视图域（ownership §3.2 落点）：
//   · tool-card:result-view 席位声明（keyed presentation——精确名/
//     正则族/priority 选举；M27.2-1 自 hostLedger 代持转正）；
//   · 内置 8 卡出厂注册（bash/read/write/edit/web/browser/subagent/
//     goal——第三方/域插件工具卡经 registerToolResultView 动态追加，
//     同 match 后注册者替换）；
//   · 卡片数据管线：goalCard（归一化）随件走；workspaceFile 已随域
//     迁 ui-workspace（M28 P1）——browser/write 卡跨包消费，P2 卡行
//     拆分后收口。
// 解析面（resolve/registerToolResultView）留 webui
// core/registry/toolResultViews.ts（消费面 = TurnDisplayItem）。
// ============================================================
import type { Component } from 'vue';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import ToolResultCode from './ToolResult/ToolResultCode.vue';
import ToolResultWeb from './ToolResult/ToolResultWeb.vue';
import ToolResultTerminal from './ToolResult/ToolResultTerminal.vue';
import ToolResultWrite from './ToolResult/ToolResultWrite.vue';
import ToolResultEdit from './ToolResult/ToolResultEdit.vue';
import ToolResultSubagent from './ToolResult/ToolResultSubagent.vue';
import ToolResultBrowser from './ToolResult/ToolResultBrowser.vue';
// 任务追踪工具面：todo 卡住 ac-client-ui-todo/client、goal 卡住
// ac-client-ui-goal/client（M28 P1 §4.1——域行出厂贡献，本件零任务追踪卡）

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
import { SLOT_KEY, type ToolResultViewDef } from './toolResultViews.ts';

/** 内置注册清单（出厂批次；单测回落面由 webui 解析面 legacy 路径消费） */
export const BUILTIN_TOOL_RESULT_VIEWS: Array<[string | RegExp, Component]> = [
  ['bash', ToolResultTerminal],
  ['read', ToolResultCode],
  ['write', ToolResultWrite],
  ['edit', ToolResultEdit],
  ['web_search', ToolResultWeb],
  // 浏览器主工具（独立组件：多动作 tab / steps 批量）；其余浏览器族工具走 ToolResultWeb
  ['browser', ToolResultBrowser],
  // 浏览器相关工具族
  [/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/, ToolResultWeb],
  // subAgent 工具（0.6.1 合并为单一 subagent，action 分发）
  ['subagent', ToolResultSubagent],
];

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
    for (const [match, component] of BUILTIN_TOOL_RESULT_VIEWS) {
      const def: ToolResultViewDef = { match, component, priority: 0 };
      ctx.slots.register(SLOT_KEY, { id: String(match), component, meta: { def } });
    }
  },
});

export default toolClientPlugin;
