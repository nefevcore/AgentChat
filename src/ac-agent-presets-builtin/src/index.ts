// ============================================================
// ac-agent-presets-builtin —— 内置预设模式数据行（标准/极简/创造）
//
// 纯数据薄行：向 ctx.agentPresets 目录注册三个内置模式（标准模式
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
    //   · （run_code 可见性授权词 = infra（非"infra 族工具"）——
    //     2026-09-17 优化裁决：tc-* 回归纯模式词，预设/Agent 无需预配；
    //     「程序化」由会话工具调用模式下拉按需选择，等同临时程序化档）
    // 标准模式声明面 "读写/Shell/搜索/提问/子任务委派"照此显式授权。
    // 不含 collab（协作族）与 history（会话回放族，2026-09-17 自 infra
    // 拆出）——单会话通用对话不需要跨 Agent 协作与历史回放（2026-09-17
    // 精简裁决；# 会话引用经指引走文件工具分析）
    tags: ['fs', 'infra', 'shell', 'web', 'delegation'],
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

/** 创造模式：插件开发面（fs/shell/web/dev + admin 插件装卸闭环） */
const CREATOR: AgentPresetDefinition = {
  meta: {
    label: '创造模式',
    description: 'AgentChat 插件开发：读写/Shell/搜索/子任务委派 + dev 调试面 + register/install/unregister_plugin 装卸闭环，系统提示词内置开发指南，用户技能照常可用，单会话无长期记忆不归档',
    order: 3,
  },
  agent: {
    id: '__creator__',
    name: '创造模式',
    preset: true,
    // 与标准模式同构的开发族（fs 文件 / infra 会话基础设施——run_code
    // 可见性授权词挂 infra / shell 命令 / web 搜索 / delegation 委派）+
    // 插件开发两面：
    //   · dev（read_logs/reload——开发调试面：装完试错、读日志定位）
    //   · admin（register_plugin/install_plugin/unregister_plugin——动态
    //     插件装卸三件套；免审 = 仅 admin Agent 自开发自安装，M15 对账后
    //     admin 边界）。注意 collab 协作族与 history 回放族与标准模式口径
    //     一致（不载——单会话开发流不需要）。
    tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'dev', 'admin'],
    // 技能面保留（与标准/极简差异化）：用户自己的技能（全局/专属）照常
    // 加载——插件开发引导不依赖技能注入（框架开发技能 agentchat-plugin-dev
    // 等住 .dsh/skills 开发侧目录，不进用户技能面），已内置下方 system
    // 提示词；两者互补不冲突。memory/datetime 软停用同族（会话即隔离，
    // 不跨会话积累）。
    settings: {
      memory: { enabled: false },
      datetime: { enabled: false },
    },
    system: `# AgentChat 插件开发指南

你可以为本系统开发插件（运行时自开发自安装的动态插件），核心工作流：

## 1. 开发
- 插件目录建在你的沙箱 files/<你的id>/<插件名>/ 下，含 manifest.json + 入口文件（如 index.ts，TS 直跑无需构建）。
- manifest 必填项：name（规约 <你的id>-<名>）、version、entry、contracts（宿主契约范围，如 "^1"）、permissions、provides。
- permissions 词表：fs / network / process / shell / ui（fs/network 缺省授予；process/shell/ui 需显式声明）。声明全集 = 免审授权面。
- provides 形状：{ tools?, llmProviders?, events?, ui?, agents? }——可注册工具/provider/Agent、订阅事件。
- 内置注册名是保留字（工具名/provider 名/Agent id 三面常量表），撞名 = 可诊断拒绝；命名带自己的 id 前缀可避开。

## 2. 工具开发规约
- 工具默认私有：requiredTags: ["agent:<你的id>"] 注入 owner 标签——只有你能调；共享 = 他人显式在自己的 tags 加该标签。
- 共享输出一律用 <tool-output plugin="<你的id>">...</tool-output> 包裹（防注入对冲）；description 禁指令式措辞（它是他人模型可见的常驻 prompt 面）。
- 事件行铁律：不 provide agentLoop、不 emit loop/* 事件。

## 3. 试跑与定型
- register_plugin：临时试跑（会话级装载，重启即失）——开发迭代用。
- install_plugin：定型驻留（免审自动安装，重启自动恢复）。
- unregister_plugin：卸载/回滚（removeFromLibrary=true 时永久卸载进 .backup）。
- 迭代语义：同 name+version 且内容一致 → 幂等；有任何改动必须先 bump manifest version 再重装。无热重载。
- 每轮对话只处理首个装载类中断（一轮只能装一件）；装载结果以回执进入当前会话并自动触发下一轮，失败信息含修复方向。

## 4. 防线（了解即可）
- 全部装卸进 plugins/audit.jsonl 审计；连续装载失败 3 次熔断（复位 = bump version 重装）；已装目录被改动 → 拒载（hash 复验）。

开发时先用 read/grep 查看现有插件与模板结构（templates/tool-row 等），照抄骨架起步。`,
  },
};

export const name = 'ac-agent-presets-builtin';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'preset-builtin',
  label: '内置预设模式',
  description: '内置模式数据：标准模式（__standard__）+ 极简模式（__dsh_minimal__）+ 创造模式（__creator__，插件开发面）注入预设目录（程序化模式随 ac-run-code 走——preset.ts 子行）',
  automatic: true,
};

export const inject = ['agentPresets']; // 物化必需 agents 经目录服务自身 inject 传递保证

export function apply(ctx: Context) {
  ctx.agentPresets.register(STANDARD);
  ctx.agentPresets.register(DSH_MINIMAL);
  ctx.agentPresets.register(CREATOR);
}
