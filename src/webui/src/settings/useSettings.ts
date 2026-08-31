// ============================================================
// settings/useSettings.ts —— 设置面板核心状态
// 设计：展示用 effective（后端解析），编辑用 raw（差异），
//       dirty 检测基于保存快照，保存统一走 api.ts。
//
// P2（UI/Web 插件化）：插件域拆三块状态——
//   · agentAssembly  —— 当前 Agent 的装配视图（agents/assembly 直连形状）
//   · pluginCatalog  —— 插件/工具目录全量（单真相源）
//   · pluginLibrary  —— 已安装 + 暂存（P3 插件库页消费）
// 装配字段保存走 agents/assembly/update（归一化 + 热重载 + WS）。
// ============================================================

import { ref, computed } from 'vue';
import * as api from './api';
import { sanitizeGlobalConfig } from './schema';
import type {
  AgentConfigViews,
  TimerEntry,
  PoolData,
  AssemblyData,
  AssemblyPatch,
  PluginCatalog,
  PluginLibrary,
  PluginPermissionsView,
  EventChainEntry,
} from './types';
import { wireRpc } from '../api/wire';
import { fetchAgents } from '../api/roster';

/** Agent 基本信息（树节点/列表用） */
export interface AgentBrief { id: string; name: string; virtual?: boolean; avatar?: string | null; tags?: string[] }

