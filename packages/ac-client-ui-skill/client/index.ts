// ============================================================
// ac-client-ui-skill/client/index.ts —— skill 域前端行 client 半边
//（M28 P1 §4.1 原案：数据面行——暂无席位贡献；跨包消费走
//  ./skillsApi.ts 深路径直连，本模块仅出 boot graph 插件）
// ============================================================
import { clientPlugin } from 'ac-client-runtime';

/** skill 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const skillClientPlugin = clientPlugin({
  name: 'ac-client-ui-skill.client',
  apply() {
    // 数据面行：无注册面（消费方静态 import skillsApi；可摘除性经
    // RPC 三态契约达成——行/后端不在场 → fetch null → 技能区隐藏）
  },
});

export default skillClientPlugin;
