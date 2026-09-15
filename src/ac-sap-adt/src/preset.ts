// ============================================================
// ac-sap-adt/src/preset.ts —— ABAP 开发模式预设子行
//
// 「ABAP开发模式」预设 Agent（__abap_dev__）的注入行：向预设模式目录
// （ctx.agentPresets，ac-agent-presets）注册一个面向 SAP ABAP 开发的
// 会话模式——与标准模式同构：**只写 tags，不写 tools 白名单**。工具面
// = tags 解锁（sap-adt → 32 个 adt_*；shell → bash；web → web_search）
// + 无门禁默认面（read/write/协作/任务追踪等）——门禁轴
// （requiredTags × tags）单一事实源，引擎目录增删自动跟随。
//
// 独立子行的理由（框架规则「部分功能依赖独立成子插件行」）：sap-adt
// 工具行本体只 inject ['tools']——工具面不依赖预设目录即可用（最小
// boot 测试、非预设宿主不受拖累）。预设是【可选能力】：缺 ac-agent-presets
// 行时本子行 PENDING 不激活（cordis 依赖等待），目录在位自动补挂——
// 与 patch-rpc 子行同款形态（同包内按依赖面拆行）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { AgentPresetDefinition } from 'ac-agent-presets';

export const name = 'ac-sap-adt/preset';

export const inject = ['agentPresets'];

// ── 扩展自述（注册制目录：ac-web-api 扫 cordis registry 读取） ──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'sap-adt-preset',
  label: 'ABAP 开发模式预设',
  description: 'ABAP开发模式（__abap_dev__）注入预设目录：tags 即工具面（sap-adt/shell/web），与标准模式同构；与 sap-adt 工具行独立装配',
  automatic: true,
};

/** ABAP 开发模式：SAP ADT 工具面 + Shell/搜索（单会话无记忆） */
const ABAP_DEV_PRESET: AgentPresetDefinition = {
  meta: {
    label: 'ABAP开发模式',
    description: 'SAP ABAP 开发面：adt_* 工具（搜索/读写/激活/单测/ATC/传输/调试）+ Shell 与本地文件，单会话无记忆不归档',
    order: 3,
  },
  agent: {
    id: '__abap_dev__',
    name: 'ABAP开发模式',
    preset: true,
    // 工具面 = tags 解锁（门禁轴单一事实源）：sap-adt（adt_* 全家）+
    // shell（bash）+ web（web_search）；无门禁工具（read/write/协作等）
    // 走默认面——与标准模式同构，不写 tools 白名单
    tags: ['sap-adt', 'shell', 'web'],
    settings: {
      memory: { enabled: false },
      skill: { enabled: false },
      datetime: { enabled: false },
    },
  },
};

export function apply(ctx: Context) {
  ctx.agentPresets.register(ABAP_DEV_PRESET);
}
