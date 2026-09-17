// ============================================================
// ac-plugin-core/src/reserved.ts —— 内置注册名保留字表（M23 P1b：F13/G1）
//
// 背景：ctx.tools / ctx.llm / ctx.agents 三注册面重名抛错方向不对称——
// 动态插件先抢注内置名（如 provider 名 openai）会让【出厂行】apply 抛错
// → fiber FAILED，内置注册全体消失。装载时比对活注册面又有时序竞争
// （出厂行可能尚未激活），只能常量表 + 出厂行增改同步 + 一致性测试锁定
// （ac-plugin-registry/tests/reserved-consistency.test.ts：boot 全 TREE
// 对照实际注册面，出厂行新增注册名未更新表 = 测试红灯）。
//
// 维护规约：出厂行新增/改名工具、provider、内置 Agent，必须同步本表。
// <agentId>-<name> 命名规约是软层（模板规约），本表机械拒绝才是硬的。
// ============================================================
import type { PluginManifest } from './manifest.ts';

/**
 * 内置工具名（出厂行注册面；ac-* 行源码逐一核对）。
 * 注意：新增出厂工具行 / 工具改名时同步本表（一致性测试锁定）。
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  // ac-hello
  'hello',
  // ac-fs-tools / ac-fs-search / ac-str-replace-editor
  'read', 'write', 'edit', 'glob', 'grep', 'str_replace_editor',
  // ac-shell-tools（2026-09-16 工具拆分：Windows → pwsh；Unix → bash。
  // 本表按占名超集维护（双名都保留——动态插件在任何平台都不得抢注
  // 内置 shell 工具名；当平台实际注册面见 expectedBuiltinToolNames）
  // / ac-web-tools
  'bash', 'pwsh', 'job', 'web_search', 'browser',
  // ac-math
  'math',
  // ac-collab-tools
  'send_agent', 'send_group', 'list_agents', 'list_groups', 'list_tools',
  'read_agent_info', 'update_agent_profile',
  // ac-dev-tools / ac-restart
  'read_logs', 'reload', 'reload_modules', 'system_restart',
  // ac-session-query（memory_append/memory_rewrite 已移除——记忆面收敛为 fs 工具，2026-09）
  'grep_history', 'read_history',
  // ac-subagent / ac-durable-interaction / ac-timer-tools
  'subagent', 'ask_questions', 'timer',
  // ac-run-code（程序化模式 PTC：code-exec 标签门禁）
  'run_code',
  // ac-goal / ac-todo（任务追踪工具面）
  'goal', 'todo',
  // ac-skill（技能加载工具：按名加载全局/本 Agent 专属技能正文）
  'load_skill',
  // ac-plugin-registry（M23 增 install_plugin）
  'register_plugin', 'unregister_plugin', 'install_plugin',
  // ac-sap-adt（32 个 adt_* 工具：SAP ADT 直连——需 sap-adt 能力标签才可见，
  // 但注册面无条件占名；清单由引擎 assembleAdtTools 锁定，一致性测试对账。
  // 引擎 0.8 起 CRUD 时代 A 组 9 名 + adt_push_object 退位，fs 风格
  // adt_object_write/read/edit/delete 顶替；0.9 起整合批次再收敛：
  // 调试器五件套→adt_debug、ATC list+get→adt_atc_runs、dumps→adt_dumps、
  // transports→adt_transports、adt_read_textelements→adt_object_read {part}）
  'adt_activate', 'adt_atc_runs', 'adt_batch', 'adt_check', 'adt_cochange',
  'adt_create_destination', 'adt_data_preview', 'adt_debug', 'adt_dumps',
  'adt_execute', 'adt_export_objects', 'adt_list_destinations',
  'adt_list_gui_connections', 'adt_local_check', 'adt_lock_info',
  'adt_object_delete', 'adt_object_edit', 'adt_object_read',
  'adt_object_versions', 'adt_object_write', 'adt_permissions', 'adt_ping',
  'adt_release_gate', 'adt_run_atc', 'adt_run_unit_tests', 'adt_search',
  'adt_selfcheck', 'adt_system_info', 'adt_transports', 'adt_unlock_all',
  'adt_version_diff', 'adt_where_used',
];

/**
 * 当平台实际注册的工具面（一致性测试期望值；2026-09-16 工具拆分）。
 * BUILTIN_TOOL_NAMES 按占名超集维护（防动态插件抢注任何平台的内置
 * 名）；实际注册面平台相关——Windows 注册 pwsh（无 bash——单平台
 * 单工具，双名会让 tag:shell 展开出重复工具），Unix 注册 bash。
 */
