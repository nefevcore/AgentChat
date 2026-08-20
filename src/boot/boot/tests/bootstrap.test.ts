// ============================================================
// src/app/index bootstrap 冒烟测试（L5 装配端到端）
//
// 使用临时工作区（AGENTCHAT_WORKSPACE + AGENTCHAT_CREDENTIALS_FILE 隔离），
// enableWebUI:false（server 层尚未重建）。
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap';
import { getRouter } from '@agentchat/server';

let tmp: string;
let prevWs: string | undefined;
let prevCreds: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-boot-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevCreds = process.env.AGENTCHAT_CREDENTIALS_FILE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  process.env.AGENTCHAT_CREDENTIALS_FILE = path.join(tmp, 'creds.json');
  // 非首次运行（避免触发 admin 引导的 LLM 触发）
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf-8');
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevCreds === undefined) delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  else process.env.AGENTCHAT_CREDENTIALS_FILE = prevCreds;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 预置 Agent（user 虚拟 + agentA 带插件/LLM） */
function seedAgents(): void {
  fs.mkdirSync(path.join(tmp, 'agents', 'user'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', 'user', 'config.json'), JSON.stringify({
    agent_id: 'user', name: '用户', virtual: true,
  }), 'utf-8');
  fs.mkdirSync(path.join(tmp, 'agents', 'agentA'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', 'agentA', 'config.json'), JSON.stringify({
    agent_id: 'agentA', name: 'Agent A',
    llm: { provider: 'deepseek', model: 'x', api_key: 'sk-test' },
    presets: ['agentchat-fs-tools', 'agentchat-math'],
    tools: ['read', 'math'],
  }), 'utf-8');
}

describe('bootstrap（L5 冒烟）', () => {
  it('装配完成：agents 注册 + L4 服务/RPC/插件链路接通', async () => {
    seedAgents();
    const result = await bootstrap({ enableWebUI: false });
    try {
      // agents 注册（+默认预设内置 Agent：独立会话未选 Agent 的投递目标）
      expect(result.registry.listIds().sort()).toEqual(['__dsh_minimal__', '__standard__', 'agentA', 'user']);
      // 预设 Agent 不占 Agent 列表 UI
      expect(result.agentService.listBasic().length).toBe(2);
      expect(result.agentService.listBasic().map((a: any) => a.id).sort()).toEqual(['agentA', 'user']);

      // runtime 门面注入
      expect(getRouter()).toBe(result.router);

      // RPC 桥映射
      expect(result.rpc.listMethods()).toContain('agent.listBasic');
      const basic = await result.rpc.call('agent.listBasic', undefined);
      expect((basic as any[]).length).toBe(2);

      // 插件链路：工具解析（builtin read/edit + builtin-math math）
      const defs = result.agentService.getAgentToolDefs('agentA');
      const names = defs.map((d) => (d as any).function?.name);
      expect(names).toContain('read');
      expect(names).toContain('edit');
      expect(names).toContain('math');

      // 群组服务 + 落盘
      const g = result.groupService.createGroup({ group_id: 'g1', name: '群1', participants: ['agentA'] });
      expect(g.name).toBe('群1');
      expect(fs.existsSync(path.join(tmp, 'groups', 'g1', 'group.json'))).toBe(true);
      expect(result.groupService.getGroup('g1')?.group_id).toBe('g1');

      // 历史服务
      expect(result.historyService).toBeDefined();

      // 全面 cordis 化：L3 服务经 PluginRegistry 预置（setService），装配层不再批量注册到 ServiceRegistry
      // （loadHistory/buildSystemPrompt 已直连 ext；timer/subagent 经 setService 预置 + ctx 服务包装）
      // 全面 cordis 化：timer/subagent 直连实例（不再经 PluginRegistry）
      expect(result.timer).toBeDefined();
      expect(result.subAgent).toBeDefined();

      // 虚拟 Agent 端点（无 LLM）：agentA → user 回执
      const resp = await result.router.send({ from: 'agentA', to: 'user', type: 'chat.send', payload: 'hello' });
      expect(typeof resp).toBe('string');
      expect(resp.length).toBeGreaterThan(0);
    } finally {
      // 清理：中止 timer 定时器，避免测试进程挂起
      result.timer?.stopAll();
    }
  });

  it('工作区初始化：默认 user 配置自动创建', async () => {
    // 空 agents 目录
    const result = await bootstrap({ enableWebUI: false });
    try {
      expect(result.registry.has('user')).toBe(true); // ensureWorkspaceFiles 创建
      expect(fs.existsSync(path.join(tmp, 'agents', 'user', 'config.json'))).toBe(true);
    } finally {
      result.timer?.stopAll();
    }
  });

  it('已有 admin 时不重复创建默认 admin（非首次）', async () => {
    fs.mkdirSync(path.join(tmp, 'agents', 'existing_admin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'existing_admin', 'config.json'), JSON.stringify({
      agent_id: 'admin', name: 'Admin', tags: ['admin'],
    }), 'utf-8');
    const result = await bootstrap({ enableWebUI: false });
    try {
      expect(result.registry.has('admin')).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'agents', 'admin', 'config.json'))).toBe(false);
    } finally {
      result.timer?.stopAll();
    }
  });
});
