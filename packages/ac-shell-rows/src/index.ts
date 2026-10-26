// ============================================================
// ac-shell-rows —— 壳行导入装配（M8.1 第一批 cr-519 + 第二批 cr-520 + 第三批 cr-521）
//
// 主线「沿用」行从 src/ 导入 preview 壳树（行集清单 R2 沿用行）：
//   id → cordis Plugin 映射（import 行包 namespace）+ 数据根行 options。
// 接缝纪律（裁决簿〈注册表解体〉）：壳内无活注册表——沿用行消费的
// ctx.agents / ctx.agentStore / ctx.credentials 服务由垫片行提供
//（数据根直读，零注册态），主线行代码零改动。
//
// 第二批形态要点（cr-520）：
//   · web-tools/browser = 同一包的两个目录行——同包装配去重（同一
//     Plugin 只 ctx.plugin 一次，行集计数仍按行计）；
//   · fs-tools 行集跨两包（ac-fs-tools + 并入的 ac-file-snapshots）——
//     装配 = 主行 + fileSnapshots 服务行，指纹 path 数组盖全（catalog）。
// 第三批形态（cr-521）：依赖链行落地——jobs/conv-settings 先行（零依赖），
//   shell-tools（inject jobs）/ harness-tools（inject convSettings）随后。
//   行集闭包（catalog requires + rowset 派生并入）保证点名子集依赖完备，
//   boot 装配终检（ACTIVE 断言）兜底倒序瞬态与闭包缺口。
// 第四批形态（cr-522）：durable-interaction / ask-questions / bench 导入
//   ——三行硬依赖（tools / durableInteraction / agentLoop）均已就位，
//   conversation / session 均为组合可选（行未装 = 降级不阻断——主线
//   组合可选惯例），零改动导入。余 collab-tools（inject conversation）/
//   subagent（inject session+注册表面）随 8.2/8.3 落地后续批。
// ============================================================
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Plugin } from '@agentchat/cordis';
import ConsoleExporter from '@agentchat/cordis-logger';
import * as configRow from 'ac-config';
import * as toolsRow from 'ac-tools';
import * as datetimeRow from 'ac-datetime';
import * as personaRow from 'ac-persona';
import * as systemPromptRow from 'ac-system-prompt';
import * as memoryRow from 'ac-memory';
import * as skillRow from 'ac-skill';
import * as goalRow from 'ac-goal';
import * as todoRow from 'ac-todo';
// 第二批：模型编排 3 行
import * as llmRow from 'ac-llm';
import * as llmPoolRow from 'ac-llm-pool';
import * as agentLoopRow from 'ac-agent-loop';
// 第二批：工具面行
import * as fsToolsRow from 'ac-fs-tools';
import * as fileSnapshotsRow from 'ac-file-snapshots';
import * as fsSearchRow from 'ac-fs-search';
import * as sreRow from 'ac-str-replace-editor';
import * as runCodeRow from 'ac-run-code';
import * as mathRow from 'ac-math';
import * as webToolsRow from 'ac-web-tools';
import * as issueToolsRow from 'ac-issue-tools';
import * as sapAdtRow from 'ac-sap-adt';
import * as mcpRow from 'ac-mcp';
// 第三批：依赖链行（jobs 零依赖；shell-tools/harness-tools 依赖之。
// conv-settings 已于 cr-565 改树入宿主——壳侧改由垫片只读直取，
// harness-tools 的 registerKey 面在同源垫片实现）
import * as jobsRow from 'ac-jobs';
import * as shellToolsRow from 'ac-shell-tools';
import * as harnessToolsRow from 'ac-harness-tools';
// 第四批：交互承重与评测（conversation/session 均组合可选——主线行零改动导入）
import * as durableInteractionRow from 'ac-durable-interaction';
import * as askQuestionsRow from 'ac-ask-questions';
import * as benchRow from 'ac-bench';
// 8.2 批：协作工具（inject conversation——preview 壳会话行 M8.2 落地，
// deliver 方言叶就位后零改动导入）
import * as collabToolsRow from 'ac-collab-tools';
import { makeToolsGateRow } from './gate.ts';
import { makeShimsRow } from './shims.ts';

/** 可导入行 id → cordis Plugin（行集目录 shell 树「沿用」行第一+二批） */
export const IMPORTED_ROWS: Record<string, Plugin> = {
  'logger-console': ConsoleExporter as unknown as Plugin,
  'config': configRow as unknown as Plugin,
  'tools': toolsRow as unknown as Plugin,
  'datetime': datetimeRow as unknown as Plugin,
  'persona': personaRow as unknown as Plugin,
  'system-prompt': systemPromptRow as unknown as Plugin,
  'memory': memoryRow as unknown as Plugin,
  'skill': skillRow as unknown as Plugin,
  'goal': goalRow as unknown as Plugin,
  'todo': todoRow as unknown as Plugin,
  // 模型编排
  'llm': llmRow as unknown as Plugin,
  'llm-pool': llmPoolRow as unknown as Plugin,
  'agent-loop': agentLoopRow as unknown as Plugin,
  // 工具面
  'fs-tools': fsToolsRow as unknown as Plugin,
  'fs-search': fsSearchRow as unknown as Plugin,
  'str-replace-editor': sreRow as unknown as Plugin,
  'run-code': runCodeRow as unknown as Plugin,
  'math': mathRow as unknown as Plugin,
  'web-tools': webToolsRow as unknown as Plugin,
  'browser': webToolsRow as unknown as Plugin,
  'issue-tools': issueToolsRow as unknown as Plugin,
  'sap-adt': sapAdtRow as unknown as Plugin,
  'mcp': mcpRow as unknown as Plugin,
  // 第三批：依赖链行
  'jobs': jobsRow as unknown as Plugin,
  'shell-tools': shellToolsRow as unknown as Plugin,
  'harness-tools': harnessToolsRow as unknown as Plugin,
  // 第四批：交互承重与评测
  'durable-interaction': durableInteractionRow as unknown as Plugin,
  'ask-questions': askQuestionsRow as unknown as Plugin,
  'bench': benchRow as unknown as Plugin,
  // 8.2 批：协作工具
  'collab-tools': collabToolsRow as unknown as Plugin,
};

