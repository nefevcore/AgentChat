// ============================================================
// ac-tag-registry —— 能力标签注册中心插件行
//
// P1（tag 词表显式化）：tool/registered 采集 + 档位/base 预注册 +
// owner/未知词分类；数据源 = tags/catalog RPC（ac-web-api 注册）。
// 工具行零改动——事件由 ac-tools 的注册面自动发出。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { TagRegistryService } from './service.ts';

export const name = 'ac-tag-registry';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'tag-registry',
  label: '标签注册中心',
  description: '能力标签目录（ctx.tagRegistry）：工具 requiredTags 自动采集 + 档位/base 预注册 + 分类与断言',
  automatic: true,
};

export function apply(ctx: Context) {
  ctx.plugin(TagRegistryService);
}

export { TagRegistryService } from './service.ts';
export type { TagCatalogEntry, TagCategory } from './service.ts';
export type { TagDeclaration } from './contract.ts';
