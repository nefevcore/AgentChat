// ============================================================
// ac-client-ui-subagent/client/index.ts —— subagent 域前端行 client 半边
//
// 贡献面（subagent-session-view-plan §3.4）：
//   · tool-card:result-view keyed seat——subagent → ToolResultSubagent
//     （action 分发清单卡；M28 P2 §2.2 镜像表）；
//   · main:perspective 视角 subagent(9)——运行跟踪面板子Agent 行点击进入
//     的只读会话视角（SubagentConversationView；R7 让位协议随本行）。
// 行卸载 → def 消失 → 工具卡回落默认文本渲染 / 视角失去选举资格。
// ============================================================
import { clientPlugin, clientRuntime, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent, watch } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

// 卡片组件（异步：node 环境消费本模块不求值 .vue 视图链）
const ToolResultSubagent = defineAsyncComponent(() => import('./ToolResult/ToolResultSubagent.vue'));
// 子 Agent 会话视角组件（同上——异步求值）
const SubagentConversationViewAsync = defineAsyncComponent(() => import('./SubagentConversationView.vue'));

/** 视角状态读取（ui.subagentView——防御式：pinia 未装配的求值上下文返回
 *  null = 视角不激活，不抛错〔测试族裸 boot 场景，pairViewState 同款〕） */
function subagentViewState(): { subId: string; name?: string; parentId?: string } | null {
  try {
    return useUiStore().subagentView;
  } catch {
    return null;
  }
}

/** subagent 域前端行 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const subagentClientPlugin = clientPlugin({
  name: 'ac-client-ui-subagent.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // ── 工具卡贡献（M28 P2 原面） ──
    ctx.slots.inject('tool-card:result-view', () =>
      ctx.slots.register('tool-card:result-view', {
        id: 'subagent',
        component: ToolResultSubagent,
        meta: { def: { match: 'subagent', component: ToolResultSubagent, priority: 0, label: '子 Agent 调度', icon: 'bot' } },
      }),
    );

    // ── 子 Agent 会话视角（R7：order 9 显式居 pair(10) 前——互斥置位下
    //    不会同时 active，order 只是防御；让位 watch 随 owning 行自理） ──
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'subagent',
        component: SubagentConversationViewAsync,
        order: 9,
        meta: {
          def: {
            id: 'subagent', label: '子 Agent 会话', icon: 'bot', order: 9,
            active: () => !!subagentViewState(),
            component: SubagentConversationViewAsync,
            props: () => subagentViewState() ?? {},
          },
        },
      }),
    );

    // ── 主区让位 watch（R7：选中 Agent/群/独立会话 → 子会话视角回退——
    //    runview 行同款姿势，owning 行自理，壳零域知识。只在选中（非空
    //    变化）时收起：清空选择不打断阅读。三元组经根 runtime 可选探测
    //    （本行 fiber 未 inject roster/groups/singleBoard——直访会抛，
    //    ?. 探测 = 缺席 undefined 不抛）。 ──
    ctx.effect(() => {
      const stop = watch(
        () => {
          const rt = clientRuntime();
          return [
            rt?.roster?.core.activeAgentId.value ?? '',
            rt?.groups?.activeGroupId.value ?? '',
            rt?.singleBoard?.activeSingleId.value ?? '',
          ] as const;
        },
        (cur, prev) => {
          const selected = cur.some((v, i) => v && v !== prev[i]);
          if (!selected) return;
          try {
            useUiStore().closeSubagentView();
          } catch { /* pinia 未装配（裸 boot 测试）——静默 */ }
        },
      );
      return () => stop();
    });
  },
});

export default subagentClientPlugin;
