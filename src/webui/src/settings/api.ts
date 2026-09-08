// ============================================================
// settings/api.ts —— 类型化 API 层门面（re-export）
// owning = ac-client-ui-settings/client/api.ts（M27.2-2 出包之六）。
// 全函数签名 rpc 缺省 wireRpc 维持不变（消费面 port-b.test/
// portb-e2e 动态导入零改动）。
// ============================================================
export * from 'ac-client-ui-settings/client/api.ts';
