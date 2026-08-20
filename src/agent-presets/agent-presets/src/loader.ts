// ============================================================
// @agentchat/agent-presets/src/loader.ts —— 内置预设数据装载
//
// 预设 = 数据文件（非代码），DSH agent-presets 同形态：
//   <pkg>/src/presets/<name>///     preset.json   展示元信息（label/description/default/order）
//                   —— 对应 DSH preset.yml
//     config.json   AgentConfig 主体（agent_id/name/presets/tools/hooks）
//                   —— 对应常规 Agent 的 agents/<dir>/config.json
//     AGENT.md      人设（可选）—— 与常规 Agent 同一约定；装载时读入
//                   config.persona，经 agent-prompt 装配注入系统提示词
//
// 新增预设 = 加一个目录，零代码改动（外部插件另可经
// ctx.agentPresets.register 动态注入）。数据损坏 = 抛错快速失败
//（启动期可见，不带病运行）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '@agentchat/agent-config';
import type { AgentPresetDefinition, AgentPresetMeta } from './service';

/** 预设数据根（本文件同级的 presets/） */
const PRESETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'presets');

/** 读取可选文件（缺失 → null；YAML frontmatter 剥离，与 agent-prompt tryLoadFile 同规则） */
function readOptionalFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    let content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return null;
    content = content.replace(/^---[\s\S]*?---\n*/, '').trim();
    return content || null;
  } catch {
    return null;
  }
}

function mustReadJson<T>(file: string, dirLabel: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`[agent-presets] 预设 "${dirLabel}" 缺少 ${path.basename(file)}（${file}）`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err: any) {
    throw new Error(`[agent-presets] 预设 "${dirLabel}" 的 ${path.basename(file)} 解析失败: ${err?.message ?? String(err)}`);
  }
}

/**
 * 扫描 presets/ 数据目录装载全部内置预设。
 * 校验：preset.json.label / config.json.agent_id+name 必填；AGENT.md 可选。
 * 排序：preset.json.order 升序（缺省垫底，再按目录名稳定排序）。
 */
export function loadBuiltinPresets(): AgentPresetDefinition[] {
  const out: AgentPresetDefinition[] = [];
  for (const entry of fs.readdirSync(PRESETS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dirLabel = entry.name;
    const dir = path.join(PRESETS_DIR, dirLabel);

    const meta = mustReadJson<AgentPresetMeta>(path.join(dir, 'preset.json'), dirLabel);
    if (typeof meta.label !== 'string' || !meta.label.trim()) {
      throw new Error(`[agent-presets] 预设 "${dirLabel}" 的 preset.json 缺少 label`);
    }

    const cfg = mustReadJson<AgentConfig>(path.join(dir, 'config.json'), dirLabel);
    if (typeof cfg.agent_id !== 'string' || !cfg.agent_id) {
      throw new Error(`[agent-presets] 预设 "${dirLabel}" 的 config.json 缺少 agent_id`);
    }
    if (typeof cfg.name !== 'string' || !cfg.name) {
      throw new Error(`[agent-presets] 预设 "${dirLabel}" 的 config.json 缺少 name`);
    }

    // AGENT.md（可选）→ config.persona（agent-prompt 装配消费：
    // 无 agents/ 目录实体时的内联人设载体）
    const persona = readOptionalFile(path.join(dir, 'AGENT.md'));
    if (persona) (cfg as Record<string, unknown>).persona = persona;

    out.push({ meta, agent: cfg });
  }

  out.sort((a, b) => (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER));
  return out;
}
