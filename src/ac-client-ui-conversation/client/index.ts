// ============================================================
// ac-client-ui-conversation/client/index.ts —— conversation 基础件
// client 半边（M27 S2/S3；M27.2-2 出包之五）
//
// D11/D19：conversation 基础件职责（§0.3 归属表）：
//   · 内置 final 消息视图出厂批次（message:final-view keyed seat，D9）；
//   · **会话服务 ctx.sessions**：统一信息流核心（FeedCore：per-dialog
//     分区 = scope 键、流式 ingest 状态机、历史分页投影管线）+ 会话动作
//     核心（ChatCore：发送/中断/排队/交互/预览/压缩反馈）——「域投影 +
//     服务面」的 conversation 形态。rpc 传输经 ctx.rpc 契约面注入。
// 双模门面（webui stores/feed.ts / stores/chat.ts）回落独立实例供既有
// 测试族（传 wireRpc）。服务名 'sessions' 与服务端 'session' 单数占名
// 无碰撞（D22 查重）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent, reactive } from 'vue';
import { createFeedCore, type FeedCore, type FeedView } from './feed-core.ts';
import { createChatCore, type ChatCore } from './chat-core.ts';
import { createQueuedDockStore } from './useQueuedMessages.ts';
import { chatPresence } from './chatOps.ts';
import { VIEWER_ID } from './viewer.ts';

// talk 视角组件（异步：node 环境消费本模块〔portb-e2e 等〕不求值 .vue
// 视图链——useMarkdown 模块级触 document；浏览器首渲染时才装载）。
// 会话区重构更名：DialogView → ConversationView（域词根对齐 + 消弹窗歧义）
const ConversationViewAsync = defineAsyncComponent(() => import('./ConversationView.vue'));
// Token 仪表（conversation:header-widget 出厂贡献 order 20——direct/single
// 上下文占用仪表；异步同上）
const TokenGaugeAsync = defineAsyncComponent(() => import('./header/TokenGauge.vue'));
// System Prompt 预览弹窗（overlay 出厂贡献 order 88——开关态住 ui store）
const SystemPromptModalAsync = defineAsyncComponent(() => import('./SystemPromptModal.vue'));

// ------------------------------------------------------------
// message:final-view 契约词表（SLOT_KEY/MessageViewDef 单源住
// messageViews.ts 解析面；解析面 = resolveMessageView/registerMessageView，
// webui core/registry/messageViews.ts re-export 维持旧路径）
// ------------------------------------------------------------

import { SLOT_KEY, type MessageViewDef } from './messageViews.ts';

/** 内置 final 消息视图出厂清单（user/assistant——内置 id 无 renderer，
 * 走 TurnDisplayItem 内建分支；与 webui messageViews 旧 BUILTIN 同源） */
const BUILTIN_MESSAGE_VIEWS: MessageViewDef[] = [
  { id: 'user', match: (turn) => turn.agent_id === VIEWER_ID.value },
  { id: 'assistant', match: () => true }, // 兜底：其他一律 assistant 视图
];

// ------------------------------------------------------------
// SlotMap 类型化声明（S3）：composer 上方任务追踪 dock 卡列席位
//（slot-tree chat:composer-docks 收编首例；M30 D5 改名
// conversation:dock-widget——第一段 = 宿主件）。
// owner props（D16-③ data 透传）= 会话桶归属（ComposerDock 传入）。
// M27.2-1：message:final-view 席位自 hostLedger 代持转正（message 域
// owning 件 = conversation）。
// ------------------------------------------------------------
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 任务追踪 dock 卡列（composer 上方；三态契约：undefined=不可用静默 / null|空=不渲染）。
     *  scope:'session'——store 座位实例轴按 conversationId 实例化（M28 §4.2：
     *  排队 dock 核心态 per-conversation 驻轴）。
     *  M30 D5 改名：tracking:dock-widget → conversation:dock-widget
     *  （第一段 = 席位宿主 owning 件——键名与声明归属同源；内容域 tracking
     *  不入键，域归属由本件 SlotMap 承载）。会话区重构：宿主件更名
     *  ComposerDock（位置语义——不预设列内容） */
    'conversation:dock-widget': {
      kind: 'list';
      scope: 'session';
      props: { agentId?: string | null; conversationId?: string | null };
    };
    /** 会话头动作区（会话区重构开席：list，order 序——jobs chip（jobs 行
     *  order 10）/ Token 仪表（本行 order 20）/ Agent·single 动作
     *  （agents·singles 行 order 30）等贡献；ownerProps = 会话形态与目标
     *  Agent，贡献按 form 自取自gate——群/pair 形态全部自隐。与
     *  conversation:dock-widget 同构的头部姿势） */
    'conversation:header-widget': {
      kind: 'list';
      props: {
        form: 'direct' | 'group' | 'single' | 'pair';
        agentId?: string | null;
        conversationId?: string | null;
        single?: unknown;
      };
    };
    /** final 消息整卡视图（keyed final-view——D9/S2；M30 D1 elect 扶正） */
    'message:final-view': { kind: 'list'; elect: true };
  }
}