export const expectedBuiltinToolNames: readonly string[] = [
  ...BUILTIN_TOOL_NAMES.filter((n) => n !== 'bash' && n !== 'pwsh'),
  process.platform === 'win32' ? 'pwsh' : 'bash',
];

/** 常见 LLM provider 名（占名护栏：防动态插件抢注用户常用连接名——
 * openai/deepseek/glm 经 config 注册时与抢注动态插件撞名会让行 FAILED。
 * 种子机制已移除：注册面只来自 config 连接池，此表纯占名保护） */
export const BUILTIN_LLM_PROVIDER_NAMES: readonly string[] = ['openai', 'deepseek', 'glm'];

/**
 * 内置 Agent id（workspace 的 user/admin + ac-agent-presets-builtin 数据行
 * 注入的预设 id）。admin 仅在配置了 model 时物化——表按全集维护（一致性
 * 测试断言实际面 ⊆ 表）。
 */
export const BUILTIN_AGENT_IDS: readonly string[] = [
  'user',
  'admin',
  '__standard__',
  '__dsh_minimal__',
  // ac-sap-adt/preset 子行注入的 ABAP 开发模式
  '__abap_dev__',
  // __programmatic__ 已随开关化退役（2026-09-17 research §十：程序化 =
  // 会话级开关 conv-settings.programmatic + router 收窄，非预设身份）
];

/** 保留字冲突描述（可诊断拒绝的错误载荷） */
interface ReservedNameConflict {
  /** 冲突注册面 */
  face: 'tools' | 'llmProviders' | 'agents';
  /** 冲突的保留名 */
  names: string[];
}

/**
 * 比对 manifest 声明的供给面（provides）与保留字表。
 * 冲突 → 返回冲突描述（装载管道据此 rejected，代码不进进程）；
 * 无冲突 → undefined。agents 面经 provides.agents 声明对账（M23 G1：
 * 三注册面之一的内置 Agent id 抢注会让出厂数据被覆盖——声明即比对）。
 */
export function findReservedConflict(manifest: PluginManifest): ReservedNameConflict | undefined {
  const provides = manifest.provides;
  if (!provides) return undefined;

  const tools = (provides.tools ?? []).filter((n) => BUILTIN_TOOL_NAMES.includes(n));
  if (tools.length > 0) return { face: 'tools', names: tools };

  const providers = (provides.llmProviders ?? []).filter((n) =>
    BUILTIN_LLM_PROVIDER_NAMES.includes(n),
  );
  if (providers.length > 0) return { face: 'llmProviders', names: providers };

  const agents = (provides.agents ?? []).filter((n) => BUILTIN_AGENT_IDS.includes(n));
  if (agents.length > 0) return { face: 'agents', names: agents };

  return undefined;
}

/** 冲突面标签（三面新增时映射强制补全） */
const FACE_LABELS: Record<ReservedNameConflict['face'], string> = {
  tools: '工具',
  llmProviders: 'LLM provider',
  agents: 'Agent',
};

/** 保留字拒绝的错误文案（教插件作者改名的方向） */
export function reservedConflictError(conflict: ReservedNameConflict, manifestName: string): string {
  const faceLabel = FACE_LABELS[conflict.face];
  return (
    `插件 "${manifestName}" 声明提供的${faceLabel}名 [${conflict.names.join(', ')}] 与宿主内置名冲突` +
    `（保留字护栏：动态插件抢注内置名会让出厂行装载失败）。` +
    `请改名（推荐 <agentId>-<name> 命名规约，如 my-agent-${conflict.names[0]}）后重新安装。`
  );
}
