// ============================================================
// ac-tag-registry —— 能力标签注册中心插件行
//
// P1（tag 词表显式化）：defs 现算目录 + 档位/模式词预注册；数据源 =
// tags/catalog RPC（ac-web-api 注册）。工具行零改动——目录按 ac-tools
// 注册表（defs + 注册方行名）现算，不依赖事件时序。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { TagRegistryService } from './service.ts';

export const name = 'ac-tag-registry';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'tag-registry',
  label: '标签注册中心',
  description: '能力标签目录（ctx.tagRegistry）：工具 requiredTags 现算采集 + 档位/模式词预注册 + 抉择组元数据与启动断言',
  automatic: true,
};

export function apply(ctx: Context) {
  ctx.plugin(TagRegistryService);
}

export { TagRegistryService } from './service.ts';
export type { TagCatalogEntry, TagCategory } from './service.ts';
export type { TagDeclaration } from './contract.ts';
