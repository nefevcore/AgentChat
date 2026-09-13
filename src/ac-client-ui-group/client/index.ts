// ============================================================
// ac-client-ui-group/client/index.ts —— group 域前端行 client 半边
//（M27.1，D19 改裁：ac-client-ui-* 独立 UI 行包）
//
// 自 webui/src/clients/groups.ts 迁入（S3-1b 行包 → M27.1 独立行）。
// 域投影 + 服务面（服务名 'groups' 与服务端 'group' 单数占名无碰撞，D22 查重）：
//   · 群列表 + 活跃群 + 创建弹窗状态（reactive 投影）；
//   · 域帧订阅（group/* 七事件 → 列表刷新；group/message-posted →
//     活跃时间重排）随本域 fiber 卸载回收（谁的数据谁订帧，§0.3 层 3）；
//   · 选中协调（清 Agent 选中 / feed 活跃对话同步 / lastContext 持久化）
//     ——走服务面互调（ctx.roster / ctx.sessions——行 client
//     不 import webui 内部）；
//   · 可摘除性（M27.1 双向）：卸本行 → ctx.groups 不可解析 → 群入口/
//     群聊视角消费面消失，宿主不残废；卸后端行 → RPC 失败 → 拉取
//     静默降级（warn + 空清单）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace, loadLastContext, saveLastContext, clearLastContextIf } from 'ac-client-runtime';
import { defineAsyncComponent, ref, type Ref } from 'vue';

// group 视角组件（异步：node 环境消费本模块不求值 .vue 视图链——
// defineAsyncComponent 跨包引用 ConversationView 内核〔会话区重构更名：
// DialogView → ConversationView〕——node 环境消费本模块不求值 .vue
// 视图链，浏览器首渲染时装载）
const ConversationViewAsync = defineAsyncComponent(() => import('ac-client-ui-conversation/client/ConversationView.vue'));
// 建群弹窗宿主（异步：node 环境消费本模块不求值 .vue 链——webui-kit
// Modal 等浏览器面组件，浏览器首渲染时装载）
const CreateGroupHostAsync = defineAsyncComponent(() => import('./CreateGroupHost.vue'));
// 群信息面板（M29 P1-2 自 conversation 迁域；会话区重构迁形——
// aux-sidebar 选区贡献；异步同上：node 环境不求值 .vue 链）
const GroupDrawerAsync = defineAsyncComponent(() => import('./GroupDrawer.vue'));

// ---- 域契约（契约随 UI 行走：owning = ac-client-ui-group） ----

/** 群条目视图（原 webui api/groups.ts 门面已退役〔M28 §4.2〕） */
export interface GroupInfo {
  group_id: string;
  name: string;
  participants: string[];
  created_at: number;
  description?: string;
  /** 群主（记忆属主）agent id；未设置 = undefined（成员各自记忆） */
  memory_owner?: string;
  /** 最近活动时间戳（P4：runs/snapshot 群会话桶 updatedAt 合成；实时侧 WS bump 覆盖） */
  lastActivity?: number;
}

interface PGroupConfig {
  id: string;
  name: string;
  members: string[];
  description?: string;
  createdAt?: number;
  /** 群主（记忆属主）——group/list 直转 GroupConfig.memoryOwner */
  memoryOwner?: string;
}

function toGroupInfo(g: PGroupConfig): GroupInfo {
  return {
    group_id: g.id,
    name: g.name,
    participants: g.members,
    created_at: g.createdAt ?? 0,
    ...(g.description !== undefined ? { description: g.description } : {}),
    ...(g.memoryOwner !== undefined ? { memory_owner: g.memoryOwner } : {}),
  };
}

