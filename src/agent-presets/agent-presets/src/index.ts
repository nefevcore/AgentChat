// ============================================================
// @agentchat/agent-presets —— 预设 Agent 注册中心
// ============================================================

export { AgentPresetsService } from './service';
export type { AgentPresetMeta, AgentPresetDefinition } from './service';
export { BUILTIN_PRESETS } from './register';
export { loadBuiltinPresets } from './loader';
