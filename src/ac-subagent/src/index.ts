// ============================================================
// ac-subagent/src/index.ts —— 子 Agent 薄行
//
// 服务与工具注册在 ./service.ts（SubagentsService：多轮状态机 +
// 落盘 + subagent 工具）。本文件只做装配与出口。
//
// 2026-10 重构（一次性委派 → 持久多轮实体）：
//   · spawn 创建（可带首条任务消息并启动 run）/ send 多轮续聊
//     （async/sync/steer/next-run 四投递语义）/ await 收结果 /
//     list 查询（含历史）/ stop 停推理 / delete 打墓碑。
//   · 会话消息 + 注册表落盘（<root>/subagents/，跨重启续聊）。
//   · run 身份 agent=<subId>（未注册合成 id）：steer 可寻址 +
//     门禁 fail-closed（防递归）+ 扩展行回落缺省（零会话污染保留）。
// requiredTags ['delegation']（任务委派能力——ac-security 行执行）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { SubagentsService, type SubagentRowOptions } from './service.ts';

export const name = 'ac-subagent';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'subagent',
  label: '子 Agent 委派',
  description:
    '子 Agent 多轮会话（SubagentsService + subagent 工具）：spawn/send/await/list/stop/delete；消息与注册表落盘可跨重启续聊；send 四投递语义（sync 等回复 / steer 注入当前步 / next-run 排队）',
};

export const inject = ['tools', 'agentLoop', 'jobs', 'agents'];

export function apply(ctx: Context, options: SubagentRowOptions = {}) {
  ctx.plugin(SubagentsService, options);
}

export { SubagentsService } from './service.ts';
export type { SubagentRowOptions } from './service.ts';
export type {
  SubagentStatus,
  SubagentRunStatus,
  SubagentRunSummary,
  SubagentRecord,
  SubagentInfo,
  SubagentSendMode,
  SubagentSpawnOptions,
  SubagentSendOptions,
  SubagentListOptions,
} from './service.ts';
