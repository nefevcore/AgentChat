// ============================================================
// security hook（旧 agent_profile 拦截器）单元测试
//
// 回归背景（commit b1108a0）：
//   1. 误伤：整个 agents/ 目录被当"档案"拦截 → Agent 无法自举开发工具
//   2. 漏洞：edit 的 edits[] / input DSL 里的 filePath 未检查，可绕过拦截
//
// 新架构：拦截器转为 builtin.security-check（toolExecutionStartHook），
//   makeSecurityStartHook(agentsDir, selfId) 返回异步 hook(toolName, args)。
//   身份注入（from）已由工具工厂烘焙，不再由 hook 做。
//
// 期望行为：
//   - 写自己的 <agentsDir>/<self>/tools/ → 放行（工具源码）
//   - 写自己的 config.json / AGENT.md → 拦截（档案）
//   - 写其他 Agent 的任何目录 → 拦截
//   - edit 通过 edits[] / input DSL 指向档案 → 拦截
// ============================================================

import { describe, it, expect } from 'vitest';
import { makeSecurityStartHook } from '@plugins/builtin/hooks/security';

const MOCK_AGENTS_DIR = 'C:\\proj\\workspace\\default\\agents';

// 直接调用 hook（selfId = agent_chat_dev）
function call(toolName: string, args: Record<string, any>) {
  return makeSecurityStartHook(MOCK_AGENTS_DIR, 'agent_chat_dev')(toolName, args);
}

describe('security hook（旧 agent_profile 拦截器）', () => {
  it('read_agent_info 放行', async () => {
    const r = await call('read_agent_info', {});
    expect(r.allow).toBe(true);
  });

  it('update_agent_profile 不指定他人 → 放行', async () => {
    const r = await call('update_agent_profile', { fields: {} });
    expect(r.allow).toBe(true);
  });

  it('禁止 update 其他 Agent 档案（非 admin）', async () => {
    const r = await call('update_agent_profile', { agent_id: 'news', fields: {} });
    expect(r.allow).toBe(false);
  });

  it('write 到自己的 tools/ 目录 → 放行（自举工具开发）', async () => {
    const r = await call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/tools/code_search/meta.ts` });
    expect(r.allow).toBe(true);
  });

  it('write 到自己的 config.json → 拦截（档案）', async () => {
    const r = await call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/config.json` });
    expect(r.allow).toBe(false);
  });

  it('write 到自己的 AGENT.md → 拦截（档案）', async () => {
    const r = await call('write', { filePath: `${MOCK_AGENTS_DIR}/agent_chat_dev/AGENT.md` });
    expect(r.allow).toBe(false);
  });

  it('write 到其他 Agent 的 tools/ → 拦截', async () => {
    const r = await call('write', { filePath: `${MOCK_AGENTS_DIR}\\news\\tools\\foo\\tool.ts` });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 edits[] 数组指向其他 Agent 档案 → 拦截（路径提取漏洞修复）', async () => {
    const r = await call('edit', {
      edits: [
        { filePath: `${MOCK_AGENTS_DIR}\\news\\config.json`, op: 'replace', pos: '1#x', newText: '{}' },
      ],
    });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 input DSL ([path#TAG]) 指向其他 Agent 档案 → 拦截', async () => {
    const r = await call('edit', {
      input: `[${MOCK_AGENTS_DIR}\\news\\config.json#abc]\nSWAP 1.=1:\n+new`,
    });
    expect(r.allow).toBe(false);
  });

  it('edit 通过 input DSL 指向自己的 tools/ → 放行', async () => {
    const r = await call('edit', {
      input: `[${MOCK_AGENTS_DIR}\\agent_chat_dev\\tools\\code_search\\tool.ts#abc]\nSWAP 1.=1:\n+new`,
    });
    expect(r.allow).toBe(true);
  });

  it('bash 命令包含 agents 目录 → 拦截', async () => {
    const r = await call('bash', { command: `New-Item ${MOCK_AGENTS_DIR}\\news\\tools\\foo` });
    expect(r.allow).toBe(false);
  });

  it('普通 write（src 下）→ 放行', async () => {
    const r = await call('write', { filePath: 'C:\\proj\\src\\core\\types.ts' });
    expect(r.allow).toBe(true);
  });
});
