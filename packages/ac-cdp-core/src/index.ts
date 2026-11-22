// ============================================================
// ac-cdp-core —— Chrome DevTools Protocol 直连纯库
//
// 【定位】browser 工具执行层的协议实现库（browser-cdp-plan §3）：
// 零 cordis 依赖、无 plugin:true、不出现在 cordis.yml——browser
// owning 仍住 ac-web-tools（ctx.browser Service + browser 工具 +
// tier 门禁），本包只提供协议原语。
// ============================================================
export { CdpClient } from './client.ts';
export { launchBrowser, killTree, clearProfile, removeProfile, type LaunchedBrowser } from './launch.ts';
export { CdpPage } from './page.ts';
export { extractElements, serializeElements, extractText } from './perceive.ts';
export type { CdpTargetInfo } from './protocol.ts';
