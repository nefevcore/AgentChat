// ============================================================
// ac-webui-extensions —— UI 扩展 slot 注册表行（ctx.uiExtensions）
//
// 行 apply = 宿主开口：声明内置六 slot（src 前端 registry 全集）。
// 宿主表面行可追加 declareSlot 扩白名单；插件行 register 填空。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { BUILTIN_SLOTS, UiExtensionsService } from './service.ts';

export const name = 'ac-webui-extensions';

export function apply(ctx: Context) {
  // 直构（非 ctx.plugin）：行 apply 闭包要访问本行自身提供的服务
  // （自依赖 inject 禁止——ac-web-tools BrowserService 同款形态）
  const svc = new UiExtensionsService(ctx);
  // 宿主先开口：内置 slot 白名单（注册即归属——本行摘除即白名单清空）
  for (const slot of BUILTIN_SLOTS) {
    svc.declareSlot(slot);
  }
}

export { BUILTIN_SLOTS, INSTALL_TIMEOUT_MS, UiExtensionsService } from './service.ts';
export type { UiSlotDef, UiExtensionDef, UiExtensionEntry } from './service.ts';
