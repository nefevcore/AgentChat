// ============================================================
// ac-client-ui-markdown-render —— markdown 渲染域前端行（node 半）
//
// webui-v3（cr-930）：web 面行 node 半零功能形态——本包 client 半边
//（markdown 渲染共享件）经 wire 装载；深路径消费方（useMarkdown 等）经
// 本行 __deep 面解析（此前宿主 in-bundle 直载——importmap 时代形态）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-markdown-render';

export function apply(_ctx: Context) {
  // 零功能行：装载即图成员（wire +1 行），无宿主面副作用
}
