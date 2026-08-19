// ============================================================
// tests/market-e2e-fixture.ts —— 冒烟插件内联夹具
//
// 原 examples/agentchat-plugin-market-test 的三件套（manifest + index.mjs
// + README）内联为字符串：market-e2e 不再依赖仓库外目录（examples 删除后
// 测试自包含）。插件行为不变——激活/卸载打印标记消息，验证
// install → load → uninstall 全链路。
// ============================================================
import type { PluginManifest } from '@agentchat/agent-config';
import type { TarEntry } from './market-helpers';

/** 与原 examples manifest.json 同体（含 contracts ^1 门禁声明） */
export const SMOKE_MANIFEST: PluginManifest = {
  name: 'agentchat-plugin-market-test',
  version: '1.0.0',
  entry: 'index.mjs',
  inject: [],
  contracts: '^1',
  permissions: [],
  description: '市场链路冒烟插件：激活/热卸载时向宿主控制台打印标记消息，用于验证 install → load → uninstall 全链路',
  author: 'market-test',
};

/** 与原 examples/index.mjs 同体：apply 打印激活标记；effect 清理打印卸载标记 */
export const SMOKE_ENTRY = `// 市场链路冒烟插件（内联夹具）
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
`;

/** GitHub tarball 条目（顶层目录名同真实发布形态） */
export function smokeTarEntries(): TarEntry[] {
  const top = 'agentchat-plugin-market-test-v1.0.0';
  return [
    { name: `${top}/`, type: 'dir' as const },
    { name: `${top}/manifest.json`, content: Buffer.from(JSON.stringify(SMOKE_MANIFEST, null, 2)) },
    { name: `${top}/index.mjs`, content: Buffer.from(SMOKE_ENTRY) },
    { name: `${top}/README.md`, content: Buffer.from('# agentchat-plugin-market-test（内联夹具）\n') },
  ];
}
