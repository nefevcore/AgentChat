// ============================================================
// settings/useSettings.ts —— 设置面板核心状态
// 设计：展示用 effective（后端解析），编辑用 raw（差异），
//       dirty 检测基于保存快照，保存统一走 api.ts。
//
// P2（UI/Web 插件化）：插件域拆三块状态——
//   · agentAssembly  —— 当前 Agent 的 AssemblyView（presets/hooks/tools）
//   · pluginCatalog  —— /api/plugins/catalog 全量目录（单真相源）
//   · pluginLibrary  —— 已安装 + 暂存（P3 插件库页消费）
// 装配字段保存走 PUT /api/plugins/assembly/:agentId（归一化 + 热重载 + WS）。
// ============================================================

import { ref, computed } from 'vue';
import * as api from './api';
import { sanitizeGlobalConfig } from './schema';
import type {
  AgentConfigViews,
  TimerEntry,
  PoolData,
  AssemblyView,
  AssemblyUpdate,
  PluginCatalog,
  PluginLibrary,
  PluginPermissionsView,
} from './types';
import { useWebSocketStore } from '../stores/websocket';
import { WS_SEND, WS_EVENT } from '../core/events/contract';
import { fetchAgents } from '../core/api/endpoints/agents';

/** Agent 基本信息（树节点/列表用） */
export interface AgentBrief { id: string; name: string; virtual?: boolean; avatar?: string | null; tags?: string[] }

/** 装配字段三件套（raw.plugins 旧契约存在时用于迁移判定） */
function assemblyOf(raw: Record<string, any>): { presets: string[]; tools: string[]; hooks: Record<string, string[]>; legacy: boolean } {
  return {
    presets: Array.isArray(raw.presets) ? raw.presets.filter((x: unknown) => typeof x === 'string') : [],
    tools: Array.isArray(raw.tools) ? raw.tools.filter((x: unknown) => typeof x === 'string') : [],
    hooks: raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : {},
    legacy: Array.isArray(raw.plugins),
  };
}

