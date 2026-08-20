// ============================================================
// @agentchat/agent-persona/src/persona.ts —— persona 装载与角色块
//
// 自 agent-prompt 拆出（v0.6.3 二次拆分：先拆钩子，再拆独立插件包）：
//   · loadPersona          AGENT.md（目录实体）→ config.persona（内联）回退
//   · hasSystemMdOverride  SYSTEM.md 存在 = 完全覆盖，persona 不另行注入
//   · personaPromptBlock   角色块文本（<persona> 标签包裹，无标题行）
//   · buildSystemPromptWithPersona  单次组合装配（预览服务用，与运行时钩子链同构）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentDir } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import { buildSystemPrompt, type SystemPromptDeps } from '@agentchat/agent-prompt';

/** 读取可选文件（缺失/空白 → null；剥离 YAML frontmatter，与 agent-prompt tryLoadFile 同规则） */
function tryLoadFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    let content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    content = content.replace(/^---[\s\S]*?---\n*/, '').trim();
    return content || null;
  } catch {
    return null;
  }
}

export interface PersonaLoadResult {
  text: string;
  source: 'AGENT.md' | 'inline';
}

/**
 * 加载 Agent 人设文本：AGENT.md（目录实体，支持本地覆盖预设定义）优先 →
 * config.persona（内联，预设 Agent 定义携带）回退。均无 → null。
 */
export function loadPersona(config: AgentConfig, agentsDir: string): PersonaLoadResult | null {
  const agentDir = resolveAgentDir(config.agent_id, agentsDir);
  if (agentDir) {
    const agentContent = tryLoadFile(path.join(agentDir, 'AGENT.md'));
    if (agentContent) return { text: agentContent, source: 'AGENT.md' };
  }
  const inline = (config as Record<string, unknown>).persona;
  if (typeof inline === 'string' && inline.trim()) {
    return { text: inline.trim(), source: 'inline' };
  }
  return null;
}

/** SYSTEM.md 覆盖检测（存在 = 完全替换 agent-prompt 装配结果，persona 钩子据此跳过注入） */
export function hasSystemMdOverride(config: AgentConfig, agentsDir: string): boolean {
  const agentDir = resolveAgentDir(config.agent_id, agentsDir);
  return !!agentDir && !!tryLoadFile(path.join(agentDir, 'SYSTEM.md'));
}

/** persona 角色块文本（SYSTEM.md 覆盖或无人设 → null；仅 <persona> 标签包裹，不加标题行） */
export function personaPromptBlock(config: AgentConfig, agentsDir: string): string | null {
  if (hasSystemMdOverride(config, agentsDir)) return null;
  const persona = loadPersona(config, agentsDir);
  if (!persona) return null;
  return `<persona>\n${persona.text}\n</persona>`;
}

/**
 * 单次组合装配：agent-prompt.buildSystemPrompt + persona 角色块前置。
 * 运行时由两个钩子（build-system-prompt → persona）完成；预览等单次调用方
 * （AgentService.getAgentSystemPrompt）使用本函数获得与运行时一致的结果。
 */
export function buildSystemPromptWithPersona(
  config: AgentConfig,
  deps: ToolContext,
  input: SystemPromptDeps = {},
): string {
  const base = buildSystemPrompt(config, deps, input);
  const block = personaPromptBlock(config, deps.agentsDir ?? '');
  return block ? `${block}\n\n${base}` : base;
}
