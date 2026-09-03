// ============================================================
// ac-agent-admin —— Agent 管理面行（M7 §二D 首期）
//
// inject ['webServer','agents','agentStore','credentials','tools']：
// 服务本体（ctx.agentAdmin）+ 写侧 RPC 注册（注册即归属——摘本行 =
// 管理面下线，各域服务与 ac-web-api 读面不受影响）。
//
// 方法面（src agent.config / api/agents 对照，preview 命名）：
//   agents/get-config      读档（store 优先，回退注册表）
//   agents/create          创建（白名单 + model 引用归一 + 落盘 + reassign）
//   agents/update-config   局部补丁（deepMerge + computeDiff 变更报告）
//   agents/delete          删数据目录 + 撤注册
//   agents/save-doc        文档写口（空内容 = 删；AGENT.md/persona 等）
//   agents/read-doc        文档读
//   agents/system-prompt   装配预览（before-run waterfall 干跑）
//   （agents/set-credential 已退役：连接凭据锁死 provider 定义——P4/D3）
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentAdminService } from './service.ts';

// 类型层认识（运行时按服务 key 解耦；type-only 零依赖）
import type {} from 'ac-agent-loop';
import type {} from 'ac-tools'; // ctx.tools 服务类型增强

export const name = 'ac-agent-admin';

export const inject = ['webServer', 'agents', 'agentStore', 'credentials', 'tools'];

// ---- 参数窄化（与 ac-web-api 同款薄行自持） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失或非非空字符串`);
  return v;
}

export function apply(ctx: Context) {
  const admin = new AgentAdminService(ctx);
  const web = ctx.webServer;

  /**
   * 预设 Agent 写口拦截：预设（__standard__ 等）由 ac-agent-presets 运行时
   * 物化（不在 agent-store）——管理面把它落盘会复制成实体 Agent，重启后与
   * 预设计划的物化注册撞名（boot 崩溃级污染）。UI 名册已过滤预设，此处
   * 拦直连 RPC 的越权写。
   */
  function assertNotPreset(agentId: string): void {
    if (ctx.agents.get(agentId)?.preset === true) {
      throw new Error(`"${agentId}" 是预设 Agent（运行时物化），不可经管理面修改`);
    }
  }

  web.registerRpc('agents/get-config', (params) => ({
    config: admin.getAgent(reqStr(obj(params), 'agentId')),
  }));

  web.registerRpc('agents/create', (params) => {
    const config = obj(obj(params).config);
    const id = typeof config.id === 'string' && config.id ? config.id : '';
    if (id && ctx.agents.has(id)) assertNotPreset(id);
    return { config: admin.createAgent(config) };
  });

  web.registerRpc('agents/update-config', (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    assertNotPreset(agentId);
    return admin.updateAgent(agentId, obj(p.patch));
  });

  web.registerRpc('agents/delete', (params) => {
    const agentId = reqStr(obj(params), 'agentId');
    assertNotPreset(agentId);
    return { removed: admin.deleteAgent(agentId) };
  });

  web.registerRpc('agents/save-doc', (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    assertNotPreset(agentId);
    admin.saveDoc(agentId, reqStr(p, 'name'), typeof p.content === 'string' ? p.content : '');
    return { saved: true };
  });

  web.registerRpc('agents/read-doc', (params) => {
    const p = obj(params);
    const content = admin.readDoc(reqStr(p, 'agentId'), reqStr(p, 'name'));
    return { ...(content !== undefined ? { content } : {}) };
  });

  web.registerRpc('agents/system-prompt', async (params) => {
    const agentId = reqStr(obj(params), 'agentId');
    return { agentId, systemPrompt: await admin.systemPromptPreview(agentId) };
  });

  // ---- M17-A：装配视图（ExtToolsPane 数据源；GET 读 / PUT 写） ----
  web.registerRpc('agents/assembly', (params) => ({
    assembly: admin.assemblyView(reqStr(obj(params), 'agentId')),
  }));

  web.registerRpc('agents/assembly/update', (params) => {
    const p = obj(params);
    const agentId = reqStr(p, 'agentId');
    assertNotPreset(agentId);
    return admin.updateAssembly(agentId, obj(p.patch));
  });
}

export { AgentAdminService } from './service.ts';
export type { AdminUpdateResult } from './service.ts';
