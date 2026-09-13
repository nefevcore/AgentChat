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
// 贡献落位、工作区树以 aside 席位选区条目落位（2026-11 构造对齐·层级
// 修正：aux-sidebar 席位 = 辅助侧边栏（第四区域本身），工作区 = 众多选区之一——rail 收起
// 态把手资产随条目 def 住本行，壳零域知识）。
// 可摘除性（双向）：卸本行 → ctx.workspaceBoard 不可解析 + overlay/
// aside 选区贡献消失（预览弹窗/树面板/路径选择器/收起态 rail 一并
// 退出——区域整体消失，内在于选举）；卸后端行 → REST 失败 → 拉取
// 静默降级（warn + 空清单）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent, ref, type Ref } from 'vue';
import type { AuxSidebarPanelDef } from 'ac-client-ui-layout/client/auxSidebarViews.ts';
import FilePreviewHost from './FilePreviewHost.vue';
import WorkspaceTreeHost from './WorkspaceTreeHost.vue';
import { usePreviewTabsStore } from './previewTabs.ts';

// 多 tab 预览面板（异步：node 环境消费本模块不求值 .vue 视图链）
const FilePreviewPanelHostAsync = defineAsyncComponent(() => import('./FilePreviewPanelHost.vue'));

/** 用户工作区条目（契约随行走——原 webui api/files.ts 门面已退役〔M28 §4.2〕） */
export interface Workspace {
  id: string;
  name: string;
  /** 文件夹绝对路径（会话沙箱白名单根） */
  path: string;
  createdAt: string;
  updatedAt: string;
}

// ---- 工作区文件树（M27.2-2 layout 件出包随件迁：WorkspaceTree 消费；
//      /api/workspace/tree HTTP 面——原 webui api/files.ts 门面已退役〔M28 §4.2〕） ----

export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
  children?: WorkspaceNode[];
}

/** 工作区树（query：目录路径，空=根；懒加载）。ctx（M33 前端反馈 #1）：
 *  agentId/conversationId 可选透传——服务端树基准随会话上下文定位
 *  （会话挂载工作区 > Agent 专用空间 > 数据根）；root.label = 基准名。 */
export function fetchWorkspaceTree(
  query: string,
  ctx?: { agentId?: string; conversationId?: string },
): Promise<{ path?: string; children?: WorkspaceNode[]; root?: { label?: string } }> {
  const suffix = query;
  if (!ctx) return jsonFetch(`/api/workspace/tree${suffix}`);
  const sep = suffix ? '&' : '?';
  const parts: string[] = [];
  if (ctx.agentId) parts.push(`agentId=${encodeURIComponent(ctx.agentId)}`);
  if (ctx.conversationId) parts.push(`conversationId=${encodeURIComponent(ctx.conversationId)}`);
  if (!parts.length) return jsonFetch(`/api/workspace/tree${suffix}`);
  return jsonFetch(`/api/workspace/tree${suffix}${sep}${parts.join('&')}`);
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
    // 工作区选区（aside 席位 keyed 选举条目——2026-11 构造对齐·层级
    // 修正：aside 席位 = 第四区域本身，工作区 = 众多选区之一）：def
    // id 'workspace' + 自带辅助活动栏按钮资产（icon/标题——域行供，
    // 壳零域文案知识；icon = folder-tree：工作区 = 目录树面板的象形，
    // 取代早前 panel-right 的「开关面板」隐喻）；缺省 volatile——区域
    // 收起即卸载（树体轻）
    ctx.slots.register('aux-sidebar', {
      id: 'webui-domain-workspace.tree',
      component: WorkspaceTreeHost,
      meta: {
        def: {
          id: 'workspace',
          order: 40, // rail 序：常驻组末位（预览10/用量15/跟踪20/任务25/定时30/prompt35 之后）
          active: () => true,
          component: WorkspaceTreeHost,
          rail: { icon: 'folder-tree', title: '工作区' },
        } satisfies AuxSidebarPanelDef,
      },
    });
    // 文件预览选区（P1 aux 第三选区：多 tab 预览面板——active =
    // previewTabs.panelOpen 域内意愿〔意图通道 openPreview → openTab
    // 置真〕；rail activate = 重开上次 tab 清单；tab 状态住 pinia
    // store，选区卸载不丢——重开恢复。volatile 卸载 + store 常驻 =
    // 轻体回载）。树点击/消息文件链路写意图（uiStore.previewIntent），
    // FilePreviewHost（overlay 宿主）watch 开 tab + 显式选区 + 展开。
    ctx.slots.register('aux-sidebar', {
      id: 'webui-domain-workspace.preview',
      component: FilePreviewPanelHostAsync,
      meta: {
        def: {
          id: 'preview',
          order: 10, // rail 序：首位（最高频参考面）；显式选区路径不受 order 影响
          comfyWidth: 'half', // 舒适宽：半屏（代码/文档对照——意图与 rail 切换统一铺开）
          active: () => {
            try { return usePreviewTabsStore().panelOpen; } catch { return false; }
          },
          component: FilePreviewPanelHostAsync,
          rail: {
            icon: 'file-text',
            title: '文件预览',
            activate: () => {
              const tabs = usePreviewTabsStore();
              if (tabs.count === 0) return; // 空 tab 无内容可开——按钮无效（不展开空面板）
              tabs.openPanel();
            },
          },
          available: () => {
            try { return usePreviewTabsStore().count > 0; } catch { return false; }
          },
        } satisfies AuxSidebarPanelDef,
      },
    });
    await ctx.plugin(WorkspaceBoardService);
  },
});

export default workspaceClientPlugin;