/** 群名册（P4：聚合 runs/snapshot 群会话桶 lastActivity；snapshot 失败静默降级） */
export async function fetchGroups(rpc: Pick<RpcClientFace, 'call'>): Promise<{ groups: GroupInfo[] }> {
  const [r, snapR] = await Promise.all([
    rpc.call<{ groups?: PGroupConfig[] }>('group/list'),
    rpc
      .call<{ conversations?: Array<{ conversationId: string; updatedAt?: number }> }>('runs/snapshot')
      .catch(() => undefined),
  ]);
  const convOf = new Map((snapR?.conversations ?? []).map((c) => [c.conversationId, c]));
  return {
    groups: (r.groups ?? []).map((g) => {
      const lastActivity = convOf.get(g.id)?.updatedAt;
      return { ...toGroupInfo(g), ...(lastActivity !== undefined ? { lastActivity } : {}) };
    }),
  };
}

// ---- 域投影服务 ----

export interface GroupsClientOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

export class GroupsClientService extends Service {
  readonly groups: Ref<GroupInfo[]> = ref([]);
  readonly activeGroupId: Ref<string> = ref('');
  readonly showCreateGroup: Ref<boolean> = ref(false);
  /** 群信息面板开合意愿（会话区重构·aux 选区形态：active 谓词的域态半边
   * 右缘切换条 activate 置真、面板关闭钮/onGroupDeleted 置假；区域
   * 开合与显式选区住 layout uiStore，本域只管「想不想显示」） */
  readonly drawerOpen: Ref<boolean> = ref(false);

  /** 构造期 ctx = 本域插件 fiber（帧订阅绑定于此——卸载即回收，D5） */
  private readonly own: ClientContext;
  private initialized = false;

  constructor(ctx: Context, options: GroupsClientOptions = {}) {
    super(ctx, 'groups');
    this.own = ctx as ClientContext;
    void options;
  }

  async fetchGroups(): Promise<void> {
    try {
      const data = await fetchGroups(this.own.rpc);
      this.groups.value = data.groups ?? [];
      // presence 登记（feed 帧路由的群会话键判别——经会话服务协调面）
      this.own.sessions.setKnownGroups(this.groups.value.map((g) => g.group_id));
    } catch { /* ignore */ }
  }

  /** 选中群组 — 同步清除 Agent 选中，确保互斥；同步 feed 活跃对话 */
  selectGroup(groupId: string): void {
    this.own.roster.clearSelection();
    this.activeGroupId.value = groupId;
    this.own.sessions.feed.setActiveGroup(groupId);
    saveLastContext({ kind: 'group', id: groupId });
  }

  deselectGroup(): void {
    this.activeGroupId.value = '';
    this.own.sessions.feed.clearActiveGroup();
    clearLastContextIf('group');
  }

  openCreateGroup(): void { this.showCreateGroup.value = true; }
  closeCreateGroup(): void { this.showCreateGroup.value = false; }

  openDrawer(): void { this.drawerOpen.value = true; }
  closeDrawer(): void { this.drawerOpen.value = false; }

  onGroupCreated(groupId: string): void {
    void this.fetchGroups().then(() => this.selectGroup(groupId));
  }

  onGroupDeleted(groupId: string): void {
    // 抽屉随活跃群消失收起（防再选群时意外复开）
    this.drawerOpen.value = false;
    if (this.activeGroupId.value === groupId) {
      this.deselectGroup();
    }
    void this.fetchGroups();
  }

  /** 群组消息事件：更新列表活跃时间并重排 */
  handleGroupMessage(data: { group_id: string }): void {
    const idx = this.groups.value.findIndex((r) => r.group_id === data.group_id);
    if (idx >= 0) {
      this.groups.value[idx] = { ...this.groups.value[idx], lastActivity: Date.now() };
      this.groups.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    }
  }

