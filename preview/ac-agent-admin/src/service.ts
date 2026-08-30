// ============================================================
// ac-agent-admin/src/service.ts —— Agent 管理面服务（ctx.agentAdmin）
//
// src AgentService（host/server/agent-service.ts）的 preview 首期
// （M7 §二D，src agent-service.ts ~350 行的 owning 化收编）：
//
//   · CRUD 写路径：sanitize（白名单 + 凭据剥离）→ deepMerge 局部补丁 →
//     agentStore.saveAgent（唯一写口，ADR-5）→ agents.reassign 热生效
//     （M15 勘误 #1 归属语义：覆盖注册不挂 fiber；agents/updated 事件
//     由 reassign emit——"写后触发"即热重载，无需整目录重扫）
//   · 凭据剥离：输入 apiKey → ctx.credentials.set（Agent 级，空串=删），
//     绝不落 config.json（src saveAgentConfig 的 llm.api_key 语义）
//   · 字段白名单（src GLOBAL_ONLY_KEYS 的 preview 形态）：各域已
//     owning 化，未知键直接拒绝（fail-closed）而非静默剔除——
//     白名单 = AgentConfig 字段集 + 凭据侧信道 apiKey
//   · diff 保存：ac-config-merge 首个消费者——deepMerge(现值, 补丁)
//     合成新档、computeDiff(新档, 现值) 报告变更键（返回给 UI/事件）
//   · 文档写口：agentStore.saveDoc（空内容 = 删，src writeMDFile 语义）
//   · system-prompt dry-run：loop/before-run waterfall 以干跑请求过链
//     （persona/system-prompt/memory 等全部组装器生效；无 run 副作用）
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { computeDiff, deepMerge } from 'ac-config-merge';
import { assertAgentId, resolveToolNames, type AgentConfig } from 'ac-agents';
import type { LoopRunCall, LoopRunRequest, LoopRunResult } from 'ac-agent-loop';

/** AgentConfig 字段白名单（GLOBAL_ONLY_KEYS 的 preview fail-closed 形态） */
const ALLOWED_FIELDS = new Set([
  'id',
  'model',
  'provider',
  'virtual',
  'system',
  'tools',
  'llmParams',
  'maxSteps',
  'description',
  'tags',
  'settings',
  // 凭据侧信道（剥离进 ctx.credentials，不进 config.json）
  'apiKey',
]);

/** updateAgent 返回 */
export interface AdminUpdateResult {
  config: AgentConfig;
  /** 实际发生变化的顶层键（computeDiff 新旧档） */
  changed: string[];
}

export class AgentAdminService extends Service {
  /** 构造期/闭包要访问的域服务（M12 铁律 #1；tools = 生效集解析） */
  static inject = ['agents', 'agentStore', 'credentials', 'tools'];

  constructor(ctx: Context) {
    super(ctx, 'agentAdmin');
  }

  /** 读 Agent 档案（store 优先——盘上是事实；回退注册表——行注册的预设） */
  getAgent(agentId: string): AgentConfig {
    const config = this.ctx.agentStore.getAgent(agentId) ?? this.ctx.agents.get(agentId);
    if (!config) throw new Error(`unknown agent: ${agentId}`);
    return config;
  }

  /**
   * 创建 Agent：sanitize → 落盘 → reassign（数据驱动注册，生命周期 =
   * 持久化配置）。model 与 virtual 至少其一（运行时投递侧会再校验）。
   */
  createAgent(input: Record<string, unknown>): AgentConfig {
    const { config } = this.sanitize(input, undefined);
    if (!config.model && !config.virtual) {
      throw new Error('创建 Agent 需 model（或显式 virtual: true）');
    }
    this.ctx.agentStore.saveAgent(config);
    this.ctx.agents.reassign(config); // emit agents/updated
    return config;
  }