export function useSettings() {
  // ── 元数据（schema / pools / agents） ──
  const llmSchemas = ref<Record<string, any[]>>({});
  const searchSchemas = ref<Record<string, any[]>>({});
  /** 命名空间 schema：key = 完整配置键（如 'tool.bash'） */
  const nsSchemas = ref<Record<string, any[]>>({});
  const pools = ref<PoolData>({ llmProviders: {}, searchProviders: {} });
  const agents = ref<AgentBrief[]>([]);
  const loading = ref(false);
  const error = ref('');

  // ── 全局配置 ──
  const globalConfig = ref<Record<string, any>>({});
  const globalSaved = ref('');
  const globalDirty = computed(() => globalSaved.value !== '' && snapshot(globalConfig.value) !== globalSaved.value);

  // ── 当前 Agent（双视图 + AssemblyView） ──
  const agentId = ref('');
  const agentRaw = ref<Record<string, any>>({});
  const agentEffective = ref<Record<string, any>>({});
  const sysContent = ref('');
  const sysEnabled = ref(false);
  const agentContent = ref('');
  const agentEnabled = ref(false);
  const agentTimers = ref<TimerEntry[]>([]);
  const agentSaved = ref('');
  const agentTimersSaved = ref('');

  // ── 插件域三块状态（P2） ──
  const agentAssembly = ref<AssemblyView | null>(null);
  const agentAssemblySaved = ref('');
  const agentAssemblyError = ref('');
  const pluginCatalog = ref<PluginCatalog | null>(null);
  const pluginLibrary = ref<PluginLibrary | null>(null);
  const pluginPermissions = ref<PluginPermissionsView | null>(null);
  /** 会话级开发插件（P3 dev 卡片 loaded 状态） */
  const sessionPlugins = ref<Awaited<ReturnType<typeof api.getSessionPlugins>>['plugins']>([]);

  const agentDirty = computed(() => {
    const cfgDirty = agentSaved.value !== '' && agentStateKey() !== agentSaved.value;
    const timersDirty = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
    return cfgDirty || timersDirty;
  });

  /** 当前 raw 中的装配字段指纹（presets/tools/hooks + 旧 plugins 标记） */
  function agentAssemblyKey(): string {
    const a = assemblyOf(agentRaw.value);
    return JSON.stringify({ presets: a.presets, tools: a.tools, hooks: a.hooks, legacy: a.legacy });
  }

  /** 装配字段是否有未保存变更（旧契约 legacy=true 由保存流程强制迁移，不算 dirty） */
  const agentAssemblyDirty = computed(() => {
    if (agentAssemblySaved.value === '') return false;
    const a = assemblyOf(agentRaw.value);
    return a.legacy ? false : agentAssemblyKey() !== agentAssemblySaved.value;
  });

  /** 全局配置快照（sanitize 后，与写盘一致） */
  function snapshot(raw: Record<string, any>): string {
    return JSON.stringify(sanitizeGlobalConfig(raw));
  }

  /** Agent 配置 + SYSTEM/AGENT 内容指纹 */
  function agentStateKey(): string {
    return JSON.stringify({
      config: agentRaw.value,
      sysEnabled: sysEnabled.value, sysContent: sysContent.value,
      agentEnabled: agentEnabled.value, agentContent: agentContent.value,
    });
  }

  // ── 加载 ──
  async function loadMeta(): Promise<void> {
    const [llmR, searchR, nsR, poolR, agentsR] = await Promise.allSettled([
      api.getLlmSchemas(),
      api.getSearchSchemas(),
      api.getNamespaceSchemas(),
      api.getPools(),
      fetchAgents(),
    ]);
    if (llmR.status === 'fulfilled') llmSchemas.value = llmR.value;
    if (searchR.status === 'fulfilled') searchSchemas.value = searchR.value;
    if (nsR.status === 'fulfilled') {
      const d = nsR.value;
      nsSchemas.value = d.namespaces ?? {};
      // 兼容旧结构：{ extensions, tools }
      if (d.tools && typeof d.tools === 'object') {
        for (const [k, v] of Object.entries(d.tools)) if (!(k in nsSchemas.value)) nsSchemas.value[`tool.${k}`] = v as any[];
      }
    }
    if (poolR.status === 'fulfilled') pools.value = poolR.value;
    if (agentsR.status === 'fulfilled') agents.value = agentsR.value.agents ?? [];
  }

  /** 插件目录 / 插件库 / 会话插件 / 权限词汇表（WS catalog.changed 后复用） */
  async function loadPluginCatalog(): Promise<void> {
    const [catR, libR, sessionR, permR] = await Promise.allSettled([
      api.getCatalog(),
      api.getLibrary(),
      api.getSessionPlugins(),
      api.getPermissions(),
    ]);
    if (catR.status === 'fulfilled') pluginCatalog.value = catR.value;
    if (libR.status === 'fulfilled') pluginLibrary.value = libR.value;
    if (sessionR.status === 'fulfilled') sessionPlugins.value = sessionR.value.plugins ?? [];
    if (permR.status === 'fulfilled') pluginPermissions.value = permR.value;
  }

  /** 加载全局配置 */
  async function loadGlobal(): Promise<void> {
    try {
      const data = await api.getGlobalConfig();
      globalConfig.value = data.config ?? {};
      globalSaved.value = snapshot(globalConfig.value);
    } catch (e: any) {
      error.value = `加载全局配置失败: ${e.message}`;
    }
    // 扩展与工具目录改走 /api/plugins/catalog（单真相源）
    try {
      await loadPluginCatalog();
    } catch {
      pluginCatalog.value = null;
    }
  }

  /** 加载 Agent 配置（双视图 + 定时任务 + 装配视图） */
  async function loadAgent(id: string): Promise<void> {
    agentId.value = id;
    agentAssembly.value = null;
    agentAssemblySaved.value = '';
    agentAssemblyError.value = '';
    try {
      const data = await api.getAgentConfig(id);
      applyAgentViews(data);
    } catch (e: any) {
      error.value = `加载 Agent 配置失败: ${e.message}`;
    }
    try {
      const t = await api.getAgentTimers(id);
      agentTimers.value = t.entries ?? [];
      agentTimersSaved.value = JSON.stringify(agentTimers.value);
    } catch { /* ignore */ }
    try {
      await loadAssembly(id);
    } catch (e: any) {
      agentAssembly.value = null;
      agentAssemblySaved.value = '';
      agentAssemblyError.value = `装配视图加载失败: ${e.message}`;
    }
  }

  function applyAgentViews(data: AgentConfigViews): void {
    agentRaw.value = data.raw ?? {};
    agentEffective.value = data.effective ?? data.raw ?? {};
    sysContent.value = data.sysContent ?? '';
    sysEnabled.value = (data.sysContent ?? '').trim().length > 0;
    agentContent.value = data.agentContent ?? '';
    agentEnabled.value = (data.agentContent ?? '').trim().length > 0;
    agentSaved.value = agentStateKey();
  }

  /** 加载 AssemblyView；新契约下把 presets/tools/hooks 同步进 raw（旧 legacy 只展示不落 raw） */
  async function loadAssembly(id: string): Promise<void> {
    const data = await api.getAssembly(id);
    agentAssembly.value = data.assembly;
    agentAssemblyError.value = '';
    syncRawFromAssembly(data.assembly);
    agentAssemblySaved.value = agentAssemblyKey();
  }

  function syncRawFromAssembly(assembly: AssemblyView): void {
    // legacy 旧契约：保持 raw.plugins 原样（保存时由后端归一化迁移）
    if (assembly.legacy?.hasPlugins) return;
    const next = { ...agentRaw.value };
    next.presets = [...assembly.presets];
    next.tools = [...assembly.tools.explicit];
    next.hooks = { ...assembly.hooks.order };
    agentRaw.value = next;
    agentSaved.value = agentStateKey();
  }

  /** WS agent.assembly.changed / plugin 事件后的刷新；本地有未保存编辑时不覆盖 raw */
  async function refreshAssembly(id: string): Promise<void> {
    if (!id) return;
    try {
      const data = await api.getAssembly(id);
      agentAssembly.value = data.assembly;
      agentAssemblyError.value = '';
      if (!agentAssemblyDirty.value) {
        syncRawFromAssembly(data.assembly);
        agentAssemblySaved.value = agentAssemblyKey();
      }
    } catch (e: any) {
      // 后端可能正在重启；已有视图时保留旧数据，无视图时给出可诊断错误
      if (!agentAssembly.value) agentAssemblyError.value = `装配视图刷新失败: ${e.message}`;
    }
  }

  // ── 保存 ──
  async function saveGlobal(): Promise<boolean> {
    // 防御：全局配置为空对象说明前端状态异常（如 HMR 重置），拒绝写盘避免覆盖后端
    if (Object.keys(globalConfig.value).length === 0) {
      error.value = '全局配置为空，已取消保存。请关闭并重新打开设置后重试';
      return false;
    }
    try {
      await api.saveGlobalConfig(globalConfig.value);
      globalSaved.value = snapshot(globalConfig.value);
      return true;
    } catch (e: any) {
      error.value = `保存失败: ${e.message}`;
      return false;
    }
  }

  /** 保存 Agent 配置；装配字段（presets/tools/hooks）单独走 PUT assembly 契约 */
  async function saveAgent(): Promise<boolean> {
    try {
      const hasAssembly = agentAssembly.value !== null;
      const legacy = agentAssembly.value?.legacy?.hasPlugins === true;
      const assemblyDirty = agentAssemblyDirty.value || legacy;
      if (hasAssembly && assemblyDirty) {
        // legacy 迁移：发空 patch，由后端按注册中心反查归一化（不能把空数组覆盖回去）
        const patch: AssemblyUpdate = legacy ? {} : {
          presets: assemblyOf(agentRaw.value).presets,
          tools: assemblyOf(agentRaw.value).tools,
          hooks: assemblyOf(agentRaw.value).hooks,
        };
        const saved = await api.saveAssembly(agentId.value, patch);
        agentAssembly.value = saved.assembly;
        // 迁移完成：删除旧 plugins 声明，并同步新契约字段到 raw
        const next = { ...agentRaw.value };
        delete next.plugins;
        next.presets = [...saved.assembly.presets];
        next.tools = [...saved.assembly.tools.explicit];
        next.hooks = { ...saved.assembly.hooks.order };
        agentRaw.value = next;
        agentAssemblySaved.value = agentAssemblyKey();
      }

      // 其余 Agent 配置仍走 /api/agents/:id/config；装配字段与旧 plugins 不重复写。
      // 后端缺少 assembly 契约（旧版本）时整包回退旧保存语义。
      const config = { ...agentRaw.value };
      if (hasAssembly) {
        delete config.presets;
        delete config.tools;
        delete config.hooks;
        delete config.plugins;
      }
      await api.saveAgentConfig(agentId.value, {
        config,
        sysContent: sysEnabled.value ? sysContent.value : '',
        agentContent: agentEnabled.value ? agentContent.value : '',
      });
      // 其他字段（如 tags）也会影响工具烘焙：刷新装配快照保证 tools.enabled 一致
      if (agentAssembly.value) await refreshAssembly(agentId.value);
      agentSaved.value = agentStateKey();
      const timersDirty = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
      if (timersDirty) {
        const ok = await saveTimers();
        if (!ok) {
          error.value = `配置已保存，但定时任务保存失败: ${error.value}`;
          return false;
        }
      }
      return true;
    } catch (e: any) {
      error.value = `保存失败: ${e.message}`;
      return false;
    }
  }

  async function saveTimers(): Promise<boolean> {
    try {
      const data = await api.saveAgentTimers(agentId.value, agentTimers.value);
      agentTimers.value = data.entries ?? [];
      agentTimersSaved.value = JSON.stringify(agentTimers.value);
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  /** 请求重启后端（WS system.restart） */
  function restartBackend(): void {
    // 通过 WS 发送；由调用方管理 restarting 状态
    useWebSocketStore().send(WS_SEND.systemRestart, {});
  }

  // ── Agent 池（创建/删除） ──
  async function createAgent(payload: { id?: string; name?: string; provider?: string; llm?: Record<string, any> }): Promise<boolean> {
    try {
      await api.createAgent(payload);
      await loadMeta();
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  async function removeAgent(agentId: string): Promise<boolean> {
    try {
      await api.deleteAgent(agentId);
      await loadMeta();
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  // ── 命名空间访问 helper ──
  function nsValue(nsKey: string, fieldKey: string): any {
    if (!nsKey) return globalConfig.value[fieldKey];
    return (globalConfig.value[nsKey] ?? {})[fieldKey];
  }
  function setNsValue(nsKey: string, fieldKey: string, value: any): void {
    if (!nsKey) { globalConfig.value[fieldKey] = value; return; }
    if (!globalConfig.value[nsKey]) globalConfig.value[nsKey] = {};
    globalConfig.value[nsKey][fieldKey] = value;
  }

  // ── WS 订阅（插件域实时刷新；由 SettingsPanel 卸载时 dispose） ──
  const ws = useWebSocketStore();
  ws.init(); // 幂等：确保设置面板独立打开时客户端已建立
  const disposePluginWs = ws.onMessage((type: string, data: any) => {
    if (type === WS_EVENT.agentAssemblyChanged) {
      if (data?.agentId && data.agentId === agentId.value) void refreshAssembly(data.agentId);
      return;
    }
    if (type === WS_EVENT.pluginCatalogChanged || type === WS_EVENT.pluginReload) {
      void loadPluginCatalog();
      // 插件目录变化会改变工具/钩子烘焙：当前 Agent 装配视图一并刷新
      if (agentId.value) void refreshAssembly(agentId.value);
    }
  });

  return {
    // 状态
    llmSchemas, searchSchemas, nsSchemas, pools, agents,
    loading, error,
    globalConfig, globalDirty,
    agentId, agentRaw, agentEffective,
    sysContent, sysEnabled, agentContent, agentEnabled,
    agentTimers, agentDirty,
    // 插件域（P2/P3）
    agentAssembly, agentAssemblyDirty, agentAssemblyError,
    pluginCatalog, pluginLibrary, pluginPermissions, sessionPlugins,
    // 动作
    loadMeta, loadGlobal, loadAgent, loadAssembly, loadPluginCatalog,
    saveGlobal, saveAgent, saveTimers,
    restartBackend, createAgent, removeAgent,
    nsValue, setNsValue,
    disposePluginWs,
  };
}
