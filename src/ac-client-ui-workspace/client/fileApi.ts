// ============================================================
// ac-client-ui-workspace/client/fileApi.ts —— 上传与目录浏览
//（M28 P1 域资产归位：自 conversation 随域迁入——T3 数据面跟域走）
//
// browseDirs = workspace/browse-dirs RPC（路径穿透白名单的文件夹
// 选择弹窗）；uploadFile = /api/upload multipart（HTTP 直连，非 RPC）。
// 纯数据面（零 conversation 依赖）：上传指纹的 chatPresence 路径登记
// 是会话域行为，留消费方（conversation 侧薄包装 + webui api/files
// 门面 re-export 维持旧路径）。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';

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
