// ============================================================
// webui/src/clients/workspaces.ts —— workspace 域插件（M27 S2）
//
// 归属表 §0.3：workspaces.ts 读面→runtime 对象层；管理→workspace 域。
// 本插件承载两半：ctx.workspaceBoard（域投影：清单 + CRUD 管理写面）。
// 层 2 对象层的 roster 式只读共享（多基础件共读）待 agents 域迁移时
// 以 ctx.objects 键落位（S2 后续）；当前消费面（SessionList 会话树根 /
// ChatInput 工作区挂载）一律经 ctx.workspaceBoard。
//
// 服务名避让：服务端已占 'workspace'（单数）——'workspaceBoard' 与
// jobBoard/singleBoard 同族（D22 查重纪律）。
// 可摘除性（D19）：卸载本插件 → ctx.workspaceBoard 不可解析 → 会话树
// 工作区根消失，宿主不残废。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';
import {
  fetchWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  type Workspace,
} from '../api/files';
import { logger } from '../utils/logger';

export interface WorkspaceBoardOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

export class WorkspaceBoardService extends Service {
  /** 用户工作区清单（会话树分组的文件夹白名单） */
  readonly workspaces: Ref<Workspace[]> = ref([]);
  readonly loaded: Ref<boolean> = ref(false);

  constructor(ctx: Context, options: WorkspaceBoardOptions = {}) {
    super(ctx, 'workspaceBoard');
    void options;
  }

  async refresh(): Promise<void> {
    try {
      const d = await fetchWorkspaces();
      this.workspaces.value = d.workspaces ?? [];
      this.loaded.value = true;
    } catch (err: unknown) {
      logger.warn('[WorkspaceBoard] 拉取用户工作区失败:', (err as { message?: string })?.message ?? String(err));
    }
  }

  async create(payload: { path: string; name?: string }): Promise<Workspace> {
    const d = await createWorkspace(payload);
    await this.refresh();
    return d.workspace;
  }

  async rename(id: string, name: string): Promise<void> {
    await updateWorkspace(id, { name });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await deleteWorkspace(id);
    await this.refresh();
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** workspace 域投影（webui 域插件提供）：用户工作区清单 + CRUD */
    workspaceBoard: WorkspaceBoardService;
  }
}

/** workspace 域插件（装配序列第④步：in-bundle） */
export const workspacesDomainPlugin = clientPlugin({
  name: 'webui-domain-workspaces',
  async apply(ctx: ClientContext) {
    await ctx.plugin(WorkspaceBoardService);
  },
});
