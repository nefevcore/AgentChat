// ============================================================
// api/extensions.ts —— UI 扩展清单（Port B：preview 真实 HTTP 面）
//
// extensions host（core/extensions/host.ts）启动 init 与 WS
// ui.extensions.changed 后 sync 的数据源。entry/styles 必须是浏览器
// 可动态 import 的真实 URL（/ui-plugin/<name>/...）。
// 经统一 HTTP 客户端（瞬时故障重试 + 统一错误面）。
// ============================================================

import type { UIExtensionDescriptor } from '../shims/@agentchat/protocol.ts';
import { request } from '../core/api/client';

export function getUiExtensions(): Promise<UIExtensionDescriptor[]> {
  return request<{ extensions?: UIExtensionDescriptor[] }>('/api/ui/extensions').then((d) => d.extensions ?? []);
}
