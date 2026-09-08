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
import { reactive } from 'vue';
import { createFeedCore, type FeedCore, type FeedView } from './feed-core.ts';
import { createChatCore, type ChatCore } from './chat-core.ts';
import { chatPresence } from './chatOps.ts';
import { VIEWER_ID } from './viewer.ts';
import type { Turn } from './types.ts';

// ------------------------------------------------------------
// message:final-view 契约词表（解析面 = webui core/registry/
// messageViews.ts——resolveMessageView 消费 registry entries 的
// meta.def；本包持有席位声明与出厂 def）
// ------------------------------------------------------------

/** 席位键（与 webui 解析面同词汇） */
export const SLOT_KEY = 'message:final-view';

/** final 消息视图 def（match 谓词选举——TurnDisplayItem 内建分支消费） */
export interface MessageViewDef {
  id: string;
  match: (turn: Turn, final: boolean) => boolean;
  priority?: number;
  renderer?: unknown;
}

/** 内置 final 消息视图出厂清单（user/assistant——内置 id 无 renderer，
 * 走 TurnDisplayItem 内建分支；与 webui messageViews 旧 BUILTIN 同源） */
export const BUILTIN_MESSAGE_VIEWS: MessageViewDef[] = [
  { id: 'user', match: (turn) => turn.agent_id === VIEWER_ID.value },
  { id: 'assistant', match: () => true }, // 兜底：其他一律 assistant 视图
];

// ------------------------------------------------------------
// SlotMap 类型化声明（S3）：composer 上方任务追踪 dock 卡列席位
//（slot-tree chat:composer-docks/tracking:dock-widget 收编首例）。
// owner props（D16-③ data 透传）= 会话桶归属（TaskDock 传入）。
// M27.2-1：message:final-view 席位自 hostLedger 代持转正（message 域
// owning 件 = conversation）。
// ------------------------------------------------------------
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 任务追踪 dock 卡列（composer 上方；三态契约：undefined=不可用静默 / null|空=不渲染） */
    'tracking:dock-widget': {
      kind: 'list';
      props: { agentId?: string | null; conversationId?: string | null };
    };
    /** final 消息整卡视图（keyed final-view——D9/S2） */
    'message:final-view': { kind: 'list' };
  }
}

export interface ConversationClientOptions {
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
   *  chat 核心 init 的名册链经 pinia 门面，main.ts setActivePinia 之后调用） */
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
    // tracking:dock-widget——TaskDock 渲染 outlet；todo 卡由 ac-todo 行
    // client 贡献、goal 条为宿主内置。三态契约见 SlotMap 声明）
    ctx.slots.declare({
      key: 'tracking:dock-widget',
      kind: 'list',
      description: 'composer 上方任务追踪 dock 卡列（★slot-tree chat:composer-docks/tracking:dock-widget；DSH dock 序 Todo → Goal）',
      ownerProps: {
        // 刷新时机契约（slot-tree §… dock 候选注记）：贡献卡自理数据——
        // 会话切换 + tool/after-execute · loop/after-run 事件模式
        refreshPattern: 'tool/after-execute · loop/after-run',
        // 三态契约：undefined = 能力不可用静默 / null|空 = 不渲染（不占位）
        triState: true,
      },
    });
    // final 消息视图席位（keyed final-view seat——D9 收编 S2；M27.2-1 自
    // hostLedger 代持转正：本件即声明方）
    ctx.slots.declare({
      key: SLOT_KEY,
      kind: 'list',
      public: true,
      description: 'final 消息整卡视图（★messageViews 收编目标；D9 于 S2 升 keyed seat）',
      ownerProps: {
        // §5.1 四态回落：替换型未填充回落宿主默认渲染；loading/error/
        // empty/content 四态为对应替换型插口的天然子插口
        fourStateFallback: true,
      },
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
  },
});

export default conversationClientPlugin;
