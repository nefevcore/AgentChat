// ============================================================
// ac-agent-presets-builtin —— 内置预设模式数据行（标准/极简）
//
// 纯数据薄行：向 ctx.agentPresets 目录注册两个内置模式（标准模式
// __standard__ / 极简模式 __dsh_minimal__，src presets/standard +
// presets/dsh-minimal 的形状迁移）。物化/模型解析/热更新语义全部由
// ac-agent-presets 目录服务承担——本行零逻辑，只定义「模式长什么样」。
//
// 第三方插件注入自有模式 = 同一注册面（ctx.agentPresets.register），
// 与本行零特殊化；摘掉本行 = 空目录（宿主仍可运行）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-presets';
import type { AgentPresetDefinition } from 'ac-agent-presets';

/** 标准模式：无人物设定的通用对话面 */
const STANDARD: AgentPresetDefinition = {
  meta: {
    label: '标准模式',
    description: '无人物设定的通用对话：读写/Shell/搜索/提问/子任务委派，单会话无记忆不归档',
    default: true,
    order: 1,
  },
  agent: {
    id: '__standard__',
    name: '标准模式',
    preset: true,
    // 工具门禁随行标签——全量标签化（2026-09-16）后 tags 即工具面：
    //   · fs 文件族 / infra 会话基础设施
    //   · shell 命令执行（A3 起，dev→shell 拆分）
    //   · web 网络（纯搜索，无权限面）；delegation 任务委派（2026-12 授权）
    //   · code-exec 程序化执行（2026-09-17 开关化补授——实测 3a8ea4f7 坑：
    //     默认预设无此标签时「程序化」勾选对默认路径永不生效，开关惰性
    //     静默回落标准形态。授权与形态正交：开关关 = run_code 与传统工具
    //     并存〔投影注入带选择策略〕；开关开 = LLM 面收窄为 run_code 单入口）
    // 标准模式声明面 "读写/Shell/搜索/提问/子任务委派"照此显式授权。
    // 不含 collab（协作族）与 history（会话回放族，2026-09-17 自 infra
    // 拆出）——单会话通用对话不需要跨 Agent 协作与历史回放（2026-09-17
    // 精简裁决；# 会话引用经指引走文件工具分析）
    tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'code-exec'],
    // src allowlist（persona/system-prompt/session/security/usage）不含
    // memory/skill/datetime——软停用对齐（无记忆语义）
    settings: {
      memory: { enabled: false },
      skill: { enabled: false },
      datetime: { enabled: false },
    },
  },
};

/** 极简模式：DSH 同款最小工具面（上下文成本最低） */
const DSH_MINIMAL: AgentPresetDefinition = {
  meta: {
    label: '极简模式',
    description: '仅 str_replace_editor / bash 两件工具：单工具编辑器 + 跑命令，上下文成本最低',
    order: 2,
  },
  agent: {
    id: '__dsh_minimal__',
    name: '极简模式',
    preset: true,
    // 全量标签化（2026-09-16）：极简模式声明 fs 文件族 + shell 命令族
    // + infra 基础设施（ask_questions 等会话必需）——fs_minimal 是
    // str_replace_editor（极简插件包）的独立门禁词，与本族无关
    tags: ['fs', 'shell', 'infra', 'fs_minimal'],
    // DSH 同款最小工具面：str_replace_editor（四命令合一）+ 命令工具
    tools: { include: ['str_replace_editor', 'tag:shell'] },
    settings: {
      memory: { enabled: false },
      skill: { enabled: false },
      datetime: { enabled: false },
      // src dsh-minimal 的 hooks 不含 build-system-prompt——零框架块，
      // 上下文成本最低（faithful）
      'system-prompt': { enabled: false },
    },
  },
};

export const name = 'ac-agent-presets-builtin';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'preset-builtin',
  label: '内置预设模式',
  description: '内置模式数据：标准模式（__standard__）+ 极简模式（__dsh_minimal__）注入预设目录（程序化模式随 ac-run-code 走——preset.ts 子行）',
  automatic: true,
};

export const inject = ['agentPresets']; // 物化必需 agents 经目录服务自身 inject 传递保证

export function apply(ctx: Context) {
  ctx.agentPresets.register(STANDARD);
  ctx.agentPresets.register(DSH_MINIMAL);
}
