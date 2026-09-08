// ============================================================
// ac-client-ui-settings/client/dataFaces.ts —— 兄弟包数据面缺省适配
//
// 设置组件消费的名册/池数据函数住兄弟包（rpc 必传——包间契约纪律）；
// 本模块补 defaultRpc 缺省维持组件调用面零改动（原 webui api/roster
// 的 wireRpc 缺省等价）。HTTP 面（头像上传/删除）无 rpc 参数原样转发。
// ============================================================
import {
  fetchLlmProviders as llmProvidersRpc,
  uploadAvatar as uploadAvatarHttp,
  deleteAvatar as deleteAvatarHttp,
} from 'ac-client-ui-agents/client';
export type { LlmProviderStat } from 'ac-client-ui-agents/client';
import {
  fetchPools as poolsRpc,
  fetchAgentModels as agentModelsRpc,
  poolModelEntries,
  visibleModelNames,
} from 'ac-client-ui-conversation/client/rosterApi.ts';
export type { PoolModelMeta } from 'ac-client-ui-conversation/client/rosterApi.ts';
import { defaultRpc } from './rpcDefault.ts';
import type { RpcClientFace } from 'ac-client-runtime';

type Rpc = Pick<RpcClientFace, 'call'>;

/** Provider 注册面快照（owning = ac-client-ui-agents/client） */
export function fetchLlmProviders(rpc: Rpc = defaultRpc) {
  return llmProvidersRpc(rpc);
}

/** Provider 池（owning = ac-client-ui-conversation/client/rosterApi.ts） */
export function fetchPools(rpc: Rpc = defaultRpc) {
  return poolsRpc(rpc);
}

/** 模型发现（owning = ac-client-ui-conversation/client/rosterApi.ts） */
export function fetchAgentModels(name: string, refresh = false, rpc: Rpc = defaultRpc) {
  return agentModelsRpc(name, refresh, rpc);
}

export { poolModelEntries, visibleModelNames };

// ---- 头像（preview 真实 HTTP multipart 面——owning = ac-client-ui-agents/client） ----
export { uploadAvatarHttp as uploadAvatar, deleteAvatarHttp as deleteAvatar };
