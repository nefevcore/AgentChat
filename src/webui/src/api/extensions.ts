// ============================================================
// api/extensions.ts —— UI 扩展清单（Port B：preview 真实 HTTP 面）
//
// extensions host（core/extensions/host.ts）启动 init 与 WS
// ui.extensions.changed 后 sync 的数据源。entry/styles 必须是浏览器
// 可动态 import 的真实 URL（/ui-plugin/<name>/...）。
// ============================================================

import type { UIExtensionDescriptor } from '../shims/@agentchat/protocol.ts';

export function getUiExtensions(): Promise<UIExtensionDescriptor[]> {
  return fetch('/api/ui/extensions')
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json() as Promise<{ extensions: UIExtensionDescriptor[] }>;
    })
    .then((d) => d.extensions ?? []);
}
