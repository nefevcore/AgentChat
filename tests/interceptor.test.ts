// ============================================================
// agent_profile 拦截器单元测试
//
// 回归背景（commit b1108a0）：
//   1. 误伤：整个 agents/ 目录被当"档案"拦截 → Agent 无法自举开发工具
//   2. 漏洞：edit 的 edits[] / input DSL 里的 filePath 未检查，可绕过拦截
//
// 期望行为：
//   - 写自己的 <agentsDir>/<self>/tools/ → 放行（工具源码）
//   - 写自己的 config.json / AGENT.md → 拦截（档案）
//   - 写其他 Agent 的任何目录 → 拦截
//   - edit 通过 edits[] / input DSL 指向档案 → 拦截
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock @core/config 的 getGlobalConfig ----
const MOCK_AGENTS_DIR = 'C:/proj/workspace/default/agents';
vi.mock('@core/config', () => ({
  getGlobalConfig: () => ({ agentsDir: MOCK_AGENTS_DIR }),
}));

import { interceptor } from '@global/agent-core/interceptors/agent_profile/interceptor';

function call(toolName: string, args: Record<string, any>, agentId = 'agent_chat_dev') {
  return interceptor(toolName, { agentId, args } as any);
}

describe('agent_profile 拦截器', () => {
  beforeEach(() => {
    // 重置 mock（无状态，仅保险）
  });

  it('档案工具自动注入 from 并放行', () => {
    const r = call('read_agent_info', {});
    expect(r.allow).toBe(true);
    expect((r.args as any).from).toBe('agent_chat_dev');
  });

  it('update_agent_profile 强制 agent_id 为自己', () => {
    const r = call('update_agent_profile', { fields: {} }, 'agent_chat_dev');
    expect(r.allow).toBe(true);
    expect((r.args as any).agent_id).toBe('agent_chat_dev');
  });

  it('禁止 update 其他 Agent 档案', () => {
    const r = call('update_agent_profile', { agent_id: 'news', fields: {} }, 'agent_chat_dev');
    expect(r.allow).toBe(false);
  });

  it('write 到自己的 tools/ 目录 → 放行（自举工具开发）', () => {
    const r = call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/tools/code_search/meta.ts` });
    expect(r.allow).toBe(true);
  });

  it('write 到自己的 config.json → 拦截（档案）', () => {
    const r = call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/config.json` });
    expect(r.allow).toBe(false);
  });

  it('write 到自己的 AGENT.md → 拦截（档案）', () => {
    const r = call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/AGENT.md` });
    expect(r.allow).toBe(false);
  });

  it('write 到其他 Agent 的 tools/ → 拦截', () => {
    const r = call('write', { filePath: `${MOCK_AGENTS_DIR}/news/tools/foo/tool.ts` });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 edits[] 数组指向其他 Agent 档案 → 拦截（路径提取漏洞修复）', () => {
    const r = call('edit', {
      edits: [
        { filePath: `${MOCK_AGENTS_DIR}/news/config.json`, op: 'replace', pos: '1#x', newText: '{}' },
      ],
    });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 input DSL ([path#TAG]) 指向其他 Agent 档案 → 拦截', () => {
    const r = call('edit', {
      input: `[${MOCK_AGENTS_DIR.replace(/\\/g, '/')}/news/config.json#abc]\nSWAP 1.=1:\n+new`,
    });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 input DSL 指向自己的 tools/ → 放行', () => {
    const r = call('edit', {
      input: `[${MOCK_AGENTS_DIR.replace(/\\/g, '/')}/agent_chat_dev/tools/code_search/tool.ts#abc]\nSWAP 1.=1:\n+new`,
    });
    expect(r.allow).toBe(true);
  });

  it('bash 命令包含 agents 目录 → 拦截', () => {
    const r = call('bash', { command: `New-Item ${MOCK_AGENTS_DIR}/news/tools/foo` });
    expect(r.allow).toBe(false);
  });

  it('普通 write（src 下）→ 放行', () => {
    const r = call('write', { filePath: 'C:/proj/src/core/types.ts' });
    expect(r.allow).toBe(true);
  });
});
