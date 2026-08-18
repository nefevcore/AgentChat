// ============================================================
// agentchat-plugin-market-test —— 市场链路冒烟插件
//
// 作用只有一个：在宿主进程控制台打印标记消息，肉眼验证
//   · 安装（宿主内 install 热加载 / 重启扫描装载）→ "[market-test] ✓ 已激活"
//   · 卸载（library uninstall 热卸载）→ "[market-test] ✕ 已卸载"
//
// 无依赖、无权限申请、不注册任何工具/钩子——纯冒烟。
// 入口用 .mjs：发布到市场的插件由宿主 Node ESM 动态 import，
// 不能依赖 tsx 运行态（.ts 仅仓库 dev 场景可加载）。
// ============================================================

export const name = 'agentchat-plugin-market-test';

export function apply(ctx) {
  console.log('[market-test] ✓ 已激活（apply 已运行，manifest.contracts=^1 门禁通过）');
  try {
    ctx?.logger?.('market-test')?.info('ctx.logger 可用 —— 市场安装 → 装载链路 OK');
  } catch {
    // logger 形态异常不影响冒烟结论
  }

  // cordis 4：effect 返回的函数在 fiber 回收（热卸载）时执行
  ctx?.effect?.(() => () => {
    console.log('[market-test] ✕ 已卸载（effect 清理函数已运行）');
  });
}
