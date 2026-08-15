// ============================================================
// core/api/endpoints/ui.ts —— UI 扩展端点（P5.3）
// ============================================================

import { request } from '../client';
import type { UIExtensionDescriptor, UISlotInfo } from '@shared/types';

export function getUiExtensions(): Promise<UIExtensionDescriptor[]> {
  return request<{ extensions: UIExtensionDescriptor[] }>('/api/ui/extensions').then(d => d.extensions ?? []);
}

export function getUiSlots(): Promise<UISlotInfo[]> {
  return request<{ slots: UISlotInfo[] }>('/api/ui/slots').then(d => d.slots ?? []);
}
