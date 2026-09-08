// ============================================================
// ac-client-ui-conversation/client/fileApi.ts —— 上传与目录浏览
//（消费门面——M28 P1 owning 迁 ac-client-ui-workspace/client/fileApi.ts）
//
// 会话域行为收口：上传指纹 → chatPresence 路径登记（chat.send 附件
// 行合成 + 同内容去重复用）。browseDirs 纯转发。ChatInput / webui
// api/files.ts 消费面零改动（旧路径维持）。
// ============================================================
import {
  browseDirs as rawBrowseDirs,
  uploadFile as rawUploadFile,
  type BrowseDirsResult,
  type UploadResult,
} from 'ac-client-ui-workspace/client/fileApi.ts';
import { chatPresence } from './chatOps.ts';

export type { BrowseDirsResult, UploadResult };

type Rpc = Parameters<typeof rawBrowseDirs>[2];

/** 浏览本机目录（path 空 = 快捷根；须为绝对路径；files = 附带文件清单） */
export function browseDirs(path: string, opts: { files?: boolean } | undefined, rpc: Rpc): Promise<BrowseDirsResult> {
  return rawBrowseDirs(path, opts, rpc);
}

/** 上传（multipart；响应指纹 → 路径登记，供 chat.send 附件行合成） */
export async function uploadFile(formData: FormData, agentId?: string): Promise<UploadResult> {
  const body = await rawUploadFile(formData, agentId);
  if (typeof body.path === 'string') {
    if (body.hash) chatPresence.uploadPaths.set(body.hash, body.path);
    if (body.storedName) chatPresence.uploadPaths.set(body.storedName, body.path);
    if (body.originalName) chatPresence.uploadPaths.set(body.originalName, body.path);
  }
  return body;
}