/**
 * 行集内先行装配的伴生服务行（不在行集清单、随主行生效）：
 *   主行 id → { plugin, optionsKey }——optionsKey = 伴生行在 rowOptionsFor
 *   的键（= catalog 内并入件行名）。
 *   · fs-tools → file-snapshots：快照服务（catalog tools 数组声明并入，
 *     行不单列；fs 写路径可选探测消费，缺席不阻断）。
 *   · web-tools/browser 同包去重不在此面（IMPORTED_ROWS 值相等即去重）。
 *
 * tools 授权门（M8.6 cr-527）不在此面——门需要 boot 语境（agentId / 行集
 * 清单 / 影子域），boot.ts 装配行集后直接挂 makeToolsGateRow（无门禁壳
 * 非合法降级，manifest R2 tools 行「授权门」半边的物理载体）。
 */
export const COMPANION_ROWS: Record<string, { plugin: Plugin; optionsKey: string }> = {
  'fs-tools': { plugin: fileSnapshotsRow as unknown as Plugin, optionsKey: 'file-snapshots' },
};

/**
 * 数据根行 options 工厂：行 id → config（构造参数注入——root 显式传，
 * 不走 AGENTCHAT_DATA_ROOT 环境变量缺省，preview 数据根隔离红线）。
 * agentDir = 本壳 agent 域目录（影子 = 物化域；per-agent 域行锚定用——
 * durable-interaction A8 数据化：jsonl 落 agents/<id>/interactions.jsonl，
 * D4 单写者不变式——每实例只写自己域，多壳不共写数据根根）。
 * agentId（cr-589）：pwsh/fs 族的沙箱 workdir 基准 = <dataRoot>/sandbox/
 * <agentId>（主线 workspace Agent 专用空间的 preview 裁形态——壳无
 * workspace 行，缺省回落 process.cwd()〔= 壳进程启动目录〕未声明且
 * 危险；per-agent 专用空间钉住相对路径解析与命令 cwd。缺席 = 不传，
 * 行回落自身缺省）。
 */
export function rowOptionsFor(dataRoot: string, agentDir?: string, agentId?: string): Record<string, unknown> {
  // pwsh/fs 族沙箱基准（mkdir：pwsh 以 cwd spawn——目录须存在）
  const sandboxWorkdir = agentId !== undefined ? path.join(dataRoot, 'sandbox', agentId) : undefined;
  if (sandboxWorkdir !== undefined) fs.mkdirSync(sandboxWorkdir, { recursive: true });
  const sandboxOptions = sandboxWorkdir !== undefined ? { workdir: sandboxWorkdir } : {};
  return {
    config: { root: dataRoot },
    memory: { root: dataRoot },
    skill: { root: dataRoot },
    'file-snapshots': { root: path.join(dataRoot, 'file-snapshots') },
    browser: { dataRoot },
    'durable-interaction': { root: agentDir ?? path.join(dataRoot, 'agents', '_shell') },
    // fs/shell 工具行（cr-589）：相对路径与命令 cwd 锚 per-agent 专用空间
    'fs-tools': sandboxOptions,
    'fs-search': sandboxOptions,
    'str-replace-editor': sandboxOptions,
    'shell-tools': sandboxOptions,
  };
}

export { makeShimsRow };
export { makeToolsGateRow } from './gate.ts';
// 会话查询工具行（cr-544：D10 收敛为 agent 只搜自己——宿主行改树入壳工具面）
export { makeSessionQueryRow, replayConversation } from './session-query.ts';
export type { SessionQueryRowOptions } from './session-query.ts';
// 归档编排行（cr-546：D11 全壳内——主线 ac-archive 编排半边的壳内形态）
export { makeArchiveRow, ArchiveShellService } from './archive.ts';
export type { ArchiveRowOptions } from './archive.ts';
// 插件开发行（cr-553：creator 模板装卸三件套——register 壳内会话级装载 /
// install·uninstall 永久档信封请求宿主受理）
export { makePluginDevRow } from './plugin-dev.ts';
export type { PluginDevRowOptions } from './plugin-dev.ts';
// 安全重启行（cr-629）：restart_shell（中止回队续跑）/ restart_host（信封
// 请求宿主 graceful 重启）
export { makeRestartRow } from './restart.ts';
export type { RestartRowOptions } from './restart.ts';
// 会话自动命名行（cr-672）：首步后 LLM 一句概括 → 信封请求宿主 singles 行落盘
export { makeAutoTitleRow } from './auto-title.ts';
export type { AutoTitleRowOptions } from './auto-title.ts';