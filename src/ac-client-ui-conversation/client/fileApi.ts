// ============================================================
// ac-client-ui-conversation/client/fileApi.ts —— 上传与目录浏览
//（M27.2-2 conversation 视图半边随件迁：ChatInput 附件/快捷输入）
//
// browseDirs = workspace/browse-dirs RPC（路径穿透白名单的文件夹
// 选择弹窗）；uploadFile = /api/upload multipart（HTTP 直连，非 RPC）
// ——响应指纹 → 路径登记进 chatPresence（本包 chatOps 单例），供
// chat.send 附件行合成。webui api/files.ts 薄包装维持旧路径。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import { chatPresence } from './chatOps.ts';

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

interface UploadResult {
  hash?: string;
  storedName?: string;
  originalName?: string;
  size?: number;
  path?: string;
}

/** 上传（multipart；响应指纹 → 路径登记，供 chat.send 附件行合成） */
export async function uploadFile(formData: FormData, agentId?: string): Promise<UploadResult> {
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  const body = await jsonFetch<UploadResult>('/api/upload', { method: 'POST', body: formData });
  if (typeof body.path === 'string') {
    if (body.hash) chatPresence.uploadPaths.set(body.hash, body.path);
    if (body.storedName) chatPresence.uploadPaths.set(body.storedName, body.path);
    if (body.originalName) chatPresence.uploadPaths.set(body.originalName, body.path);
  }
  return body;
}
