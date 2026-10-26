// ============================================================
// markdown-render 通道模块（8.5b 第二批；ui-tree.md §2 新划分）
//
// 消息内容渲染策略模块：useMarkdown 606 行 + hljs + KaTeX + 内联语法
// 色板。conversation 是消费者非独占者；第三方可做自己的内容渲染管线
//（自定义阶梯 ③ 换壳——「完全自定义」达标线）。
//
// preview 形态：owning 声明（本包）+ 资产 re-export 主线 renderer
//（零副本）。物理迁移（资产移出 renderer 包）归 cutover；域行消费面
// 迁移（conversation 等改经通道引用）归 8.5c。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';

// 资产面 re-export（消费方迁移期双径可用的过渡锚点——8.5c 收敛后唯一）
export { useMarkdown, parseFrontmatterEntries } from 'ac-client-ui-renderer/client/useMarkdown.ts';
export { default as ScrollableViewport } from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
export { katexVersion } from 'ac-client-ui-renderer/client/markdownMath.ts';

/** markdown-render 通道模块插件（无服务面——纯资产模块，装载即注册渲染策略） */
export const markdownRenderPlugin = clientPlugin({
  name: 'ui-channel-markdown-render',
  apply(_ctx: ClientContext) {
    // 渲染策略资产经 re-export 面消费——本插件无席位注册动作；装载成功
    // 即模块在图（graph 条目 ok 态）。策略激活（色板接 theme 词汇契约）
    // 归 8.5c 域行收敛批。
  },
});

export default markdownRenderPlugin;