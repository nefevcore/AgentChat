// ============================================================
// ac-client-ui-search-pool/client/searchPoolApi.ts —— 搜索池
// 数据面写侧（2026-11 自 ui-llm-pool poolApi 拆分迁入——原
// savePoolDomain 联合域收窄：模型池写面留 ui-llm-pool，本包只管
// searchProviders 域，避免 domain→domain 小件引用）
//
// 形态：rpc 必传（消费组件经 rpc 契约面 + seam 取用）。池【读取】
// 与 schema 引擎留守 settings（全局配置域 + 通用 kit）；此处只收
// 【写】面。
// ============================================================

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 搜索池定向保存（PoolManager 即时落盘——不再等底部「保存配置」全量保存；
 *  api_key 侧信道语义在服务端 config/set：掩码=不动 / ''=删 / 新值=存） */
export async function saveSearchPoolDomain(
  pools: Record<string, any>,
  rpc: Rpc,
): Promise<void> {
  await rpc.call('config/set', { key: 'searchProviders', value: pools });
}
