// ============================================================
// ac-client-ui-remote/client —— 「远程设备」设置节（settings:section 贡献）
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

const RemoteDevicesAsync = defineAsyncComponent(() => import('./RemoteDevices.vue'));

export const remoteDevicesClientPlugin = clientPlugin({
  name: 'ac-client-ui-remote.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('settings:section', () =>
      ctx.slots.register('settings:section', {
        id: 'webui-remote.devices',
        component: RemoteDevicesAsync,
        order: 95, // 存储管理 90 之后（同为低频管理面）
        meta: { section: 'remote', label: '远程设备' },
      }),
    );
  },
});

export default remoteDevicesClientPlugin;