  /**
   * 初始化：订阅 wire 群事件 + 拉取群组 + 恢复上次选中（仅当上次上下文是群组）。
   * 幂等：RunTracking / RunTrackingPanel 在群列表缺失时也会调 init() 补数据——
   * 帧订阅随本域 fiber 只挂一次，二次调用只做列表刷新。
   */
  init(): void {
    if (this.initialized) {
      void this.fetchGroups();
      return;
    }
    this.initialized = true;
    this.own.fiber.effect(() => this.own.rpc.onEvent((type, args) => {
      if (type === 'group/created' || type === 'group/deleted'
        || type === 'group/renamed' || type === 'group/description-set'
        || type === 'group/member-added' || type === 'group/member-removed'
        || type === 'group/memory-owner-set') { // 群主变更（他端设置/属主退群自动解除）同步列表
        void this.fetchGroups();
        return;
      }
      if (type === 'group/message-posted') {
        this.handleGroupMessage({ group_id: String((args[0] as unknown) ?? '') });
      }
    }), 'groups.wire');
    void this.fetchGroups().then(() => {
      // 恢复守卫：群组已被删除/不存在 → 放弃恢复（清掉过期记录）
      if (this.activeGroupId.value && !this.groups.value.some(g => g.group_id === this.activeGroupId.value)) {
        this.deselectGroup();
      }
    });
    const last = loadLastContext();
    if (last?.kind === 'group') this.selectGroup(last.id);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** group 域投影（ac-client-ui-group client 半边提供）：群列表/活跃群/创建弹窗 + 选中协调 */
    groups: GroupsClientService;
  }
}

/** group 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const groupClientPlugin = clientPlugin({
  name: 'ac-client-ui-group.client',
  inject: ['rpc', 'sessions', 'roster', 'slots'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(GroupsClientService);
    // 建群弹窗 overlay 贡献（M28 P1：原 layout AppFrame 内联项迁入；
    // order 95 = 保持原 overlay 序〔文件预览 90 → 建群 → 内联三件 100〕）
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-domain-group.create-dialog',
        component: CreateGroupHostAsync,
        order: 95,
      }),
    );
    // 群信息面板选区（会话区重构自 group:drawer 席位迁形：aux-sidebar
    // 选区贡献——右侧第四区域的标准选区之一，与工作区同级（右缘切换条
    // 同级按钮 + 二次点击收起）。active = drawerOpen 域态意愿；rail
    // activate = 切换条点击时置真；available = 群视角有活跃群才露出
    // 按钮。面板零 props：当前群/编辑态/删除编排随件内自理）
    ctx.slots.inject('aux-sidebar', () =>
      ctx.slots.register('aux-sidebar', {
        id: 'webui-domain-group.drawer',
        component: GroupDrawerAsync,
        order: 10,
        meta: {
          def: {
            id: 'group', order: 45, // rail 序：上下文触发组末位（available 有活跃群才露出——常驻组之下，出现时不打乱顺序）
            active: () => !!ctx.get('groups')?.drawerOpen.value,
            component: GroupDrawerAsync,
            rail: {
              icon: 'users', title: '群聊信息',
              activate: () => { ctx.get('groups')?.openDrawer(); },
            },
            available: () => !!ctx.get('groups')?.activeGroupId.value,
          },
        },
      }),
    );
    // group 视角出厂贡献（M28 P0-2/T6：视角 = 跨包引用 ConversationView
    // 内核 + 域 props——domain→base 合法；行卸载 → 群聊视角消失，talk 回落）。
    // 经 slots.inject 声明存活期效应落位（席位在场即注册/缺席即等待/
    // 声明塌缩或本行卸载即回收）。
    // 【事故修复】active/props 一律 ctx.get('groups') 可选探测——直接
    // 属性访问在本件 ctx（fiber 链上无人 inject 'groups'）会抛
    // "cannot get property without inject"（M28 P0.2 潜伏缺陷，M30 D4
    // 壳宿主条目化后被 EntryErrorBoundary 捕获退位 → 主区空白才显形；
    // talk def 的 ctx.get 姿势才是正解）。
    ctx.slots.inject('main:perspective', () =>
      ctx.slots.register('main:perspective', {
        id: 'group',
        component: ConversationViewAsync,
        order: 30,
        meta: {
          def: {
            id: 'group', label: '群聊', icon: 'users', order: 30,
            active: () => !!ctx.get('groups')?.activeGroupId.value,
            component: ConversationViewAsync,
            props: () => {
              const svc = ctx.get('groups');
              return {
                group: svc?.groups.value.find(r => r.group_id === svc.activeGroupId.value) ?? null,
                single: null,
              };
            },
          },
        },
      }),
    );
  },
});

export default groupClientPlugin;