interface ConversationClientOptions {
  /** 预留（对齐 cordis Service 构造签名形态） */
}

export class ConversationService extends Service {
  /** 统一信息流核心（per-dialog 分区 + 流式状态机 + 历史管线） */
  readonly feed: FeedCore;
  /** 会话动作核心（reactive 视图：feed 属性访问同 pinia store 解包语义） */
  readonly chat: ChatCore;

  static inject = ['rpc'];

  constructor(ctx: Context, options: ConversationClientOptions = {}) {
    super(ctx, 'sessions');
    void options;
    const rpc = (ctx as ClientContext).rpc;
    this.feed = createFeedCore(rpc);
    this.chat = createChatCore(reactive(this.feed) as unknown as FeedView, rpc);
  }

  /** 生命周期（幂等）：wire 订阅 + 名册启动链（装配序列显式发起——
   *  chat 核心名册链经 roster 取用口 useRosterCore → ctx.roster.core） */
  init(): void {
    this.chat.init();
  }

  // ---- 域行 client 协调面（M27 S3-1b：跨域写走服务方法——行 client
  //      不 import webui 内部 registry，经本面同步帧路由判别集合）----

  /** groups 域：重建群 presence 集（fetchGroups 后调用——帧路由 group 会话键判别） */
  setKnownGroups(ids: string[]): void {
    chatPresence.knownGroups.clear();
    for (const id of ids) chatPresence.knownGroups.add(id);
  }

  /** singles 域：登记/摘除单个会话 presence（list/create/update 登记、delete 摘除） */
  trackKnownSingle(id: string, removed = false): void {
    if (removed) chatPresence.knownSingles.delete(id);
    else chatPresence.knownSingles.add(id);
  }
}

// ctx.sessions 契约面归 ac-client-runtime（SessionsClientFace——行
// client 消费子集）；本服务结构满足契约，富类型经门面侧 cast 取回
//（webui stores/feed·chat）。不在此重复 declare（同键双声明 TS2717）。
import type { SessionsClientFace } from 'ac-client-runtime';

// 契约满足静态断言（ConversationService → SessionsClientFace 结构子集：
// 缺成员在此编译期显形，而非行 client 运行期才炸）
const _sessionsFace: SessionsClientFace = null as unknown as ConversationService;
void _sessionsFace;

