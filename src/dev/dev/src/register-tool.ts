// ============================================================
// @agentchat/dev/src/register-tool.ts —— 运行时工具注册（Agent 自我进化闭环）
//
// register_tool（admin 权限）：Agent/用户传入工具定义（name/description/
// parameters/requires）+ execute 代码（JS 纯函数），经 vm 沙箱编译后注册
// 到 ctx.tools。注册后：
//   · 下一步 ReAct 立即可调用（createAgentContext 每次投递重新 resolveTools）
//   · /api/plugins 工具目录自动可见（getAgentTools 经 ctx.tools）
//   · 全局生效（共享工具，跨 Agent）
//
// 安全边界：execute 在 vm 沙箱中运行 —— 无 process/require/globalThis/IO，
// 仅注入 JSON/Math/Number/String/Promise/console（受限）。纯函数（参数→字符串）。
// 复杂工具（需 IO/第三方依赖）应在源码层以插件注册（本包 registerXxx 模式）。
// ============================================================
import * as vm from 'vm';
import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_ADMIN, CAPABILITY_BASE, isToolCapability } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolsService } from '@agentchat/tools';

/** 沙箱注入白名单（表达式可见的最小集；无 process/require/globalThis/IO） */
function makeSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    JSON, Math, Number, String, Boolean, Array, Object, Promise,
    Infinity, NaN, parseInt, parseFloat, isNaN, isFinite, Date,
    console: {
      log: (...args: unknown[]) => { /* 受限：静默（或接日志） */ void args; },
    },
  };
  return sandbox;
}

/** 编译 execute 代码（JS 纯函数：args → string），超时防死循环 */
function compileExecute(code: string): (args: Record<string, any>) => Promise<string> {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  let fn: unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = vm.runInContext(`(${code})`, context, { timeout: 2000 });
  } catch (err: any) {
    throw new Error(`execute 代码编译失败: ${err?.message ?? String(err)}`);
  }
  if (typeof fn !== 'function') {
    throw new Error('execute 必须是函数（如 "async (args) => string"）');
  }
  return async (args: Record<string, any>) => {
    try {
      const result = await (fn as (a: Record<string, any>) => unknown)(args);
      return String(result ?? '');
    } catch (err: any) {
      return `[register_tool] execute 执行失败: ${err?.message ?? String(err)}`;
    }
  };
}

/**
 * 注册工具工厂：Agent 传入工具定义 + execute 代码，注册到 ctx.tools。
 * 运行时注册的工具 owner = runtime:register-tool:<agentId>，且 always=true：
 * 不参与 presets 过滤，保证注册后立即全局可见（旧行为兼容）。
 * @param toolsService ctx.tools（闭包注入；由 registerDevTools 传递）
 * @param runtimeOwner 运行时注册归属（含 Agent id，审计用）
 */
export function makeRegisterTool(toolsService: ToolsService, runtimeOwner = 'runtime:register-tool'): Tool {
  return defineTool({
    name: 'register_tool', label: '注册工具', requires: [CAPABILITY_ADMIN],
    description: '运行时注册一个新工具（Agent 自我进化闭环）：传入工具定义（name/label/description/parameters JSON Schema/requires 能力标签）与 execute 代码（JS 纯函数 (args) => string，经 vm 沙箱隔离执行：无 IO/进程访问）。requires 只能使用受控标签 base/dev/admin/conductor，缺省为 base（所有真实 Agent 默认可用）。同名重复注册执行 replace 语义（后注册者胜，替换旧运行时工具并遮蔽同名工厂工具；卸载 owner 后工厂工具恢复）。注册后下一条消息即可调用，且全局可见。⚠️ 仅限纯计算逻辑；需要文件/网络/进程能力的工具请在源码层以插件注册。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名（唯一，LLM 调用名）' },
        label: { type: 'string', description: '显示标签' },
        description: { type: 'string', description: '工具描述（给 LLM 看）' },
        parameters: { type: 'object', description: '参数 JSON Schema（{type:"object",properties:{...},required:[...]}）' },
        execute: { type: 'string', description: 'execute 实现（JS 纯函数，async (args) => string；沙箱内仅注入 JSON/Math/Number/String/Promise 等，无 IO/进程）' },
        requires: { type: 'array', items: { type: 'string' }, description: '能力标签要求（AND 语义；仅受控词汇 base/dev/admin/conductor；缺省 base）' },
      },
      required: ['name', 'description', 'parameters', 'execute'],
    },
    extractLabel: (args) => `注册工具 ${args.name}`,
    execute: async (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return JSON.stringify({ status: 'error', data: { message: '缺少 name' } });
      try {
        const exec = compileExecute(String(args.execute));
        // 受控词汇表：requires 只接受 base/dev/admin/conductor；缺省 = base（全局默认可用）
        const rawRequires = Array.isArray(args.requires) ? args.requires.map(String) : undefined;
        const requires = rawRequires?.length ? rawRequires : [CAPABILITY_BASE];
        const invalid = requires.filter((r) => !isToolCapability(r));
        if (invalid.length > 0) {
          return JSON.stringify({
            status: 'error',
            data: { message: `requires 含未知能力标签：${invalid.join(', ')}（仅支持 base/dev/admin/conductor）` },
          });
        }
        const tool = defineTool({
          name,
          label: String(args.label ?? name),
          requires,
          description: String(args.description ?? ''),
          parameters: (args.parameters ?? { type: 'object', properties: {} }) as Record<string, any>,
          execute: exec,
        });
        toolsService.register(runtimeOwner, [tool], { always: true, replace: true });
        return JSON.stringify({
          status: 'ok',
          data: {
            message: `工具 "${name}" 已注册（全局生效）——下一条消息即可调用；工具目录已更新。`,
            name,
          },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}
