// ============================================================
// 预设 Agent 注册中心测试：内置数据（数据文件装载）/ 默认预设 / owner 卸载
// ============================================================
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { BUILTIN_PRESETS, AgentPresetsService, type AgentPresetDefinition } from '../src/index';

/** cordis Context 桩（Service 构造需要） */
function makeService(): AgentPresetsService {
  return new AgentPresetsService(new Context());
}

function presetOf(id: string): AgentPresetDefinition {
  const def = BUILTIN_PRESETS.find((d) => d.agent.agent_id === id);
  if (!def) throw new Error(`内置预设 ${id} 不存在`);
  return def;
}

const STANDARD_PRESET = () => presetOf('__standard__');
const DSH_MINIMAL_PRESET = () => presetOf('__dsh_minimal__');

describe('内置预设数据（standard）', () => {
  it('BUILTIN_PRESETS 按 order 排序 = [standard, dsh-minimal]；standard 为默认', () => {
    expect(BUILTIN_PRESETS.map((d) => d.agent.agent_id)).toEqual(['__standard__', '__dsh_minimal__']);
    expect(STANDARD_PRESET().meta.default).toBe(true);
    expect(DSH_MINIMAL_PRESET().meta.default).toBe(false);
  });

  it('standard = allowlist：显式 presets 清单，不含协作/记忆/技能/math 域', () => {
    const presets = STANDARD_PRESET().agent.presets ?? [];
    // 会话必需（提示词装配 + 人设 + 历史持久化）
    expect(presets).toContain('agentchat-agent-prompt');
    expect(presets).toContain('agentchat-agent-persona');
    expect(presets).toContain('agentchat-agent-session');
    // 日期注入不进预设：独立会话提示词全静态（最大 KV cache），按 Agent 显式启用
    expect(presets).not.toContain('agentchat-agent-datetime');
    // 基础工具域
    expect(presets).toContain('agentchat-fs-tools');
    expect(presets).toContain('agentchat-fs-search-tools');   // glob/grep 文件发现（DSH standard 同款）
    expect(presets).toContain('agentchat-shell-tools');
    expect(presets).toContain('agentchat-web-tools');
    expect(presets).toContain('agentchat-interaction-tools');
    // str_replace_editor 不进 standard（与 read/write/edit 重叠；DSH 同样只配 minimal）
    expect(presets).not.toContain('agentchat-str-replace-editor-tools');
    // math 已移除（用户决策）
    expect(presets).not.toContain('agentchat-math');
    // 协作域不在清单（新协作插件天然不进预设——无需改代码）
    expect(presets).not.toContain('agentchat-agent-tools');
    expect(presets).not.toContain('agentchat-session-tools');
    expect(presets).not.toContain('agentchat-timer-tools');
    expect(presets).not.toContain('agentchat-subagent-tools');
    // 记忆/技能/MCP 不进预设
    expect(presets).not.toContain('agentchat-agent-memory');
    expect(presets).not.toContain('agentchat-agent-skill');
    expect(presets).not.toContain('agentchat-agent-mcp');
  });

  it('预设不归档：hooks 无 archive-session / idle-reset（单 session 会话，生命周期随会话）', () => {
    for (const def of [STANDARD_PRESET(), DSH_MINIMAL_PRESET()]) {
      const hooks = def.agent.hooks ?? {};
      expect(hooks.runEnd).toContain('agent-session.save-session');
      expect(hooks.runEnd).not.toContain('agent-session.archive-session');
      expect(hooks.runEnd).not.toContain('agent-session.idle-reset');
    }
  });

  it('standard 无 persona 字段（system_prompt/tags 不注入提示词）', () => {
    const cfg = STANDARD_PRESET().agent as Record<string, unknown>;
    expect(cfg.system_prompt).toBeUndefined();
    expect(STANDARD_PRESET().agent.tags).toBeUndefined();
  });
});

describe('内置预设数据（dsh-minimal）', () => {
  it('dsh-minimal：仅 str_replace_editor / bash 两件工具（DSH minimal 同款组合）', () => {
    const tools = DSH_MINIMAL_PRESET().agent.tools as { include: string[]; exclude: string[] };
    expect(tools.include).toEqual(['bash']);
    // read/write/edit 默认随 fs 插件启用（requires=base）——fs 域整行不进
    // presets，exclude 再防御性排除一遍（同名工具经其他 owner 进候选也不混入）
    expect(tools.exclude).toEqual(['read', 'write', 'edit']);
    // 插件域只需 str-replace-editor + shell（bash 所在）；fs 域整行不装
    const presets = DSH_MINIMAL_PRESET().agent.presets ?? [];
    expect(presets).toContain('agentchat-str-replace-editor-tools');
    expect(presets).toContain('agentchat-shell-tools');
    expect(presets).not.toContain('agentchat-fs-tools');
    // 日期注入不进预设（独立会话保持全静态提示词）；时间感知按 Agent 显式启用
    expect(presets).not.toContain('agentchat-agent-datetime');
    // 不装 web/interaction/math/fs-search 域（发现靠 bash，DSH minimal 同款）
    expect(presets).not.toContain('agentchat-web-tools');
    expect(presets).not.toContain('agentchat-interaction-tools');
    expect(presets).not.toContain('agentchat-math');
    expect(presets).not.toContain('agentchat-fs-search-tools');
  });

  it('dsh-minimal 人设来自数据文件 AGENT.md（loader 装入 config.persona）', () => {
    const persona = (DSH_MINIMAL_PRESET().agent as Record<string, unknown>).persona;
    expect(typeof persona).toBe('string');
    expect(String(persona)).toContain('software engineer');
    // standard 无 AGENT.md → 无 persona（通用对话定位）
    expect((STANDARD_PRESET().agent as Record<string, unknown>).persona).toBeUndefined();
  });
});

describe('AgentPresetsService 注册语义', () => {
  it('register/list/defaultPreset：meta.default 优先，缺省取第一个', () => {
    const svc = makeService();
    expect(svc.list()).toHaveLength(0);
    expect(svc.defaultPreset()).toBeNull();

    svc.register(DSH_MINIMAL_PRESET(), 'test-owner');
    expect(svc.defaultPreset()?.agent.agent_id).toBe('__dsh_minimal__');

    svc.register(STANDARD_PRESET(), 'test-owner');
    expect(svc.defaultPreset()?.agent.agent_id).toBe('__standard__'); // meta.default 优先

    // 同 id 覆盖
    svc.register({ ...STANDARD_PRESET(), meta: { ...STANDARD_PRESET().meta, label: '改' } }, 'other');
    expect(svc.list()).toHaveLength(2);
    expect(svc.list().find((d) => d.agent.agent_id === '__standard__')?.meta.label).toBe('改');
  });

  it('unregister 按 owner 卸载', () => {
    const svc = makeService();
    svc.register(STANDARD_PRESET(), 'owner-a');
    expect(svc.unregister('owner-b')).toBe(0);
    expect(svc.unregister('owner-a')).toBe(1);
    expect(svc.list()).toHaveLength(0);
  });
});