/** 装配字段（tools:{include,exclude} / settings=具名设置对象——M22 P2 起直连
 *  preview 形状；presets 已删除（B1/ADR-4），legacy 通道已删除（B7）。 */
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

  // ── 当前 Agent（双视图 + 装配视图） ──
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
  const agentAssembly = ref<AssemblyData | null>(null);
  const agentAssemblySaved = ref('');
  const agentAssemblyError = ref('');
  const pluginCatalog = ref<PluginCatalog | null>(null);
  const pluginLibrary = ref<PluginLibrary | null>(null);
  const pluginPermissions = ref<PluginPermissionsView | null>(null);
  /** 目录信息架构（M24 P3/P4：plugin/catalog 两分组 + 待审并入） */
  const pluginCatalogData = ref<Awaited<ReturnType<typeof api.getPluginCatalog>> | null>(null);
  /** 目录信息架构装载失败（2026-08-30 事故：行停用级联下线 ac-web-api 时
   *  RPC 面消失——失败必须呈现为错误而非静默空清单，并给出手工急救路径） */
  const pluginCatalogError = ref('');
  /** 会话级开发插件（P3 dev 卡片 loaded 状态） */
  const sessionPlugins = ref<Awaited<ReturnType<typeof api.getSessionPlugins>>['plugins']>([]);
  /** 事件执行链（M23 P4：events/listeners；插件装载/卸载后随目录刷新） */
  const eventChains = ref<EventChainEntry[]>([]);
  /** 事件描述声明 × 执行链交叉（M25 P2：events/descriptions） */
  const eventDescriptions = ref<Awaited<ReturnType<typeof api.getEventDescriptions>>['descriptions']>([]);
  const eventChainsByEvent = ref<Awaited<ReturnType<typeof api.getEventDescriptions>>['chains']>({});
  /** 治理停用集（M25 P2：events/policy-list） */
  const eventPolicy = ref<Awaited<ReturnType<typeof api.getEventPolicy>>>({ disabled: [], live: [] });

  const agentDirty = computed(() => {
    const cfgDirty = agentSaved.value !== '' && agentStateKey() !== agentSaved.value;
    const timersDirty = agentTimersSaved.value !== '' && JSON.stringify(agentTimers.value) !== agentTimersSaved.value;
    return cfgDirty || timersDirty;
  });

  /** 当前 raw 中的装配字段指纹（tools{include,exclude}/settings） */
  function agentAssemblyKey(): string {
    const a = assemblyOf(agentRaw.value);
    return JSON.stringify({ tools: a.tools, settings: a.settings });
  }

  /** 装配字段是否有未保存变更 */
  const agentAssemblyDirty = computed(() => {
    if (agentAssemblySaved.value === '') return false;
    return agentAssemblyKey() !== agentAssemblySaved.value;
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
    // 静默失败此前出空 UI 无任何报错（provider 下拉空、表单"无配置项"）——聚合提示
    const failed = [llmR, searchR, nsR, poolR, agentsR].filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length > 0) {
      error.value = `部分元数据加载失败（${failed.length}/5 项）：${failed.map(f => f.reason?.message ?? String(f.reason)).join('; ')}`;
    }
  }

  /** 插件目录 / 插件库 / 会话插件 / 权限词汇表（WS catalog.changed 后复用）。
   *  并发守卫：WS 事件风暴（install/reload 连发）时多个在途请求乱序返回，
   *  旧响应最后落地会把新目录回退——只接受最新一次调用发起的响应。 */
  let catalogSeq = 0;
  async function loadPluginCatalog(): Promise<void> {
    const seq = ++catalogSeq;
    const [catR, libR, sessionR, permR, eventsR, catalogR, descR, policyR] = await Promise.allSettled([
      api.getCatalog(),
      api.getLibrary(),
      api.getSessionPlugins(),
      api.getPermissions(),
      // 事件执行链（M23 P4）：装载/卸载会改变监听器序——随目录一并刷新；
      // 旧后端无此面 → 容忍为空数组
      api.getEventListeners(),
      // 目录信息架构（M24 P3）：旧后端无此面 → 容忍为空
      api.getPluginCatalog(),
      // 事件描述声明 × 执行链交叉（M25 P2）：旧后端无此面 → 容忍为空
      api.getEventDescriptions(),
      // 治理停用集（M25 P2）：行未装载 → 空呈现
      api.getEventPolicy(),
    ]);
    if (seq !== catalogSeq) return;
    if (catR.status === 'fulfilled') pluginCatalog.value = catR.value;
    if (libR.status === 'fulfilled') pluginLibrary.value = libR.value;
    if (sessionR.status === 'fulfilled') sessionPlugins.value = sessionR.value.plugins ?? [];
    if (permR.status === 'fulfilled') pluginPermissions.value = permR.value;
    if (eventsR.status === 'fulfilled') eventChains.value = eventsR.value.events ?? [];
    if (catalogR.status === 'fulfilled') {
      pluginCatalogData.value = catalogR.value;
      pluginCatalogError.value = '';
    } else {
      pluginCatalogData.value = null;
      pluginCatalogError.value = catalogR.reason instanceof Error ? catalogR.reason.message : String(catalogR.reason);
    }
    if (descR.status === 'fulfilled') {
      eventDescriptions.value = descR.value.descriptions ?? [];
      eventChainsByEvent.value = descR.value.chains ?? {};
    }
    if (policyR.status === 'fulfilled') eventPolicy.value = policyR.value;
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
      const data = await api.getAgentConfig(id);
      if (seq !== agentLoadSeq) return; // 已切走：丢弃过期响应
      applyAgentViews(data);
    } catch (e: any) {
      if (seq !== agentLoadSeq) return;
      error.value = `加载 Agent 配置失败: ${e.message}`;
    }
    try {
      const t = await api.getAgentTimers(id);
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

  /** 旧能力标签 agent → base（只归一化内存 raw；写盘时由后端保存） */
  function normalizeLegacyTags(raw: Record<string, any>): Record<string, any> {
    if (!Array.isArray(raw.tags)) return raw;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const tag of raw.tags) {
      const canonical = tag === 'agent' ? 'base' : tag;
      if (!seen.has(canonical)) { seen.add(canonical); tags.push(canonical); }
    }
    return JSON.stringify(tags) === JSON.stringify(raw.tags) ? raw : { ...raw, tags };
  }

  /** 加载装配视图（agents/assembly）；把 tools/settings 同步进 raw。 */
  async function loadAssembly(id: string, seq?: number): Promise<void> {
    const guard = seq ?? agentLoadSeq;
    const data = await api.getAssembly(id);
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
      const data = await api.getAssembly(id);
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
  async function saveGlobal(): Promise<boolean> {
    // 防御：全局配置为空对象说明前端状态异常（如 HMR 重置），拒绝写盘避免覆盖后端
    if (Object.keys(globalConfig.value).length === 0) {
      error.value = '全局配置为空，已取消保存。请关闭并重新打开设置后重试';
      return false;
    }
    try {
      // sanitize 后再写盘：llm $ref 折叠（防 GET 展开对象回写冻结池引用）、
      // 掩码 api_key 清理（此前仅快照用 sanitize，写盘是原始对象——接线遗漏）
      await api.saveGlobalConfig(sanitizeGlobalConfig(globalConfig.value));
      globalSaved.value = snapshot(globalConfig.value);
      return true;
    } catch (e: any) {
      error.value = `保存失败: ${e.message}`;
      return false;
    }
  }

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
        const saved = await api.saveAssembly(targetId, patch);
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
      await api.saveAgentConfig(targetId, {
        config,
        sysContent: sysSnap,
        agentContent: agentSnap,
      });
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
      const data = await api.saveAgentTimers(targetId, entries);
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

  /** 请求重启后端（Port B：system/restart RPC；调用方管理 restarting 状态） */
  function restartBackend(): void {
    void wireRpc.call('system/restart').catch(() => undefined);
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

  /** 重置 Agent 编辑态（面板关闭时调用）。
   *  面板常驻挂载（外层 Transition 控制可见性），关闭时若不清理，"已放弃"的
   *  编辑会在重开同一 Agent 时复活（openAgentEditor 同 id 不重载）且可被误保存。 */
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

  // ── wire 订阅（插件域实时刷新；由 SettingsPanel 卸载时 dispose） ──
  // Port B 词汇：装配/档案变更 = agents/updated（写口 emit）；插件目录 = plugin/*
  const disposePluginWs = wireRpc.onWireEvent((type: string, args: unknown[]) => {
    if (type === 'agents/updated') {
      const cfg = args[0] as { id?: string } | undefined;
      if (cfg?.id && cfg.id === agentId.value) void refreshAssembly(cfg.id);
      return;
    }
    if (type === 'plugin/installed' || type === 'plugin/catalog-changed' || type === 'plugin/reloaded') {
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
    eventChains,
    pluginCatalogData,
    pluginCatalogError,
    eventDescriptions, eventChainsByEvent, eventPolicy,
    // 动作
    loadMeta, loadGlobal, loadAgent, loadAssembly, loadPluginCatalog,
    saveGlobal, saveAgent, saveTimers, resetAgent,
    restartBackend, createAgent, removeAgent,
    nsValue, setNsValue,
    disposePluginWs,
  };
}

