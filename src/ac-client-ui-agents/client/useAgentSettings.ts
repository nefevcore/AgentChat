// ============================================================
// ac-client-ui-agents/client/useAgentSettings.ts —— Agent 设置节编排
//（M29 P1-3b 自 settings/useSettings 的 agent 编辑半边归域迁入）
//
// 动机（复审 F3 + M28 P2.5 遗留修复）：M28 P2.5 把 Agent 设置节迁入
// 本行时，编辑编排仍留 settings 的 useSettings——每 useSettings() 调用
// 是独立闭包，节宿主实例无人 loadMeta/saveAll 断链（列表空/编辑不可
// 保存的静默回归）。归域后本 composable 自足：agent CRUD（rosterApi
// 同宿）+ 装配视图 + schemas/pools 元数据（settings api 经 domain→base
// 合法向取用）+ wire 热刷新，全部自理。
// ============================================================
import { ref, computed } from 'vue';
import type { AgentConfigViews, TimerEntry, AssemblyData, AssemblyPatch } from 'ac-client-ui-settings/client/types.ts';
import { getAssembly, saveAssembly, getLlmSchemas, getSearchSchemas, getPools } from 'ac-client-ui-settings/client/api.ts';
import { fetchAgents, createAgent as createAgentRpc } from './index.ts';
import { deleteAgent as deleteAgentRpc, getAgentConfig, saveAgentConfig } from './rosterApi.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';

export type { LlmProviderStat } from './index.ts';

/** 定时任务数据面注入口（M29 P1-3c：timerApi 归 ui-timer——本包 .ts 不直连
 *  domain 行数据面〔R6〕，由宿主 .vue 注入 ui-timer 的 timerApi） */
export interface AgentTimerFace {
  getAgentTimers(agentId: string, rpc: { call: unknown }): Promise<{ entries: TimerEntry[] }>;
  saveAgentTimers(agentId: string, entries: TimerEntry[], rpc: { call: unknown }): Promise<{ entries: TimerEntry[] }>;
}

/** Agent 基本信息（树节点/列表用——settings useSettings 旧词汇原样） */
export interface AgentBrief { id: string; name: string; virtual?: boolean; avatar?: string | null; tags?: string[] }

function strArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function toolOverridesOf(v: unknown): { include: string[]; exclude: string[] } {
  if (Array.isArray(v)) return { include: strArrayOf(v), exclude: [] };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return {
      include: strArrayOf((v as Record<string, any>).include),
      exclude: strArrayOf((v as Record<string, any>).exclude),
    };
  }
  return { include: [], exclude: [] };
}
function settingsConfigsOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}
function assemblyOf(raw: Record<string, any>): {
  tools: { include: string[]; exclude: string[] };
  settings: Record<string, unknown>;
} {
  return {
    tools: toolOverridesOf(raw.tools),
    settings: settingsConfigsOf(raw.settings),
  };
}

