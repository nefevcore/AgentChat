// ============================================================
// @agentchat/fs —— 文件工具族注册回归测试
//
// 保护 2026-08-16 修复：agentchat-fs-tools 插件目录声明提供
// read/write/edit，但 makeFileTools 曾只返回 read/write，导致
// edit 没有注册进 Agent 默认工具集。
// ============================================================
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import { makeFileTools } from '@agentchat/fs';

describe('@agentchat/fs 文件工具族', () => {
  it('makeFileTools 包含 read/write/edit 三个默认文件工具', () => {
    const config = { agent_id: 'fs-test', name: 'FS Test' } as AgentConfig;
    const names = makeFileTools(config).map((t) => t.name);

    expect(names).toEqual(['read', 'write', 'edit']);
    for (const tool of makeFileTools(config)) {
      // 默认 Agent 均隐式携带 base 能力层，requires 命中后自动启用
      expect(tool.requires).toContain('base');
    }
  });
});