/** conversation 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const conversationClientPlugin = clientPlugin({
  name: 'ac-client-ui-conversation.client',
  inject: ['slots', 'rpc'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(ConversationService);
    // 任务追踪 dock 卡列席位声明（M27 S3：slot-tree chat:composer-docks/
    // tracking:dock-widget——M30 D5 改名 conversation:dock-widget；ComposerDock
    // 渲染 outlet；todo 卡由 ac-todo 行 client 贡献、goal 条为宿主内置。
    // 三态契约见 SlotMap 声明）
    ctx.slots.declare({
      key: 'conversation:dock-widget',
      kind: 'list',
      scope: 'session',
      description: 'composer 上方任务追踪 dock 卡列（★slot-tree chat:composer-docks 收编；M30 D5 自 tracking:dock-widget 改名——第一段 = 宿主件；DSH dock 序 Todo → Goal → 排队 → 决策；store 座位实例轴 scope=session）',
      ownerProps: {
        // 刷新时机契约（slot-tree §… dock 候选注记）：贡献卡自理数据——
        // 会话切换 + tool/after-execute · loop/after-run 事件模式
        refreshPattern: 'tool/after-execute · loop/after-run',
        // 三态契约：undefined = 能力不可用静默 / null|空 = 不渲染（不占位）
        triState: true,
      },
    });
    // final 消息视图席位（keyed final-view seat——D9 收编 S2；M27.2-1 自
    // hostLedger 代持转正：本件即声明方；M30 D1 elect 扶正）
    ctx.slots.declare({
      key: SLOT_KEY,
      kind: 'list',
      elect: true,
      public: true,
      description: 'final 消息整卡视图（★messageViews 收编目标；D9 于 S2 升 keyed seat——match/priority 选举在解析面，M30 D1）',
      ownerProps: {
        // §5.1 四态回落：替换型未填充回落宿主默认渲染；loading/error/
        // empty/content 四态为对应替换型插口的天然子插口
        fourStateFallback: true,
      },
    });
    // 会话头动作区席位（会话区重构开席：list，order 序——头部按钮族
    // 域行贡献化。ownerProps data = { form, agentId, conversationId,
    // single }——贡献按形态自取自gate；三态契约同 dock：null/空 = 不渲染）
    ctx.slots.declare({
      key: 'conversation:header-widget',
      kind: 'list',
      description: '会话头动作区（ConversationView 头部右侧 chip/按钮族：jobs chip〔jobs 行〕/ Token 仪表〔本行〕/ Agent·single 动作〔agents·singles 行〕——order 序；ownerProps = 会话形态与目标 Agent，贡献自gate）',
    });
    // 内置 final 消息视图出厂批次（D9：message:final-view keyed seat）
    for (const def of BUILTIN_MESSAGE_VIEWS) {
      const entry: MessageViewDef = { ...def };
      ctx.slots.register(SLOT_KEY, {
        id: entry.id,
        component: { name: 'MessageViewStub', render: () => null }, // 内置 id 走 TurnDisplayItem 内建分支
        priority: entry.priority,
        meta: { def: entry },
      });
    }
    // queue/ask dock 出厂贡献（M28 §4.2 注记 0b：原视图内联渲染
    // 迁 conversation:dock-widget 贡献——排队 per-conversation 核心态上
    // store 座位实例轴〔entry.store 工厂 × scopeKey=conversationId〕，
    // ConversationView/QueueDockHost 同轴同实例；DSH dock 序 Todo(10) →
    // Goal(20) → 排队(30) → 决策(40)，与原内联 DOM 序一致〔视觉零 diff〕）
    ctx.slots.register('conversation:dock-widget', {
      id: 'queue',
      component: defineAsyncComponent(() => import('./QueueDockHost.vue')),
      order: 30,
      store: (handle) => createQueuedDockStore(handle.scopeKey, (ctx as ClientContext).rpc),
    });
    ctx.slots.register('conversation:dock-widget', {
      id: 'interaction',
      component: defineAsyncComponent(() => import('./InteractionBar.vue')),
      order: 40,
    });
    // Token 仪表头部贡献（会话区重构自 ConversationView 内联迁出：
    // conversation:header-widget 出厂 order 20——direct/single 上下文占用
    // 仪表 + 详情弹层 + 归档入口；群/pair 形态组件内自隐）
    ctx.slots.register('conversation:header-widget', {
      id: 'token-gauge',
      component: TokenGaugeAsync,
      order: 20,
    });
    // System Prompt 预览弹窗 overlay 贡献（会话区重构自 ConversationView
    // 内联 Modal 迁出：开关态住 ui store〔openSystemPrompt/closeSystemPrompt〕，
    // 内容/加载/错误住 chatStore；order 88 = 文件预览(90) 前位）
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-base-conversation.system-prompt',
        component: SystemPromptModalAsync,
        order: 88,
      }),
    );
    // talk 视角出厂（M28 P0-2/T6：域核心视图留本行 tier 0）。席位
    // 'main:perspective' 由 layout 基础件声明——base 批次名序
    // （ui-conversation < ui-layout）本行先装载，故经 slots.inject
    // 声明存活期效应落位：声明在场即注册、声明塌缩/本行卸载即回收
    //（注册撤销双路径幂等——SlotCore disposer active 旗）。
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'talk',
        component: ConversationViewAsync,
        order: 20,
        meta: {
          def: {
            id: 'talk', label: '会话', icon: 'message-circle', order: 20,
            active: () =>
              !ctx.get('groups')?.activeGroupId.value &&
              !ctx.get('singleBoard')?.activeSingleId.value,
            component: ConversationViewAsync,
            props: () => ({ group: null, single: null }),
          },
        },
      }),
    );
  },
});

export default conversationClientPlugin;
