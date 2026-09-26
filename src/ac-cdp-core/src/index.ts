// ============================================================
// ac-cdp-core —— Chrome DevTools Protocol 直连纯库
//
// 【定位】browser 工具执行层的协议实现库（browser-cdp-plan §3）：
// 零 cordis 依赖、无 plugin:true、不出现在 cordis.yml——browser
// owning 仍住 ac-web-tools（ctx.browser Service + browser 工具 +
// tier 门禁），本包只提供协议原语。
// ============================================================
export { CdpClient, CdpCommandError, type CdpClientOptions } from './client.ts';
export {
  launchBrowser, killTree, removeProfile, detectBrowser,
  type LaunchOptions, type LaunchedBrowser, type CdpVersionInfo,
} from './launch.ts';
export {
  CdpPage,
  type CdpPageOptions, type DiagConsoleEntry, type DiagNetEntry,
} from './page.ts';
export {
  extractElements, serializeElements, extractText,
  type RefElement, type ExtractedText,
} from './perceive.ts';
export type {
  CdpWireMessage, CdpEventPayload, CdpRemoteObject,
  CdpSnapshotDoc, CdpSnapshotDocument, CdpFlatNodes, CdpTargetInfo,
} from './protocol.ts';
