// ============================================================
// 内置预设清单 —— 数据驱动（presets/<name>/ 数据目录，loader 装载）。
// 新增预设：在 presets/ 加一个目录（preset.json + config.json +
// 可选 AGENT.md），零代码改动；外部插件另可经 ctx.agentPresets.register 注入。
// ============================================================
import type { AgentPresetDefinition } from './service';
import { loadBuiltinPresets } from './loader';

export const BUILTIN_PRESETS: AgentPresetDefinition[] = loadBuiltinPresets();
