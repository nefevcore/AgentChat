// ============================================================
// settings/useSettings.ts —— 设置面板核心状态
// 设计：展示用 effective（后端解析），编辑用 raw（差异），
//       dirty 检测基于保存快照，保存统一走 api.ts。
// ============================================================

import { ref, computed } from 'vue';
import * as api from './api';
import type { AgentToolInfo } from './api';
import { sanitizeGlobalConfig } from './schema';
import type { AgentConfigViews, TimerEntry, PluginMeta, PoolData } from './types';
import { useWebSocketStore } from '../stores/websocket';
import { WS_SEND } from '../core/events/contract';
import { fetchAgents } from '../core/api/endpoints/agents';

/** Agent 基本信息（树节点/列表用） */
export interface AgentBrief { id: string; name: string; virtual?: boolean; avatar?: string | null; tags?: string[] }

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

  // ── 当前 Agent（双视图） ──
  const agentId = ref('');
  const agentRaw = ref<Record<string, any>>({});
  const agentEffective = ref<Record<string, any>>({});
  const sysContent = ref('');
  const sysEnabled = ref(false);
  const agentContent = ref('');
  const agentEnabled = ref(false);
  const agentTimers = ref<TimerEntry[]>([]);
  const agentPlugins = ref<PluginMeta[]>([]);
  const agentSaved = ref('');
  const agentTimersSaved = ref('');

  // ── 全局扩展与工具（左右布局） ──
  const globalHooks = ref<PluginMeta[]>([]);
  const globalTools = ref<{ catalog: AgentToolInfo[]; enabled: string[]; explicit: string[] } | null>(null);

  const agentDirty = computed(() => {
    const cfgDirty = agentSaved.value !== '' && agentStateKey() !== agentSaved.value;
    const timersDirty = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
    return cfgDirty || timersDirty;
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

  /** 加载全局配置 */
  async function loadGlobal(): Promise<void> {
    try {
      const data = await api.getGlobalConfig();
      globalConfig.value = data.config ?? {};
      globalSaved.value = snapshot(globalConfig.value);
    } catch (e: any) {
      error.value = `加载全局配置失败: ${e.message}`;
    }
    // 全局扩展与工具（目录 + 默认配置入口）
    try { const h = await api.getGlobalPlugins(); globalHooks.value = h.plugins ?? []; } catch { globalHooks.value = []; }
    try {
      const g = await api.getGlobalTools();
      globalTools.value = { ...g, enabled: [] };
    } catch { globalTools.value = null; }
  }

  /** 加载 Agent 配置（双视图 + 定时任务 + 插件） */
  async function loadAgent(id: string): Promise<void> {
    agentId.value = id;
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
      const p = await api.getAgentPlugins(id);
      agentPlugins.value = p.plugins ?? [];
    } catch { /* ignore */ }
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

  /** 保存 Agent 配置；若定时任务有未保存变更则联动保存 */
  async function saveAgent(): Promise<boolean> {
    try {
      await api.saveAgentConfig(agentId.value, {
        config: agentRaw.value,
        sysContent: sysEnabled.value ? sysContent.value : '',
        agentContent: agentEnabled.value ? agentContent.value : '',
      });
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

  return {
    // 状态
    llmSchemas, searchSchemas, nsSchemas, pools, agents,
    loading, error,
    globalConfig, globalDirty,
    agentId, agentRaw, agentEffective,
    sysContent, sysEnabled, agentContent, agentEnabled,
    agentTimers, agentPlugins, agentDirty,
    globalHooks, globalTools,
    // 动作
    loadMeta, loadGlobal, loadAgent, saveGlobal, saveAgent, saveTimers,
    restartBackend, createAgent, removeAgent,
    nsValue, setNsValue,
  };
}
