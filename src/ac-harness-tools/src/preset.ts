// ============================================================
// ac-harness-tools/src/preset.ts —— harness 委托子代理预设子行
//
// 「harness 委托」预设 Agent（__harness__）：转述协议（D2 一期形态）——
// 收到任务 → 原样作为 task 调 run_harness → 终稿原样回复，不自行扩写。
// 模型走默认池连接（物化期解析）；多一次转述调用的 token 成本换零新
// 机制（直通形态观察使用量再裁）。
//
// 独立子行（框架规则「部分功能依赖独立成子行」，sap-adt 同款形态）：
// 工具行本体只 inject [tools]——最小 boot 不拖预设目录；缺
// ac-agent-presets 行时本子行 PENDING 不激活，目录在位自动补挂。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { AgentPresetDefinition } from 'ac-agent-presets';
import type { ExtensionMeta } from 'ac-extension-core';

export const name = 'ac-harness-tools/preset';

export const inject = ['agentPresets'];

export const extension: ExtensionMeta = {
  name: 'harness-preset',
  label: 'Harness 委托预设',
  description: "harness 委托预设（__harness__）：@harness 或 spawn({name:'harness'}) 一句话委托本地 CLI harness；转述协议（工具行独立装配）",
  automatic: true,
};

const HARNESS_PRESET: AgentPresetDefinition = {
  meta: {
    label: 'Harness 委托',
    description: '本地 CLI harness 委托通道：把收到的任务原样交给 Claude Code/Codex 执行，终稿原样回复（转述协议，单会话无记忆）',
    order: 5, // ABAP 开发模式（__abap_dev__）占 4 后顺延
  },
  agent: {
    id: '__harness__',
    name: 'Harness 委托',
    preset: true,
    // 转述层最小面：harness 委托 + infra（提问确认等会话必需）；不给 fs/shell
    // ——文件与命令操作全部发生在 harness 侧（沙箱两档约束），本 Agent 只转述
    tags: ['harness', 'infra'],
    settings: {
      memory: { enabled: false },
      skill: { enabled: false },
      datetime: { enabled: false },
    },
    system: [
      '# Harness 委托协议',
      '',
      '你是本地 CLI harness 的委托转述层。收到任务时：',
      '1. 把任务原样（一字不改地补全为自足任务书）作为 task 参数调用 run_harness 工具（harness 参数按任务语境选 claude-code 或 codex，未指明时用 claude-code）；',
      '2. 把工具结果的终稿（text 字段）原样回复——不扩写、不总结、不添加自己的分析；',
      '3. 失败形态（未安装/超时/中止）如实转告错误信息，建议用户检查本机安装或放宽 timeout_ms；',
      '4. 不自行用其他工具完成任务——你是转述层，不是执行者。用户显式要求解释或翻译终稿时才可以展开。',
    ].join('\n'),
  },
};

export function apply(ctx: Context) {
  ctx.agentPresets.register(HARNESS_PRESET);
}