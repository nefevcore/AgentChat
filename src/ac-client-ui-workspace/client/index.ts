// ============================================================
// ac-client-ui-workspace/client/index.ts —— workspace 域前端行 client
// 半边（M27.1，D19 改裁：ac-client-ui-* 独立 UI 行包）
//
// 自 webui/src/clients/workspaces.ts 迁入（S3-1b 行包 → M27.1 独立行）：
// ctx.workspaceBoard（服务名避让服务端 'workspace' 单数占名——Board
// 后缀与 jobBoard/singleBoard 同族，D22 查重）。域投影：用户工作区
// 清单 + CRUD 管理写面。数据面 = 宿主 REST 端点（/api/workspaces——
// 浏览器原生 fetch 同源直连，无 RPC/事件帧依赖）。
// M28 P1 域资产归位（行完整）：fileApi/EntryPickerModal/FilePreviewModal/
// WorkspaceTree(/Node)/workspaceFile 随域迁入；文件预览以 overlay 席位
// 贡献落位、工作区树以 main:workspace 席位贡献落位（壳留 layout）。
// 可摘除性（双向）：卸本行 → ctx.workspaceBoard 不可解析 + overlay/
// main:workspace 贡献消失（预览弹窗/树面板/路径选择器退出，宿主壳
// rail 同步隐藏）；卸后端行 → REST 失败 → 拉取静默降级（warn + 空清单）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';
import FilePreviewHost from './FilePreviewHost.vue';
import WorkspaceTreeHost from './WorkspaceTreeHost.vue';

/** 用户工作区条目（契约随行走——webui api/files.ts re-export 维持旧路径） */
export interface Workspace {
  id: string;
  name: string;
  /** 文件夹绝对路径（会话沙箱白名单根） */
  path: string;
  createdAt: string;
  updatedAt: string;
}

// ---- 工作区文件树（M27.2-2 layout 件出包随件迁：WorkspaceTree 消费；
//      /api/workspace/tree HTTP 面——webui api/files.ts 薄包装维持旧路径） ----

export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  children?: WorkspaceNode[];
}

/** 工作区树（query：目录路径，空=根；懒加载） */
export function fetchWorkspaceTree(query: string): Promise<{ path?: string; children?: WorkspaceNode[] }> {
  return jsonFetch(`/api/workspace/tree${query}`);
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export function fetchWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return jsonFetch('/api/workspaces');
}

export function createWorkspace(payload: { path: string; name?: string }): Promise<{ workspace: Workspace }> {
  return jsonFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateWorkspace(id: string, payload: { name?: string; path?: string }): Promise<{ workspace: Workspace }> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

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
      console.warn('[WorkspaceBoard] 拉取用户工作区失败:', (err as { message?: string })?.message ?? String(err));
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
    /** workspace 域投影（ac-client-ui-workspace client 半边提供）：用户工作区清单 + CRUD */
    workspaceBoard: WorkspaceBoardService;
  }
}

/** workspace 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const workspaceClientPlugin = clientPlugin({
  name: 'ac-client-ui-workspace.client',
  inject: ['slots'],
  async apply(ctx: ClientContext) {
    // 文件预览弹窗（overlay 席位贡献；order 90 = 保持原 AppFrame 内联
    // 序首位——DOM 序不变）
    ctx.slots.register('overlay', {
      id: 'webui-domain-workspace.file-preview',
      component: FilePreviewHost,
      order: 90,
    });
    // 工作区树面板（main:workspace 席位贡献——壳/宽度把手留 layout）
    ctx.slots.register('main:workspace', {
      id: 'webui-domain-workspace.tree',
      component: WorkspaceTreeHost,
    });
    await ctx.plugin(WorkspaceBoardService);
  },
});

export default workspaceClientPlugin;
