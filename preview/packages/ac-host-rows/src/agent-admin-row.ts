// ============================================================
// agent-admin-row.ts —— 宿主 agent-admin 行（cr-542；行集清单 R1「webui 写侧
// RPC 编排（agent CRUD → agents 编辑面）」preview 落地）
//
// 行资格（R0b 三问）：服务插槽否（只注册 RPC，无跨行服务面）；良定义降级
// 是（摘本行 = 管理面 RPC 下线，agents 编辑面与其消费方照常）；独立装载档位
// 是（webui 写侧装卸有意义）。故本行 = 纯编排：参数窄化 + 写面词汇调用 +
// 返回形状对齐主线，零业务逻辑、零落盘（落盘归 agents 编辑面唯一写口）。
//
// 方法面（主线 ac-agent-admin 方法面平移——服务面换 AgentsEditService）：
//   agents/get-config   读档（缺席 = 未知身份 fail-loud）
//   agents/create       创建（白名单 + model 引用归一 + id 派生）
//   agents/update-config 局部补丁（补丁合成 + 变更键报告）
//   agents/delete       删整树（父删除级联杀子 = agents 树自含语义）
//   agents/save-doc     文档写口（空内容 = 删——主线 writeMDFile 语义）
//   agents/read-doc     文档读
//   agents/system-prompt 装配预览（cr-552：装配链住壳进程——经编排面控制帧
//   往返到壳内三档链干跑；读面语义与主线同构，宿主零装配知识）
//   agents/assembly      装配视图（工具目录 = 壳内投影；plugins = 宿主
//   pluginRegistry 安装态；settings = AgentConfig.settings 直读）
//   agents/assembly/update 装配写口（applyAssemblyPatch 纯函数 + 编辑面
//   唯一写口落盘——宿主本地完成，无需壳往返）
//
// 预设写口拦截的去向：主线 assertNotPreset 存在的前提是「预设物化进注册表」；
// 新架构预设 = preset-builtin 静态模板集（不进 agents/ 树本体）——该类撞名在
// 结构上不存在，闸随之退役（不是遗漏）。
// ============================================================
import type { Plugin, Context } from '@agentchat/cordis';
import { statSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  applyAssemblyPatch,
  applyConfigPatch,
  changedConfigKeysOf,
  configFromPatch,
  sanitizeAgentInput,
  type AgentConfig,
} from 'ac-agents-core';
import { avatarContentType } from './agents-row.ts';

/** 写侧 RPC 编排依赖的编辑面（插槽-插头：摘 agents 行 = 本行 PENDING，管理面下线） */
export interface AgentsEditFace {
  getAgent(id: string): AgentConfig | undefined;
  saveAgent(config: AgentConfig): void;
  removeAgent(id: string): boolean;
  agentIds(): string[];
  saveDoc(id: string, name: string, content: string): void;
  removeDoc(id: string, name: string): boolean;
  readDoc(id: string, name: string): string | undefined;
  /** 头像三面（Agent 剩余工作面 cr-588：上传/删除/静态读——存 agents 编辑面目录） */
  saveAvatar(id: string, data: Buffer, ext: string): string;
  avatarPath(id: string): string | undefined;
  removeAvatar(id: string): boolean;
}

// ---- 参数窄化（主线 agent-admin 同款薄行自持） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') throw new Error(`参数 ${key} 缺失或非非空字符串`);
  return value;
}

/** 读档（缺席 = 未知身份 fail-loud——写侧不静默造档） */
function requireAgent(agents: AgentsEditFace, agentId: string): AgentConfig {
  const config = agents.getAgent(agentId);
  if (config === undefined) throw new Error(`unknown agent: ${agentId}`);
  return config;
}

/** 预览面（cr-552 跨进程 dry-run）：编排面控制帧往返的最小注入面 */
export interface AdminPreviewFace {
  systemPrompt(agentId: string, conversationId?: string): Promise<string>;
  assemblyTools(agentId: string): Promise<{
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; owner: string; requiredTags?: string[]; needPermission?: boolean }>;
    enabled: string[];
  }>;
}

