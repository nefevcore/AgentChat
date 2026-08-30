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
import { TOOL_CAPABILITIES, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import type { PluginHost } from '@agentchat/plugins';
import { getOrCreatePluginHost } from '@agentchat/plugins';
import { makeFileTools } from '@agentchat/fs';
import { makeFsSearchTools } from '@agentchat/fs-search';
import { makeStrReplaceEditorTool } from '@agentchat/str-replace-editor';
import { makeShellTools } from '@agentchat/shell';
import { makeWebTools } from '@agentchat/web';
import { makeDevTools } from '@agentchat/dev';
import { makeRegisterPluginTool, makeUnregisterPluginTool } from '@agentchat/dev';
import { makeGrepHistoryTool, makeReadHistoryTool } from '@agentchat/session-tools';
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
    const host = getOrCreatePluginHost(ctx);
    const services = {} as ToolContext;

    const inventory = collect(
      makeFileTools(config),
      makeFsSearchTools(config),
      makeStrReplaceEditorTool(config),
      makeShellTools(config),
      makeWebTools(config, services),
      makeDevTools(config),
      makeRegisterPluginTool(host as PluginHost, config, services),
      makeUnregisterPluginTool(host as PluginHost, config, services),
      makeGrepHistoryTool(config),
      makeReadHistoryTool(config),
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
    const host = getOrCreatePluginHost(ctx);
    const services = {} as ToolContext;

    expect(collect(makeFileTools(config))).toEqual({
      read: ['base'], write: ['base'], edit: ['base'],
    });
    expect(collect(makeFsSearchTools(config))).toEqual({
      glob: ['base'], grep: ['base'],
    });
    expect(collect(makeStrReplaceEditorTool(config))).toEqual({
      str_replace_editor: ['base'],
    });
    expect(collect(makeShellTools(config))).toEqual({ bash: ['base'], job: ['base'] });
    expect(collect(makeWebTools(config, services))).toEqual({
      web_search: ['base'], browser: ['base'],
    });
    expect(collect(makeDevTools(config))).toEqual({
      read_logs: ['dev'], reload: ['dev'], reload_modules: ['dev'],
    });
    expect(collect(
      makeRegisterPluginTool(host as PluginHost, config, services),
      makeUnregisterPluginTool(host as PluginHost, config, services),
    )).toEqual({
      register_plugin: ['admin'],
      unregister_plugin: ['admin'],
    });
    expect(collect(makeGrepHistoryTool(config), makeReadHistoryTool(config))).toEqual({
      grep_history: ['base'], read_history: ['base'],
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