  /**
   * 更新 Agent（局部补丁）：deepMerge(现值, 补丁) → 落盘 → reassign。
   * 返回合成档 + 变更键清单（computeDiff）。未知键 fail-closed。
   */
  updateAgent(agentId: string, patch: Record<string, unknown>): AdminUpdateResult {
    const current = this.getAgent(agentId);
    const { config } = this.sanitize(patch, current);
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      config as unknown as Record<string, unknown>,
    ) as unknown as AgentConfig;
    // computeDiff 恒保留身份键（id）——变更报告滤之（身份永不"变"）
    const changed = Object.keys(
      computeDiff(merged as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>),
    ).filter((k) => k !== 'id');
    if (changed.length > 0) {
      this.ctx.agentStore.saveAgent(merged);
      this.ctx.agents.reassign(merged); // emit agents/updated
    }
    return { config: merged, changed };
  }

  /**
   * 删除 Agent：数据目录（含 entries/docs）+ 注册表条目。
   * 会话文件归 ac-session 不在此列（审计可回溯）。
   */
  deleteAgent(agentId: string): boolean {
    const removedDir = this.ctx.agentStore.removeAgent(agentId);
    const removedRegistry = this.ctx.agents.remove(agentId); // emit agents/updated (removed)
    return removedDir || removedRegistry;
  }

  /** 存 Agent 级凭据（value 空串 = 删；不落 config.json） */
  setCredential(agentId: string, provider: string, value: string): void {
    this.ctx.credentials.set(agentId, provider, value);
  }

  /** 写文档（空内容 = 删；agentStore 唯一写口） */
  saveDoc(agentId: string, name: string, content: string): void {
    if (content.trim()) {
      this.ctx.agentStore.saveDoc(agentId, name, content);
    } else {
      this.ctx.agentStore.removeDoc(agentId, name);
    }
  }

  /** 读文档（缺失 → undefined） */
  readDoc(agentId: string, name: string): string | undefined {
    return this.ctx.agentStore.readDoc(agentId, name);
  }

  // ============================================================
  // 装配视图（M17-A；src AssemblyView 的 preview 收编）
  // src presets（插件启用清单）在 preview 无对应（行组合决定装载，
  // ADR-4）；settings 目录 = 已装载插件清单 + AgentConfig.settings[具名]；
  // tools = include/exclude 意图 + 全量目录 + 生效集合。
  // ============================================================

  /** 已装载插件摘要（pluginRegistry 可选能力——未装载行时目录为空） */
  private loadedPlugins(): Array<{
    name: string;
    version: string;
    permissions: string[];
    description?: string;
  }> {
    const registry = this.ctx.get('pluginRegistry') as
      | {
          listLoaded(): Array<{
            name: string;
            manifest: { version: string; description?: string };
            allowedPermissions: string[];
          }>;
        }
      | undefined;
    return (registry?.listLoaded() ?? []).map((p) => ({
      name: p.name,
      version: p.manifest.version,
      permissions: p.allowedPermissions,
      ...(p.manifest.description ? { description: p.manifest.description } : {}),
    }));
  }

  /** 装配视图（ExtToolsPane 数据源） */
  assemblyView(agentId: string): Record<string, unknown> {
    const config = this.getAgent(agentId);
    const allTools = this.ctx.tools.list();
    const names = allTools.map((t) => t.name);
    const tools = config.tools;
    return {
      agentId,
      plugins: this.loadedPlugins(),
      settings: { enabled: Object.keys(config.settings ?? {}), configs: config.settings ?? {} },
      tools: {
        include: Array.isArray(tools) ? tools : tools?.include ?? [],
        exclude: Array.isArray(tools) ? [] : tools?.exclude ?? [],
        enabled: resolveToolNames(tools, names) ?? names,
        catalog: allTools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? {},
          ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
        })),
      },
    };
  }

  /** 装配写口（tools 意图 + settings 具名配置；patch 白名单 fail-closed） */
  updateAssembly(
    agentId: string,
    patch: Record<string, unknown>,
  ): { config: AgentConfig; changed: string[] } {
    const unknown = Object.keys(patch).filter((k) => k !== 'tools' && k !== 'settings');
    if (unknown.length > 0) throw new Error(`装配补丁字段不在白名单: ${unknown.join(', ')}`);
    const current = this.getAgent(agentId);
    const next: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
    let changed: string[] = [];

    if (patch.tools !== undefined) {
      const t = objOf(patch.tools);
      const include = t.include === undefined ? undefined : strArray(t.include, 'tools.include');
      const exclude = t.exclude === undefined ? undefined : strArray(t.exclude, 'tools.exclude');
      if (include === undefined && exclude === undefined) {
        delete next.tools; // 全空意图 = 恢复缺省（全部工具）
      } else {
        next.tools = {
          ...(include !== undefined && include.length > 0 ? { include } : {}),
          ...(exclude !== undefined && exclude.length > 0 ? { exclude } : {}),
        };
        if (Object.keys(next.tools as Record<string, unknown>).length === 0) delete next.tools;
      }
    }
    if (patch.settings !== undefined) {
      const settings = objOf(patch.settings);
      // per-name 合并语义（M22 D5）：
      //   · object = 浅合并进既有 settings[name]（{enabled:false} 只动
      //     enabled，既有 maxTokens/whitelist 等字段不动）——消除前端
      //     read-modify-write 竞态；
      //   · null = 删除该 name 配置。
      const currentSettings =
        next.settings && typeof next.settings === 'object' && !Array.isArray(next.settings)
          ? (next.settings as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = { ...currentSettings };
      for (const [name, value] of Object.entries(settings)) {
        if (value === undefined) continue; // 未携带 = 不动（JSON 序列化后不存在）
        if (value === null) {
          delete merged[name];
          continue;
        }
        const prev = merged[name];
        const base =
          prev && typeof prev === 'object' && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {}; // 旧非对象形状（如 persona string）= 整体替换
        merged[name] = { ...base, ...objOf(value) };
      }
      if (Object.keys(merged).length > 0) next.settings = merged;
      else delete next.settings;
    }

    // 变更检测：computeDiff 只从 subject 侧比较，检测不到【键删除】（null
    // 删除 settings[name] 后 subject 少键 → subDiff 恒空）——patch 触及的字段
    // 用直接比对兜底（settings/tools 键序稳定：next 继承 current 的键序）。
    changed = Object.keys(
      computeDiff(next, current as unknown as Record<string, unknown>),
    ).filter((k) => k !== 'id');
    const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (patch.settings !== undefined && !changed.includes('settings') && !jsonEq(next.settings, current.settings)) {
      changed.push('settings');
    }
    if (patch.tools !== undefined && !changed.includes('tools') && !jsonEq(next.tools, current.tools)) {
      changed.push('tools');
    }
    if (changed.length > 0) {
      this.ctx.agentStore.saveAgent(next as unknown as AgentConfig);
      this.ctx.agents.reassign(next as unknown as AgentConfig);
    }
    return { config: next as unknown as AgentConfig, changed };
  }

  /**
   * System Prompt 装配预览（src getAgentSystemPrompt 的 preview 形态）：
   * 以干跑请求过 loop/before-run waterfall——persona/system-prompt/
   * memory 等全部组装器真实生效，但不发 run（无 loop/run-started、
   * 无 LLM 调用）。virtual Agent 无系统提示词，抛错。
   */
  async systemPromptPreview(agentId: string): Promise<string> {
    const config = this.getAgent(agentId);
    if (config.virtual) throw new Error(`Agent "${agentId}" 是 virtual（无系统提示词）`);
    const request: LoopRunRequest = {
      agent: agentId,
      model: config.model ?? '(preview)',
      ...(config.provider ? { provider: config.provider } : {}),
      ...(config.system ? { system: config.system } : {}),
      ...(config.tools !== undefined
        ? { tools: resolveToolNames(config.tools, this.ctx.tools.list().map((t) => t.name)) ?? [] }
        : {}),
      messages: [],
      // 预览视角：以 viewer 直答形态干跑（M19：sender = 端点 id）
      sender: 'user',
      source: 'user',
      conversationId: agentId,
    };
    const call: LoopRunCall = { request };
    await this.ctx.waterfall(
      'loop/before-run',
      call,
      async () => ({ steps: [], text: '', finish: 'stop', usage: null }) as unknown as LoopRunResult,
    );
    // 必须读载体 call.request 而非本地 request：组装器（persona/
    // system-prompt 等）以"替换 call.request"的方式变异载体（本 cordis
    // waterfall 改写输入的唯一方式），干跑后本地别名仍指向旧对象。
    return call.request.system ?? '';
  }

  // ============================================================
  // sanitize：白名单校验 + 凭据剥离 + 身份固定（id 校验通过后才写凭据）
  // ============================================================

  private sanitize(
    input: Record<string, unknown>,
    current: AgentConfig | undefined,
  ): { config: AgentConfig; credential: { value: string } | undefined } {
    const unknown = Object.keys(input).filter((k) => !ALLOWED_FIELDS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `字段不在 AgentConfig 白名单（各域已 owning 化，全局专属键拒绝写入）: ${unknown.join(', ')}`,
      );
    }
    const { apiKey, id, ...rest } = input as Record<string, unknown> & { apiKey?: unknown; id?: unknown };
    const agentId = current?.id ?? (typeof id === 'string' ? id : undefined);
    if (!agentId) throw new Error('缺少 agent id（create 须携带 id；update 按 agentId 定位）');
    // id 词法（M19 承重墙，仅 create 校验新 id；update 的 id 由 current 固定）
    if (current === undefined) assertAgentId(agentId);
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new Error('apiKey 须为字符串（空串 = 删除该凭据）');
    }
    if (
      rest.tags !== undefined &&
      (!Array.isArray(rest.tags) || rest.tags.some((t) => typeof t !== 'string'))
    ) {
      throw new Error('tags 须为字符串数组（能力标签，如 ["base","dev"]）');
    }
    const provider =
      typeof rest.provider === 'string' && rest.provider
        ? rest.provider
        : current?.provider ?? '';
    const credential = apiKey !== undefined ? { provider: provider || 'default', value: apiKey } : undefined;
    if (credential) this.ctx.credentials.set(agentId, credential.provider, credential.value);
    const config = { ...rest, id: agentId } as AgentConfig;
    return { config, credential };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** Agent 管理面服务（ac-agent-admin 提供）：CRUD/凭据/文档/预览（写侧 owning） */
    agentAdmin: AgentAdminService;
  }
}

/** 窄化：非空对象（装配补丁字段） */
function objOf(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('装配补丁字段须为对象');
  }
  return v as Record<string, unknown>;
}

/** 窄化：字符串数组 */
function strArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new Error(`装配补丁 ${label} 须为字符串数组`);
  }
  return v as string[];
}
