// ============================================================
// core/api/endpoints/ui.ts —— UI 扩展端点（P5.3）
// ============================================================

import { request } from '../client';
import type { UIExtensionDescriptor } from '@agentchat/protocol';

export function getUiExtensions(): Promise<UIExtensionDescriptor[]> {
  return request<{ extensions: UIExtensionDescriptor[] }>('/api/ui/extensions').then(d => d.extensions ?? []);
}
// getUiSlots（/api/ui/slots）无调用方已删除；slot 数据经 core/extensions/slots.ts 注册表获取
