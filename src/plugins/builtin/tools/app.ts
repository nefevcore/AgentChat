// ============================================================
// src/plugins/builtin/tools/app.ts —— 应用控制工具（system_restart/reload/ask_questions）
//
// 迁移自旧 mod 的 tools/{system_restart,reload,ask_user}，按领域聚合。
//
// 适配新架构：
//   · ToolInterrupt（语义化中断）来自 src/core/interrupt（新架构已有，签名一致）
//   · isSupervised → 读环境变量 AGENTCHAT_SUPERVISED（旧 @utils/supervisor）
//   · ask_questions 交互桥经 PluginServices.interaction 注入（替代旧 getAppState().interactionBridge）
//
// 依赖方向：仅依赖 src/core + @agents/config + @core/types + define-tool + 本层 types。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { defineTool } from '../../define-tool';
import { ToolInterrupt } from '@core/interrupt';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import type { PluginServices } from '../../types';
import { isSupervised } from '@utils/supervisor';

/**
 * 进程启动时间戳——reload 检测插件源码变更的基准。
 * reload 只重载配置（performReload 重读 config.json 重新注册），
 * 插件源码（src/plugins/）在进程启动时一次性 import 进 pluginRegistry，
 * tsx ESM 模块缓存使旧代码驻留，reload 无法加载代码改动。
 */
const PROCESS_START_TS = Date.now();

/** 扫描 src/plugins 下的源码文件，返回 mtime 晚于进程启动的文件（= 代码改动，reload 无法加载） */
export function findChangedPluginSources(rootDir: string = process.cwd()): string[] {
  const pluginsRoot = path.resolve(rootDir, 'src', 'plugins');
  const changed: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name)) {
        try {
          if (fs.statSync(full).mtimeMs > PROCESS_START_TS) {
            changed.push(path.relative(rootDir, full));
          }
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(pluginsRoot);
  return changed;
}

/** system_restart 工具：请求后端完全重启（照搬旧：语义化中断） */
export function makeSystemRestartTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'system_restart', label: '重启后端', requires: ['admin'],
    description: '请求完整后端重启。Supervisor 模式下进程以退出码 42 退出并由父进程拉起（WebSocket 约 2s 自动重连）。危险：会中断所有运行中的任务。仅在确实需要重启时使用，如修改了 src/ 下核心代码后。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '重启原因（可选，记入日志）。' } },
    },
    extractLabel: () => '重启后端',
    execute: async (args) => {
      if (!isSupervised()) {
        return '[system_restart] 拒绝：当前非 Supervisor 模式，重启会直接中断进程且无法自动拉起。请通过 Supervisor 启动（AGENTCHAT_SUPERVISED=1）。';
      }
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'tool-system-restart';
      // 语义化中断：由 loop 收尾后调用 requestRestart（L5 装配）
      throw new ToolInterrupt({ type: 'restart-requested', reason });
    },
  });
}

/** reload 工具：统一热加载（照搬旧：语义化中断） */
export function makeReloadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'reload', label: '热加载', requires: ['dev'],
    description: '热重载配置。scope=self 重读本 Agent 配置并重新注册（config.json/工具开关改动立即生效）；scope=global 重读全部 Agent 配置；scope=all 两者都做（默认）。注意：仅重载配置，不重载插件源码——修改 src/plugins/ 的工具/钩子代码后必须用 system_restart 进程级重启才生效（检测到源码变更会提示）。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['self', 'global', 'all'], description: '重载范围（默认 all；仅配置生效，不重载插件源码）' },
      },
    },
    extractLabel: (args) => `⟳ ${args.scope || 'all'}`,
    execute: async (args, stream) => {
      const scope = (args.scope || 'all') as 'self' | 'global' | 'all';
      // 检测插件源码变更：reload 只重载配置，无法加载代码改动。
      // 明确提示而非静默不生效（Agent 改完 src/plugins/ 代码后调 reload 会看到此警告）。
      if (scope === 'global' || scope === 'all') {
        const changed = findChangedPluginSources();
        if (changed.length > 0) {
          const shown = changed.slice(0, 3).map(f => path.basename(f));
          stream?.onChunk?.(
            `⚠️ 检测到 ${changed.length} 个插件源码文件在进程启动后有改动（${shown.join('、')}${changed.length > 3 ? '…' : ''}）：` +
            `reload 只重载配置、无法加载代码改动，请改用 system_restart 重启后端后生效。本次仍会重载配置。\n`
          );
        }
      }
      // 语义化中断：由 loop 收尾后调用 performReload（L5 装配）
      throw new ToolInterrupt({ type: 'reload-requested', scope });
    },
  });
}

/** ask_questions 工具：向用户批量提问等待决策（经 PluginServices.interaction） */
export function makeAskQuestionsTool(config: AgentConfig, services: PluginServices): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'ask_questions', label: '询问用户', requires: ['agent'],
    description: '向用户提出一组问题（每题带选项），等待用户选择后继续（异步交互）。适用于需要用户决策/确认的场景：二选一、确认执行某操作、选择方向等。用户默认 120 秒内响应，超时返回"用户未响应"。调用后会暂停当前推理直到用户选择，请确保问题清晰、选项明确。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题' },
              options: { type: 'array', items: { type: 'string' }, description: '选项（2-5 个）' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表：一次提供多个问题，前端逐题回答（避免来回调用工具）。用户可输入自定义答案',
        },
        timeout_ms: { type: 'number', description: '等待超时（毫秒，默认 120000）' },
      },
      required: ['questions'],
    },
    extractLabel: (args) => `问: ${String(args.questions?.[0]?.question || '').slice(0, 30)}`,
    execute: async (args, _stream, signal) => {
      const bridge = services.interaction;
      if (!bridge) {
        return JSON.stringify({ status: 'error', data: { message: '交互桥未注入 PluginServices' } });
      }

      const agentId = selfId;
      const convKey = args.convKey || `${agentId}__unknown`;
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;

      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 questions 参数' } });
      }
      const qs = rawQuestions.slice(0, 5).map((q: any) => ({
        question: String(q?.question || ''),
        options: (Array.isArray(q?.options) ? q.options.map(String) : []).slice(0, 6),
      })).filter(q => q.question && q.options.length > 0);
      if (qs.length === 0) {
        return JSON.stringify({ status: 'error', data: { message: 'questions 无效：每题需 question + 至少一个 option' } });
      }

      try {
        // 默认允许用户输入自定义答案
        const answers = await bridge.askQuestions({
          agentId, convKey, questions: qs,
          timeoutMs, signal,
        });
        return JSON.stringify({ status: 'ok', data: { answers, questions: qs } });
      } catch (err: any) {
        return JSON.stringify({ status: 'timeout', data: { message: err.message || '用户未响应', questions: qs } });
      }
    },
  });
}

/** 应用控制工具工厂 */
export function makeAppTools(config: AgentConfig, services: PluginServices): Tool[] {
  return [
    makeSystemRestartTool(config),
    makeReloadTool(config),
    makeAskQuestionsTool(config, services),
  ];
}
