// ============================================================
// ac-credentials —— 凭据插件行
//
// 无 inject（零依赖基础服务）。config（{ file?, root? }）经
// loader/bootTree 传入 → 转构造参数。
//
// 纯横切存储（2026-09-05 边界评估建议 #4）：本行只管密码/令牌的
// 加密落盘与引用解析，不感知任何具体能力域——LLM 凭据注入
// （llm/before-chat → pool:<provider> apiKey）已迁 ac-llm-pool
// （./credentials.ts）：LLM 连接域感知凭据服务，方向修正为单向。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { CredentialsService, type CredentialsRowOptions } from './service.ts';

export const name = 'ac-credentials';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'credentials',
  label: '凭据库',
  description: '凭据库（ctx.credentials）：密码/令牌加密落盘与引用解析（如 ADT_<NAME>_PASSWORD）',
  automatic: true,
};

export function apply(ctx: Context, options: CredentialsRowOptions = {}) {
  ctx.plugin(CredentialsService, options);
}

export { CredentialsService, encryptValue, decryptValue } from './service.ts';
export type { CredentialsRowOptions } from './service.ts';
