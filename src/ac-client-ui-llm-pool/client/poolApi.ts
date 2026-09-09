// ============================================================
// ac-client-ui-llm-pool/client/poolApi.ts —— Provider 池数据面
//（M29 P1-3d 自 settings/api.ts 归域迁入——T3「数据面跟域走」：
// 视图已随行（PoolManager/双 Host），数据面随视图归位）
//
// 形态：rpc 必传（消费组件经 rpc 契约面 + seam 取用）。池【读取】
// （getPools = config/get 白名单域合成）与 schema 引擎留守 settings
//（全局配置域 + 通用 kit）；此处只收【写/探测】面。
// ============================================================

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 池域定向保存（PoolManager 即时落盘——不再等底部「保存配置」全量保存；
 *  api_key 侧信道语义在服务端 config/set：掩码=不动 / ''=删 / 新值=存） */
export async function savePoolDomain(
  domain: 'llmProviders' | 'searchProviders',
  pools: Record<string, any>,
  rpc: Rpc,
): Promise<void> {
  await rpc.call('config/set', { key: domain, value: pools });
}

/** 删除 Provider 连接凭据（pool:<name>）——删除连接条目时必须同步调用，
 *  否则内置种子名的 /models 发现回写会凭残留凭据"复活"已删条目 */
export async function deleteLlmPoolCredential(name: string, rpc: Rpc): Promise<void> {
  await rpc.call('llm/pool-credential', { name, value: '' });
}

/** 免注册连接探测（新建弹窗"填 Key 即读清单"）：base_url + api_key 直调
 * /models（后端本地代理，不经注册面——保存前可用；不写缓存） */
export async function probeLlmModels(
  baseUrl: string,
  apiKey: string,
  rpc: Rpc,
): Promise<{ models: string[] }> {
  const r = await rpc.call<{ models?: string[] }>('llm/probe-models', {
    base_url: baseUrl,
    api_key: apiKey,
  });
  return { models: r.models ?? [] };
}

/**
 * 视觉能力探测（模型能力元数据）：逐模型 1×1 图最小请求三态判定
 * （true/false/null=未知）。免注册路径（base_url+api_key，保存前可用）
 * 与注册路径（provider 名——后端附加 pool:<名> 凭据）双形态。
 */
export async function probeLlmVision(
  input: { baseUrl?: string; apiKey?: string; provider?: string; models: string[] },
  rpc: Rpc,
): Promise<{ results: Record<string, boolean | null> }> {
  const r = await rpc.call<{ results?: Record<string, boolean | null> }>('llm/probe-vision', {
    models: input.models,
    ...(input.baseUrl ? { base_url: input.baseUrl, ...(input.apiKey ? { api_key: input.apiKey } : {}) } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  });
  return { results: r.results ?? {} };
}
