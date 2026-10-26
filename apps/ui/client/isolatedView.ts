// ============================================================
// isolatedView.ts —— 隔离档视角承载容器（B3 批，design-plugin-
// client-channel.md §1 隔离档粒度：容器整块承载——宿主把 iframe 容器
// 作为该视角的渲染组件挂上选举席，隔离组件在 iframe 内自绘）。
//
// 生命周期：承载 div 卸载时 Vue 会连带移除其子树——iframe 已被
// mountTo 移入其中，故组件 unmount 必须先 unmountFrom 把 iframe 移
// 回 body 寄存（插件卸载语义归 handle.cleanup，承载让位不销毁 iframe）。
// ============================================================
import { defineComponent, h, onUnmounted } from 'vue';
import type { IsolatedExtensionHandle } from '../src/isolated.ts';

/**
 * 隔离档视角承载容器组件（data-ui-isolated-view 标记——与 iframe 的
 * data-ui-isolated 同词根可辨）。volatile 选区随选举挂卸：卸载即回
 * 隐藏态，重选重挂（mountTo 幂等）。
 */
export function isolatedViewComponent(handle: IsolatedExtensionHandle) {
  const pluginName = handle.descriptor.name;
  return defineComponent({
    name: 'IsolatedViewHost',
    setup() {
      onUnmounted(() => handle.unmountFrom());
      return () => h('div', {
        class: 'ui-isolated-view',
        'data-ui-isolated-view': pluginName,
        style: { width: '100%', height: '100%', overflow: 'hidden', display: 'block' },
        ref: (n: unknown) => {
          if (n) handle.mountTo(n as HTMLElement);
        },
      });
    },
  });
}