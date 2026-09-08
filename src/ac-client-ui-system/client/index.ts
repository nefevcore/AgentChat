// ============================================================
// ac-client-ui-system/client/index.ts —— system 域前端行 client 半边
//（M28 P1 §4.1 原案：版本弹窗随域成行）
//
// 贡献面：overlay 席位（id webui-domain-system.version-dialog；order
// 97 = 保持原 AppFrame overlay DOM 序〔文件预览 90 → 建群 95 → 用量
// 96 → 版本 → 设置 100〕）。数据面 systemApi 供跨包消费（sidebar
// 更多菜单的备份/版本动作）。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';

// 版本弹窗宿主（异步：node 环境消费本模块不求值 .vue 视图链）
const VersionHostAsync = defineAsyncComponent(() => import('./VersionHost.vue'));

export {
  fetchVersion, fetchChangelog, runVersionUpdate, backupNow,
  type VersionInfo,
} from './systemApi.ts';

/** system 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const systemClientPlugin = clientPlugin({
  name: 'ac-client-ui-system.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-domain-system.version-dialog',
        component: VersionHostAsync,
        order: 97,
      }),
    );
  },
});

export default systemClientPlugin;
