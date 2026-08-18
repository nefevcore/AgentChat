// ============================================================
// 内置工具能力盘点测试（A 方案）
//
// 目的：
//   1. 防止 requires 词汇表漂移（只能使用 base/dev/admin/conductor）
//   2. 防止工具被无意挪进/挪出某能力层
//
// 新增/调整任何内置工具时，必须同步更新本表。
// ============================================================
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ToolsService } from '@agentchat/tools';
import { TOOL_CAPABILITIES, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import type { PluginHost } from '@agentchat/plugins';
import { getOrCreatePluginHost } from '@agentchat/plugins';
import { makeFileTools } from '@agentchat/fs';
import { makeShellTools } from '@agentchat/shell';
import { makeWebTools } from '@agentchat/web';
import { makeDevTools, makeRegisterTool } from '@agentchat/dev';
import { makeRegisterPluginTool, makeUnregisterPluginTool } from '@agentchat/dev/src/plugin-tools';
import { makeSessionTools } from '@agentchat/session-tools';
import { makeRestartTools } from '@agentchat/restart';
import { makeInteractionTools } from '@agentchat/interaction';
import { makeAgentTools } from '@agentchat/agent-tools';
import { makeTimerTool } from '@agentchat/timer';
import { makeSubagentTool } from '@agentchat/subagent';
import { mathTools } from '@agentchat/math';

const config: AgentConfig = {
  agent_id: 'inventory',
  name: '能力盘点',
  tags: ['dev', 'admin', 'conductor'],
};

function collect(...toolsList: Array<Tool[] | Tool>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of toolsList) {
    for (const tool of Array.isArray(item) ? item : [item]) {
      out[tool.name] = [...(tool.requires ?? [])].sort();
    }
  }
  return out;
}

describe('内置工具 requires 能力盘点', () => {
  it('全部 requires 都来自受控词汇表 base/dev/admin/conductor', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const host = getOrCreatePluginHost(ctx);
    const services = {} as ToolContext;

    const inventory = collect(
      makeFileTools(config),
      makeShellTools(config),
      makeWebTools(config, services),
      makeDevTools(config),
      makeRegisterTool(tools),
      makeRegisterPluginTool(host as PluginHost, config, services),
      makeUnregisterPluginTool(host as PluginHost, config, services),
      makeSessionTools(config, services),
      makeRestartTools(config),
      makeInteractionTools(config, services),
      makeAgentTools(config, services),
      makeTimerTool(config, services),
      makeSubagentTool(config, services),
      mathTools,
    );

    for (const [name, requires] of Object.entries(inventory)) {
      for (const r of requires) {
        expect(TOOL_CAPABILITIES, `${name} 使用了未知能力标签 "${r}"`).toContain(r as never);
      }
    }
  });

  it('owner → tool → requires 快照与实现一致', () => {
    const ctx = new Context();
    const tools = new ToolsService(ctx);
    const host = getOrCreatePluginHost(ctx);
    const services = {} as ToolContext;

    expect(collect(makeFileTools(config))).toEqual({
      read: ['base'], write: ['base'], edit: ['base'],
    });
    expect(collect(makeShellTools(config))).toEqual({ bash: ['base'] });
    expect(collect(makeWebTools(config, services))).toEqual({
      web_search: ['base'], browser: ['base'],
    });
    expect(collect(makeDevTools(config))).toEqual({
      code_search: ['dev'], read_logs: ['dev'], reload: ['dev'],
    });
    expect(collect(
      makeRegisterTool(tools),
      makeRegisterPluginTool(host as PluginHost, config, services),
      makeUnregisterPluginTool(host as PluginHost, config, services),
    )).toEqual({
      register_tool: ['admin'],
      register_plugin: ['admin'],
      unregister_plugin: ['admin'],
    });
    expect(collect(makeSessionTools(config, services))).toEqual({
      query_history: ['base'], inspect_session: ['dev'], continue_turn: ['base'],
    });
    expect(collect(makeRestartTools(config))).toEqual({ system_restart: ['admin'] });
    expect(collect(makeInteractionTools(config, services))).toEqual({ ask_questions: ['base'] });
    expect(collect(makeAgentTools(config, services))).toEqual({
      send_agent: ['base'], send_group: ['base'], list_agents: ['base'],
      list_groups: ['base'], list_tools: ['base'], read_agent_info: ['base'],
      update_agent_profile: ['base'],
    });
    expect(collect(makeTimerTool(config, services))).toEqual({ timer: ['base'] });
    expect(collect(makeSubagentTool(config, services))).toEqual({ subagent: ['conductor'] });
    expect(collect(mathTools)).toEqual({ math: ['base'] });
  });
});