export function useAgentSettings(timerApi: AgentTimerFace) {
  // ── 元数据（schemas / pools——AgentPane 模型页签数据源） ──
  const llmSchemas = ref<Record<string, any[]>>({});
  const searchSchemas = ref<Record<string, any[]>>({});
  const pools = ref<{ llmProviders: Record<string, any>; searchProviders: Record<string, any> }>({ llmProviders: {}, searchProviders: {} });
  const agents = ref<AgentBrief[]>([]);
  const loading = ref(false);
  const error = ref('');

  // ── 当前 Agent（双视图 + 装配视图 + 定时任务） ──
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
  const agentAssembly = ref<AssemblyData | null>(null);
  const agentAssemblySaved = ref('');
  const agentAssemblyError = ref('');

  const agentDirty = computed(() => {
    const cfgDirty = agentSaved.value !== '' && agentStateKey() !== agentSaved.value;
    const timersDirty = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
    return cfgDirty || timersDirty;
  });

  function agentAssemblyKey(): string {
    const a = assemblyOf(agentRaw.value);
    return JSON.stringify({ tools: a.tools, settings: a.settings });
  }

  const agentAssemblyDirty = computed(() => {
    if (agentAssemblySaved.value === '') return false;
    return agentAssemblyKey() !== agentAssemblySaved.value;
  });

  function agentStateKey(): string {
    return JSON.stringify({
      config: agentRaw.value,
      sysEnabled: sysEnabled.value, sysContent: sysContent.value,
      agentEnabled: agentEnabled.value, agentContent: agentContent.value,
    });
  }

  // ── 加载 ──
  async function loadMeta(): Promise<void> {
    loading.value = true;
    try {
      const [llmR, searchR, poolR, agentsR] = await Promise.allSettled([
        getLlmSchemas(),
        getSearchSchemas(),
        getPools(),
        fetchAgents(defaultRpc),
      ]);
      if (llmR.status === 'fulfilled') llmSchemas.value = llmR.value;
      if (searchR.status === 'fulfilled') searchSchemas.value = searchR.value;
      if (poolR.status === 'fulfilled') pools.value = poolR.value;
      if (agentsR.status === 'fulfilled') agents.value = agentsR.value.agents ?? [];
      const failed = [llmR, searchR, poolR, agentsR].filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length > 0) {
        error.value = `部分元数据加载失败（${failed.length}/4 项）：${failed.map(f => f.reason?.message ?? String(f.reason)).join('; ')}`;
      }
    } finally {
      loading.value = false;
    }
  }

  /** 加载 Agent 配置（双视图 + 定时任务 + 装配视图）。
   *  竞态守卫：快速切换 Agent 时在途请求的晚到响应会覆盖新 Agent 的数据
   *  （A 的配置显示到 B，dirty 基线错乱）——按请求序号丢弃过期响应。 */
  let agentLoadSeq = 0;
  async function loadAgent(id: string): Promise<void> {
    const seq = ++agentLoadSeq;
    agentId.value = id;
    agentAssembly.value = null;
    agentAssemblySaved.value = '';
    agentAssemblyError.value = '';
    try {
      const data = await getAgentConfig(id, defaultRpc);
      if (seq !== agentLoadSeq) return; // 已切走：丢弃过期响应
      applyAgentViews(data);
    } catch (e: any) {
      if (seq !== agentLoadSeq) return;
      error.value = `加载 Agent 配置失败: ${e.message}`;
    }
    try {
      const t = await timerApi.getAgentTimers(id, defaultRpc);
      if (seq !== agentLoadSeq) return;
      agentTimers.value = t.entries ?? [];
      agentTimersSaved.value = JSON.stringify(agentTimers.value);
    } catch { /* ignore */ }
    try {
      await loadAssembly(id, seq);
    } catch (e: any) {
      if (seq !== agentLoadSeq) return;
      agentAssembly.value = null;
      agentAssemblySaved.value = '';
      agentAssemblyError.value = `装配视图加载失败: ${e.message}`;
    }
  }

  function applyAgentViews(data: AgentConfigViews): void {
    agentRaw.value = normalizeLegacyTags(data.raw ?? {});
    agentEffective.value = normalizeLegacyTags(data.effective ?? data.raw ?? {});
    sysContent.value = data.sysContent ?? '';
    sysEnabled.value = (data.sysContent ?? '').trim().length > 0;
    agentContent.value = data.agentContent ?? '';
    agentEnabled.value = (data.agentContent ?? '').trim().length > 0;
    agentSaved.value = agentStateKey();
  }

  /** 旧能力标签归一：agent → base、conductor → delegation（只归一化内存 raw；写盘时由后端保存） */
  function normalizeLegacyTags(raw: Record<string, any>): Record<string, any> {
    if (!Array.isArray(raw.tags)) return raw;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const tag of raw.tags) {
      const canonical = tag === 'agent' ? 'base' : tag === 'conductor' ? 'delegation' : tag;
      if (!seen.has(canonical)) { seen.add(canonical); tags.push(canonical); }
    }
    return JSON.stringify(tags) === JSON.stringify(raw.tags) ? raw : { ...raw, tags };
  }

  /** 加载装配视图（agents/assembly）；把 tools/settings 同步进 raw。 */
  async function loadAssembly(id: string, seq?: number): Promise<void> {
    const guard = seq ?? agentLoadSeq;
    const data = await getAssembly(id);
    if (guard !== agentLoadSeq) return; // 已切走：丢弃过期响应
    agentAssembly.value = data.assembly;
    agentAssemblyError.value = '';
    syncRawFromAssembly(data.assembly);
    agentAssemblySaved.value = agentAssemblyKey();
  }

  function syncRawFromAssembly(assembly: AssemblyData): void {
    const next = { ...agentRaw.value };
    next.tools = { include: [...assembly.tools.include], exclude: [...assembly.tools.exclude] };
    next.settings = { ...assembly.settings.configs };
    agentRaw.value = next;
    agentSaved.value = agentStateKey();
  }

  /** WS agent.assembly.changed / plugin 事件后的刷新；本地有未保存编辑时不覆盖 raw */
  async function refreshAssembly(id: string): Promise<void> {
    if (!id) return;
    try {
      const data = await getAssembly(id);
      if (id !== agentId.value) return; // 已切走：丢弃过期响应
      agentAssembly.value = data.assembly;
      agentAssemblyError.value = '';
      if (!agentAssemblyDirty.value) {
        syncRawFromAssembly(data.assembly);
        agentAssemblySaved.value = agentAssemblyKey();
      }
      // 注意：本地有装配编辑时只更新视图，**不**前移 agentAssemblySaved——
      // 否则后端热重载事件会把"未保存的编辑"基线化，dirty 检测失效、编辑静默丢失。
    } catch (e: any) {
      // 后端可能正在重启；已有视图时保留旧数据，无视图时给出可诊断错误
      if (!agentAssembly.value) agentAssemblyError.value = `装配视图刷新失败: ${e.message}`;
    }
  }

  // ── 保存 ──
  /** 保存 Agent 配置；装配字段（tools/settings）单独走 assembly 契约。
   *  身份快照：进入即固定目标 agentId 与数据快照——保存进行中用户切换 Agent 时，
   *  后续 await 恢复后重读 agentId.value 会把 A 的配置写给 B（数据损坏级串台）。 */
  async function saveAgent(): Promise<boolean> {
    const targetId = agentId.value;
    const rawSnapshot = agentRaw.value;
    const sysSnap = sysEnabled.value ? sysContent.value : '';
    const agentSnap = agentEnabled.value ? agentContent.value : '';
    const timersSnapshot = [...agentTimers.value];
    const timersDirtyOnEntry = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
    try {
      const hasAssembly = agentAssembly.value !== null;
      if (hasAssembly && agentAssemblyDirty.value) {
        const a = assemblyOf(rawSnapshot);
        // settings per-name 浅合并（服务端语义——M22 D5）：全量快照幂等，
        // 既有未编辑字段原样回写（值不变 = 合并无操作）。
        const patch: AssemblyPatch = {
          tools: { include: a.tools.include, exclude: a.tools.exclude },
          settings: a.settings as Record<string, Record<string, unknown> | null>,
        };
        const saved = await saveAssembly(targetId, patch);
        if (targetId !== agentId.value) return false; // 保存期间已切走：不回写他人状态
        agentAssembly.value = saved.assembly;
        const next = { ...agentRaw.value };
        next.tools = { include: [...saved.assembly.tools.include], exclude: [...saved.assembly.tools.exclude] };
        next.settings = { ...saved.assembly.settings.configs };
        agentRaw.value = next;
        agentAssemblySaved.value = agentAssemblyKey();
      }

      // 其余 Agent 配置仍走 agents/update-config；装配字段不重复写。
      const config = { ...rawSnapshot };
      if (hasAssembly) {
        delete config.presets;
        delete config.tools;
        delete config.settings;
        delete config.disabledTools;
        delete config.disabledSettings;
        delete config.plugins;
      }
      await saveAgentConfig(targetId, {
        config,
        sysContent: sysSnap,
        agentContent: agentSnap,
      }, defaultRpc);
      if (targetId !== agentId.value) return false; // 保存期间已切走：不回写他人基线
      // 其他字段（如 tags）也会影响工具烘焙：刷新装配快照保证 tools.enabled 一致
      if (agentAssembly.value) await refreshAssembly(targetId);
      agentSaved.value = agentStateKey();
      if (timersDirtyOnEntry) {
        const ok = await saveTimersFor(targetId, timersSnapshot);
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
    return saveTimersFor(agentId.value, agentTimers.value);
  }

  /** 保存定时任务（身份快照版：saveAgent 携带进入时的目标与数据调用）。
   *  回包仅在"本地未继续编辑"时应用——保存 in-flight 期间用户又动了条目的话，
   *  服务端回显会把新编辑冲掉（丢失更新）。 */
  async function saveTimersFor(targetId: string, entries: TimerEntry[]): Promise<boolean> {
    const sentSnapshot = JSON.stringify(entries);
    try {
      const data = await timerApi.saveAgentTimers(targetId, entries, defaultRpc);
      if (targetId !== agentId.value) return true; // 已切走：成功但不回写他人状态
      if (JSON.stringify(agentTimers.value) === sentSnapshot) {
        agentTimers.value = data.entries ?? [];
      }
      agentTimersSaved.value = JSON.stringify(agentTimers.value);
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  // ── Agent 池（创建/删除——agent CRUD 单宿主 rosterApi/index 同包直连） ──
  async function createAgent(payload: { id?: string; name?: string; provider?: string; llm?: Record<string, any> }): Promise<boolean> {
    try {
      await createAgentRpc(payload, defaultRpc);
      await loadMeta();
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  async function removeAgent(id: string): Promise<boolean> {
    try {
      await deleteAgentRpc(id, defaultRpc);
      await loadMeta();
      return true;
    } catch (e: any) {
      error.value = e.message;
      return false;
    }
  }

  /** 重置 Agent 编辑态（节宿主卸载/面板关闭时调用——「已放弃」的编辑不复活）。 */
  function resetAgent(): void {
    agentLoadSeq++; // 使在途 loadAgent 响应全部过期
    agentId.value = '';
    agentRaw.value = {};
    agentEffective.value = {};
    sysContent.value = '';
    sysEnabled.value = false;
    agentContent.value = '';
    agentEnabled.value = false;
    agentTimers.value = [];
    agentSaved.value = '';
    agentTimersSaved.value = '';
    agentAssembly.value = null;
    agentAssemblySaved.value = '';
    agentAssemblyError.value = '';
  }

  // ── wire 订阅（装配热刷新；宿主卸载时 dispose） ──
  const disposeWs = defaultRpc.onEvent((type: string, args: unknown[]) => {
    if (type === 'agents/updated') {
      const cfg = args[0] as { id?: string } | undefined;
      if (cfg?.id && cfg.id === agentId.value) void refreshAssembly(cfg.id);
      return;
    }
    if (type === 'plugin/installed' || type === 'plugin/catalog-changed' || type === 'plugin/reloaded') {
      // 插件目录变化会改变工具/钩子烘焙：当前 Agent 装配视图刷新
      if (agentId.value) void refreshAssembly(agentId.value);
    }
  });

  return {
    // 状态
    llmSchemas, searchSchemas, pools, agents,
    loading, error,
    agentId, agentRaw, agentEffective,
    sysContent, sysEnabled, agentContent, agentEnabled,
    agentTimers, agentDirty,
    agentAssembly, agentAssemblyDirty, agentAssemblyError,
    // 动作
    loadMeta, loadAgent, loadAssembly,
    saveAgent, saveTimers, resetAgent,
    createAgent, removeAgent,
    disposeWs,
  };
}
