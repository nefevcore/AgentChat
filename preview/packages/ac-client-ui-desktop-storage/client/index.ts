// ============================================================
// ac-client-ui-desktop-storage/client —— 桌面壳「存储管理」设置节
//（数据根可配置 P2 前端半边，2026-09-16 裁决）
//
//   仅桌面形态可用：数据从壳层桥（http://127.0.0.1:<p+1..p+4>/desktop-bridge/，
//   取（fetch 失败 = 非桌面形态/桥端口被占 → 本节从设置树移除，优雅降级）。
//   CLI/npm 形态数据根 = 启动目录，本节不适用（无桥即无节）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

const StorageHostAsync = defineAsyncComponent(() => import('./StorageHost.vue'));

/** 桌面存储节（settings:section 贡献；宿主内自探桥，失败自摘） */
export const desktopStorageClientPlugin = clientPlugin({
  name: 'ac-client-ui-desktop-storage.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-desktop-storage.storage',
        component: StorageHostAsync,
        // 挂系统区尾部（全局设置 10 / 模型管理 20 / 搜索 25 …之后）
        order: 90,
        meta: { section: 'storage', label: '存储管理' },
      }),
    );
  },
});

export default desktopStorageClientPlugin;
