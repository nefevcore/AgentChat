// ============================================================
// webui/src/clients/groups.ts —— group 域插件（M27 S2：群组域）
//
// 归属表 §0.3：groups.ts → group 域 → ctx.groups（服务名 'groups' 与
// 服务端 'group' 单数占名无碰撞，D22 查重通过）。域投影 + 服务面：
//   · 群列表 + 活跃群 + 创建弹窗状态（reactive 投影）；
//   · 域帧订阅（group/* 七事件 → 列表刷新；group/message-posted →
//     活跃时间重排）随本域 fiber 卸载回收（谁的数据谁订帧，§0.3 层 3）；
//   · 选中协调（清 Agent 选中 / feed 活跃对话同步 / lastContext 持久化）
//     ——过渡期经 pinia store 模块协调（feed/chat 收尾时改服务面互调）；
//   · 域投影不挂全局 pinia（§0.3 红线）——stores/groups.ts 随本迁移退役；
//   · 可摘除性（D19）：卸载本插件 → ctx.groups 不可解析 → 群入口/群聊
//     视角消费面消失，宿主不残废。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';
import type { GroupInfo } from '../types';
import { fetchGroups as apiFetchGroups } from '../api/groups';
import { wireRpc } from '../api/wire';
import { chatPresence } from '../api/chat-ops';
import { useFeedStore } from '../stores/feed';
import { useAgentStore } from '../stores/agents';
import { loadLastContext, saveLastContext, clearLastContextIf } from '../utils/lastContext';

export interface GroupsClientOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

export class GroupsClientService extends Service {
  readonly groups: Ref<GroupInfo[]> = ref([]);
  readonly activeGroupId: Ref<string> = ref('');
  readonly showCreateGroup: Ref<boolean> = ref(false);

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
      const data = await apiFetchGroups();
      this.groups.value = data.groups ?? [];
      // presence 登记（feed 帧路由的群会话键判别）
      chatPresence.knownGroups.clear();
      for (const g of this.groups.value) chatPresence.knownGroups.add(g.group_id);
    } catch { /* ignore */ }
  }

  /** 选中群组 — 同步清除 Agent 选中，确保互斥；同步 feed 活跃对话 */
  selectGroup(groupId: string): void {
    useAgentStore().activeAgentId = '';
    this.activeGroupId.value = groupId;
    useFeedStore().setActiveGroup(groupId);
    saveLastContext({ kind: 'group', id: groupId });
  }

  deselectGroup(): void {
    this.activeGroupId.value = '';
    useFeedStore().clearActiveGroup();
    clearLastContextIf('group');
  }

  openCreateGroup(): void { this.showCreateGroup.value = true; }
  closeCreateGroup(): void { this.showCreateGroup.value = false; }

  onGroupCreated(groupId: string): void {
    void this.fetchGroups().then(() => this.selectGroup(groupId));
  }

  onGroupDeleted(groupId: string): void {
    if (this.activeGroupId.value === groupId) {
      this.activeGroupId.value = '';
      useFeedStore().clearActiveGroup();
      clearLastContextIf('group');
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
    this.own.fiber.effect(() => {
      const off = wireRpc.onWireEvent((type, args) => {
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
      });
      return off;
    }, 'groups.wire');
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
    /** group 域投影（webui 域插件提供）：群列表/活跃群/创建弹窗 + 选中协调 */
    groups: GroupsClientService;
  }
}

/** group 域插件（装配序列第④步：in-bundle） */
export const groupsDomainPlugin = clientPlugin({
  name: 'webui-domain-groups',
  async apply(ctx: ClientContext) {
    await ctx.plugin(GroupsClientService);
  },
});
