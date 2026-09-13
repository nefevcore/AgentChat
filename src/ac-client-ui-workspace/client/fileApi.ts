// ============================================================
// ac-client-ui-workspace/client/fileApi.ts —— 上传与目录浏览
//（M28 P1 域资产归位：自 conversation 随域迁入——T3 数据面跟域走）
//
// browseDirs = workspace/browse-dirs RPC（路径穿透白名单的文件夹
// 选择弹窗）；pickFolder = workspace/pick-folder RPC（本机系统原生
// 文件夹选择对话框——主路径，error 时调用方降级回 browseDirs 弹窗）；
// uploadFile = /api/upload multipart（HTTP 直连，非 RPC）。
// 纯数据面（零 conversation 依赖）：上传指纹的 chatPresence 路径登记
// 是会话域行为，留消费方（conversation 侧薄包装 + webui api/files
// 门面 re-export 维持旧路径）。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import type { ReadContext } from './workspaceFile.ts';

type Rpc = Pick<RpcClientFace, 'call'>;

/** workspace/browse-dirs 返回形状：path 空 = 快捷根清单；否则子目录列表
 *  （只列目录不列文件；无权限/不存在 → error 字符串，不抛错——弹窗降级显示）。
 *  files:true（opts）时附带常规文件清单（配置弹窗文件路径选择用） */
export interface BrowseDirsResult {
  path: string;
  parent?: string;
  roots?: Array<{ name: string; path: string }>;
  dirs: Array<{ name: string; path: string }>;
  files?: Array<{ name: string; path: string }>;
  error?: string;
}

/** 浏览本机目录（path 空 = 快捷根；须为绝对路径；files = 附带文件清单） */
export function browseDirs(path: string, opts: { files?: boolean } | undefined, rpc: Rpc): Promise<BrowseDirsResult> {
  return rpc.call('workspace/browse-dirs', {
    ...(path ? { path } : {}),
    ...(opts?.files ? { files: true } : {}),
  });
}

/** workspace/pick-folder 返回形状：path = 选定绝对路径；cancelled = 用户
 *  取消（静默收场）；error = 平台无选择器/启动失败/超时（调用方降级回
 *  browseDirs 应用内浏览） */
export interface PickFolderResult {
  path?: string;
  cancelled?: boolean;
  error?: string;
}

/** workspace/open-local 返回形状：opened = 已交系统默认程序；error =
 *  路径不可达（越界/敏感遮蔽/不存在）或平台命令缺失——错误文案就地显示 */
export interface OpenLocalResult {
  opened?: boolean;
  error?: string;
}

/** 用系统默认程序本地打开文件（预览/编辑卡的「本地打开」动作；ctx 推导
 *  同读面——服务端按挂载工作区/Agent 基准定位相对路径引用） */
export function openLocalFile(path: string, ctx: ReadContext | undefined, rpc: Rpc): Promise<OpenLocalResult> {
  return rpc.call<OpenLocalResult>('workspace/open-local', {
    path,
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
  });
}

/** 本机系统原生文件夹选择（阻塞至用户在系统对话框完成操作——10 分钟长
 *  超时与服务端兜底对齐，另加 5s 网络余量；缺省 60s 会中途掐断） */
export function pickFolder(rpc: Rpc, title?: string): Promise<PickFolderResult> {
  return rpc.call<PickFolderResult>(
    'workspace/pick-folder',
    { ...(title ? { title } : {}) },
    undefined,
    10 * 60_000 + 5_000,
  );
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export interface UploadResult {
  hash?: string;
  storedName?: string;
  originalName?: string;
  size?: number;
  path?: string;
}

/** 上传（multipart；响应指纹回传消费方——chatPresence 路径登记归会话域） */
export async function uploadFile(formData: FormData, agentId?: string): Promise<UploadResult> {
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  return jsonFetch<UploadResult>('/api/upload', { method: 'POST', body: formData });
}
