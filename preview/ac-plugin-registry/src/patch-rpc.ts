// ============================================================
// ac-plugin-registry/src/patch-rpc.ts —— 行偏好急救通道子行
//
// plugin/patch-list · plugin/patch-set 的注册行（2026-08-30 从 ac-web-api
// 迁出，三连事故落地）：
//   · 事故形态：停用 ac-agent-loop 级联 agentLoop→router→conversation→
//     ac-web-api 全链下线，行偏好 RPC 原住 web-api——急救通道跟着阵亡，
//     UI 无法自救（恢复开关本身就在死掉的面里）；
//   · 本行仅注入 webServer + pluginRegistry（不在 agent-loop 级联闭包内），
//     级联后仍存活；经热通道 setPatch(id, false) 可反向恢复整棵树；
//   · 按框架规则「部分功能依赖独立成子插件行」拆行——不把整个安装域
//     （install/staging/audit）硬绑到传输层；
//   · 残余盲区：停用 ac-tools 会带走 plugin-registry 本体（本行注入
//     pluginRegistry 随之无提供方）——彼时的手工恢复 = 编辑数据根下
//     cordis.patch.yml 删条目 + 重启（文件人可读可急救，M23 A2 设计兜底）。
// 装配：cordis.yml 本地路径行（'./ac-plugin-registry/src/patch-rpc.ts'），
// 与 ac-app TREE 的 patch-rpc 行集保持一致。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-plugin-registry/patch-rpc';

export const inject = ['webServer', 'pluginRegistry'];

export function apply(ctx: Context) {
  ctx.webServer.registerRpc('plugin/patch-list', () => ctx.pluginRegistry.listPatches());
  ctx.webServer.registerRpc('plugin/patch-set', async (params) => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id) throw new Error('参数 id 缺失（yml 裸行 id）');
    return ctx.pluginRegistry.setPatch(id, p.disabled !== false);
  });
}
