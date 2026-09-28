// ============================================================
// ac-client-ui-conversation/client/fileApi.ts —— 上传与目录浏览
//（消费门面——M28 P1 owning 迁 ac-client-ui-workspace/client/fileApi.ts）
//
// 会话域行为收口：上传指纹 → chatPresence 路径登记（chat.send 附件
// 行合成 + 同内容去重复用）。browseDirs 纯转发。ChatInput / webui
// 原 webui api/files.ts 门面已退役〔M28 §4.2〕。
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

/** 上传（multipart；响应指纹 → 路径登记，供 chat.send 附件行合成。
 *  会话键透传：agentId 缺席时后端经 singles 推导承载 Agent） */
export async function uploadFile(formData: FormData, agentId?: string, conversationId?: string): Promise<UploadResult> {
  const body = await rawUploadFile(formData, agentId, conversationId);
  // 登记主形态 = absPath（cr-30：[附件] 行/attachments.ref/chips 全链绝对形；
  // 旧后端无 absPath 时降级相对 path——双形态消费端均直通）
  const ref = typeof body.absPath === 'string' ? body.absPath : body.path;
  if (typeof ref === 'string') {
    if (body.hash) chatPresence.uploadPaths.set(body.hash, ref);
    if (body.storedName) chatPresence.uploadPaths.set(body.storedName, ref);
    if (body.originalName) chatPresence.uploadPaths.set(body.originalName, ref);
  }
  return body;
}
