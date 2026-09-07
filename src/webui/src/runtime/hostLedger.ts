// ============================================================
// webui/src/runtime/hostLedger.ts —— 宿主 slot 声明账本（M27 S1）
//
// D13 别名归一（slot-tree §6 收编表）的【声明面】：旧 8 UISlotId 中
// 六项组件贡献类的别名席位在此声明（ws-event / global-style 为常设
// 通道不进 slot 注册表——D8）。`public: true` = 第三方 manifest
// ui.slots 可声明的公开子集（S3 起校验面由账本派生，BUILTIN_SLOTS
// 静态表退役方向）。
//
// 归属路线：root/四 seat + main:perspective + sidebar:plugin-actions
// 归 layout 基础件（clients/base/layout.ts 随插件声明）；其余四席的
// owning 基础件（settings/tool/renderer/message 域）S2 起逐件认领，
// 过渡期由本模块的 hostLedger 插件代持（S4 薄壳收口时对齐 ownership
// §3.2 资产清单）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';

// ------------------------------------------------------------
// SlotMap 类型化声明（S1.5-1）：当前已实施声明集的类型词表。
// 后续域拆解（S2+）随声明生长逐域迁入各域插件；未注入的 key 走
// string 渐进兼容（string 账本共存——D1 分两步的第二步）。
// ------------------------------------------------------------
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 工具结果整卡视图（keyed presentation——D9/S2 升 keyed 选举） */
    'tool-card:result-view': { kind: 'list' };
    /** final 消息整卡视图（keyed final-view——D9/S2） */
    'message:final-view': { kind: 'list' };
    /** 全局设置页签（★settings-tab:global 别名） */
    'settings:main-view': { kind: 'list'; props: { globalConfig?: unknown } };
    /** Agent 编辑页页签（★settings-tab:agent 别名；base props = agentId/raw/effective/emit） */
    'agent-pane:tab': { kind: 'list'; props: { agentId?: string } };
  }
}

/** 宿主代持声明插件（装配序列第③步与基础件同批——封印前） */
export const hostLedgerPlugin = clientPlugin({
  name: 'webui-host-ledger',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // ---- D13 六项别名中的四个（其余两个随 layout 基础件声明） ----
    // 工具结果视图（keyed presentation seat——D9 收编 S2；精确名/正则族/
    // priority 语义原样进选举——slot-tree §5.6 状态词汇宿主固定重申）
    ctx.slots.declare({
      key: 'tool-card:result-view',
      kind: 'list',
      public: true,
      description: '工具结果整卡视图（★toolResultViews 收编目标；D9 于 S2 升 keyed seat）',
      ownerProps: {
        // slot-tree §5 横切契约（D2 挂靠）：状态词汇宿主固定（OK/ERR/BLK +
        // running dots），插件只能附着不能换（除显式 replace seat）
        fixedStatusVocabulary: true,
      },
    });
    // final 消息视图（keyed final-view seat——D9 收编 S2）
    ctx.slots.declare({
      key: 'message:final-view',
      kind: 'list',
      public: true,
      description: 'final 消息整卡视图（★messageViews 收编目标；D9 于 S2 升 keyed seat）',
      ownerProps: {
        // §5.1 四态回落：替换型未填充回落宿主默认渲染；loading/error/
        // empty/content 四态为对应替换型插口的天然子插口
        fourStateFallback: true,
      },
    });
    // 全局设置页签（★settings-tab:global 别名）
    ctx.slots.declare({
      key: 'settings:main-view',
      kind: 'list',
      public: true,
      description: '全局设置页签（settings:main-view = settings-tab:global 别名，D13）',
      ownerProps: {
        // §5.9 启停两层分家不可绕开：任何 card-actions 类 slot 不得提供
        // 第四条启停路径（强制停用=插件目录 / 软停用=全局默认层 / 差异层=Agent ext）
        noExtraTogglePath: true,
      },
    });
    // Agent 设置页签（★settings-tab:agent 别名）
    ctx.slots.declare({
      key: 'agent-pane:tab',
      kind: 'list',
      public: true,
      description: 'Agent 编辑页页签（agent-pane:tab = settings-tab:agent 别名，D13）',
      ownerProps: { noExtraTogglePath: true },
    });
  },
});