export interface AgentAdminRowOptions {
  /** 跨进程预览面（缺席 = 编排面未接线：system-prompt/assembly 读面 fail-loud，其余六方法照常） */
  adminPreview?: AdminPreviewFace;
}

/** agent-admin 行（inject ['webServer','agents']——两服务同树（宿主单树装配）才激活） */
export function makeAgentAdminRow(options: AgentAdminRowOptions = {}): Plugin {
  return {
    name: 'ac-host-rows/agent-admin',
    inject: ['webServer', 'agents'],
    apply(ctx: Context) {
      const web = ctx.webServer;
      // 服务实例经 ctx 取用（同一 ctx 内 agents 行已 active——inject 声明保证）
      const agents = (ctx as unknown as { agents: AgentsEditFace }).agents;

      web.registerRpc('agents/get-config', (params) => ({
        config: requireAgent(agents, reqStr(obj(params), 'agentId')),
      }));

      web.registerRpc('agents/create', (params) => {
        const input = obj(obj(params).config);
        const patch = sanitizeAgentInput(input, undefined, {
          idTaken: (id) => agents.getAgent(id) !== undefined,
        });
        const config = configFromPatch(patch);
        agents.saveAgent(config);
        return { config };
      });

      web.registerRpc('agents/update-config', (params) => {
        const p = obj(params);
        const agentId = reqStr(p, 'agentId');
        const current = requireAgent(agents, agentId);
        const patch = sanitizeAgentInput(obj(p.patch), current);
        const config = applyConfigPatch(current, patch);
        const changed = changedConfigKeysOf(
          config as unknown as Record<string, unknown>,
          current as unknown as Record<string, unknown>,
        );
        // 零变更不落盘（时间戳/排列抖动不写盘——文件即注册的写面只记实质变更）
        if (changed.length > 0) agents.saveAgent(config);
        return { config, changed };
      });

      web.registerRpc('agents/delete', (params) => ({
        removed: agents.removeAgent(reqStr(obj(params), 'agentId')),
      }));

      web.registerRpc('agents/save-doc', (params) => {
        const p = obj(params);
        const agentId = reqStr(p, 'agentId');
        const name = reqStr(p, 'name');
        const content = typeof p.content === 'string' ? p.content : '';
        // 空内容 = 删（主线 writeMDFile 语义）
        if (content.trim() !== '') agents.saveDoc(agentId, name, content);
        else agents.removeDoc(agentId, name);
        return { saved: true };
      });

      web.registerRpc('agents/read-doc', (params) => {
        const p = obj(params);
        const content = agents.readDoc(reqStr(p, 'agentId'), reqStr(p, 'name'));
        return content !== undefined ? { content } : {};
      });

      // ---- 装配面（cr-552）：预览经编排面控制帧往返壳内干跑；写口宿主本地 ----

      const requirePreview = (): AdminPreviewFace => {
        if (options.adminPreview === undefined) {
          throw new Error('预览面缺席——编排面未接线（orchestrate:false 或宿主 boot 缺 adminPreview 注入）');
        }
        return options.adminPreview;
      };

      web.registerRpc('agents/system-prompt', (params) => {
        const p = obj(params);
        const agentId = reqStr(p, 'agentId');
        requireAgent(agents, agentId); // 读档在场性先验（缺席 fail-loud）
        const conversationId = typeof p.conversationId === 'string' && p.conversationId !== '' ? p.conversationId : undefined;
        return requirePreview().systemPrompt(agentId, conversationId).then((systemPrompt) => ({ agentId, systemPrompt }));
      });

      web.registerRpc('agents/assembly', async (params) => {
        const agentId = reqStr(obj(params), 'agentId');
        const config = requireAgent(agents, agentId);
        const tools = await requirePreview().assemblyTools(agentId);
        // plugins 视图：宿主 pluginRegistry 安装态（可选服务——行不在集时空目录）
        const registry = ctx.get('pluginRegistry', false) as
          | { listInstalled(): Array<{ manifest: { name: string; version: string; description?: string }; permissions: unknown[] }> }
          | undefined;
        const plugins = (registry?.listInstalled() ?? []).map((p) => ({
          name: p.manifest.name,
          version: p.manifest.version,
          permissions: p.permissions,
          ...(p.manifest.description ? { description: p.manifest.description } : {}),
        }));
        return {
          assembly: {
            agentId,
            plugins,
            settings: { enabled: Object.keys(config.settings ?? {}), configs: config.settings ?? {} },
            tools: {
              include: Array.isArray(config.tools) ? config.tools : config.tools?.include ?? [],
              exclude: Array.isArray(config.tools) ? [] : config.tools?.exclude ?? [],
              enabled: tools.enabled,
              catalog: tools.tools,
            },
          },
        };
      });

      web.registerRpc('agents/assembly/update', (params) => {
        const p = obj(params);
        const agentId = reqStr(p, 'agentId');
        const current = requireAgent(agents, agentId);
        const { config, changed } = applyAssemblyPatch(current, obj(p.patch));
        // 零变更不落盘（写面只记实质变更——与 update-config 同纪律）
        if (changed.length > 0) agents.saveAgent(config);
        return { config, changed };
      });

      // ---- Agent 头像 HTTP 面（cr-588，主线 ac-web-api 三路由同形）：multipart
      // 上传 / 删除 / 静态读取——存 agents 编辑面目录（唯一写口语义沿用）----
      web.route('POST', '/api/agents/:agentId/avatar', (call) => {
        const file = (call.body as { files?: { file?: { data: Buffer; filename: string } } } | undefined)?.files?.file;
        if (file === undefined) {
          web.replyJson(call.res, 400, { error: 'multipart 字段 file 缺失' });
          return;
        }
        try {
          const saved = agents.saveAvatar(call.params.agentId, file.data, extname(file.filename));
          // version（主线 cr-82 同构）：上传即回新版本（size:mtimeMs）——前端
          // 无须重拉名册即可拼版本化 URL（与 agents/list 的 avatarVersion 同源）。
          const st = statSync(saved);
          web.replyJson(call.res, 200, { success: true, version: `${st.size}:${Math.floor(st.mtimeMs)}` });
        } catch (err) {
          web.replyJson(call.res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      web.route('DELETE', '/api/agents/:agentId/avatar', (call) => {
        web.replyJson(call.res, 200, { deleted: agents.removeAvatar(call.params.agentId) });
      });

      web.route('GET', '/api/agents/:agentId/avatar', (call) => {
        const file = agents.avatarPath(call.params.agentId);
        if (file === undefined) {
          web.replyJson(call.res, 404, { error: '无头像' });
          return;
        }
        try {
          // 缓存双形态（主线 cr-82 同构）：?v=<version> = immutable 长缓存
          //（URL 即身份）；无 v = no-cache + ETag 验证（命中 304 零字节重协商）。
          const s = statSync(file);
          const etag = `"av-${s.size}-${Math.floor(s.mtimeMs)}"`;
          if (call.query.get('v') !== null) {
            call.res.writeHead(200, {
              'content-type': avatarContentType(file),
              'cache-control': 'public, max-age=31536000, immutable',
            });
            call.res.end(readFileSync(file));
            return;
          }
          if (call.req.headers['if-none-match'] === etag) {
            call.res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            call.res.end();
            return;
          }
          call.res.writeHead(200, { 'content-type': avatarContentType(file), 'cache-control': 'no-cache', etag });
          call.res.end(readFileSync(file));
        } catch {
          web.replyJson(call.res, 404, { error: '头像读取失败' });
        }
      });
    },
  };
}
