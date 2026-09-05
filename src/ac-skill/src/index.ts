// ============================================================
// ac-skill —— 技能行（SkillsService，M14）
//
// src 轨道映射：agent-skill 的 discovered_skills runStart 钩子
// → preview 的 loop/before-run waterfall。发现/解析/渲染算法住
// 纯库 ac-skill-core（本行只做装配与 per-Agent 管控）。
//
// 形态差异（地图 §3.2）：
//   · 全局技能目录 <root>/skills/<dirName>/SKILL.md（src 为
//     per-Agent agentDir/skills；preview 全局共享 + per-Agent 白名单——
//     与"Agent 是数据、技能是共享资产"的注册表哲学一致）；
//   · settings['skill'] = { enabled?, whitelist? }——whitelist 命中
//     name 或 dirName；空白名单 = 暴露全部已发现技能（M24 A1 经
//     settingsOf 合成全局默认层）。
//   · 本 Agent 专属技能：<数据根>/files/<agentId>/skills/<dirName>/
//     SKILL.md（workspace.agentWorkdir 同款沙箱定位；无 workspace 行
//     回落 <数据根>/files/<agentId>/ 约定）。只对该 Agent 注入与加载，
//     不受全局 whitelist 约束——"Agent 私有技能"的承载面，补全
//     per-Agent 自身技能的诉求。
//   · 会话工作区技能（2026-11）：singles 会话挂载工作区后，扫描工作区
//     根下的业界约定技能目录（.claude/skills、.github/skills、skills、
//     .agents/skills——discoverWorkspaceSkills）——Claude Code /
//     GitHub Copilot 等维护的项目技能直接被会话复用。随会话挂载的
//     项目资产：不经 enabled/whitelist 门控（__standard__ 等无记忆
//     预设同样可见）；同名遮蔽序 = 本 Agent 专属 > 会话工作区 > 全局。
//   · load_skill 工具（参照 DSH dsh-tool-skill）：目录只给摘要
//     （name/description/location），模型按需经工具加载完整正文，
//     不再依赖 read 路径猜测；全局、本 Agent 专属与会话工作区均可按名加载。
//
// 懒扫描：首次消费（list/注入）才读目录并缓存；refresh() 重扫
// （技能目录增删后调用，webui/管理面的刷新口）。本 Agent 专属技能
// 目录随每次注入/加载现扫（目录小、且随 Agent 沙箱内容演进）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）
import type { ToolResult } from 'ac-tools';
import {
  buildSkillsBlock,
  discoverSkills,
  discoverWorkspaceSkills,
  escapeXml,
  filterSkills,
  isSkillName,
  readSkillBody,
  type SkillGroup,
  type SkillManifest,
  type WorkspaceSkillGroup,
} from 'ac-skill-core';

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface SkillRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；技能目录 = <root>/skills） */
  root?: string;
  /** SKILL.md 路径提示前缀（缺省 <root>/skills 的 POSIX 形） */
  locationPrefix?: string;
}

/** settings['skill'] 配置形状（per-Agent；形状由本插件自定义） */
export interface SkillSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 技能白名单（name 或 dirName 命中皆可；空白名单 = 全部全局技能） */
  whitelist?: string[];
}

/** 某 Agent 的技能可见态（注入与 load_skill 共用同一合成口） */
export interface AgentSkillView {
  /** settings['skill'].enabled=false → 软停用（全局/专属不注入也不可加载；
   *  会话工作区组不受此门控——工作区技能是随会话挂载的项目资产） */
  disabled: boolean;
  /** 全局技能（白名单过滤后；该 Agent 可见的共享技能池） */
  global: SkillManifest[];
  /** 本 Agent 专属技能（files/<agentId>/skills；不受全局白名单约束） */
  own: SkillManifest[];
  /** 本 Agent 专属技能根目录（原始路径；无专属技能时为 undefined） */
  ownRoot?: string;
  /** 本 Agent 专属技能 SKILL.md location 前缀（POSIX 形） */
  ownPrefix?: string;
  /** 会话工作区技能组（singles 挂载工作区的多约定目录扫描；非 singles
   *  会话/未挂工作区 = 空数组） */
  workspace: WorkspaceSkillGroup[];
}

/** workspace 服务最小结构面（结构化读取，不引运行时依赖） */
interface WorkdirSource {
  agentWorkdir(agentId: string): string;
}

/** load_skill 工具输出形状 */
export interface SkillLoadOutput {
  /** 技能名（<name>） */
  name: string;
  /** 来源：global = 全局共享池 / agent = 本 Agent 专属 / workspace = 会话工作区 */
  scope: 'global' | 'agent' | 'workspace';
  /** 技能目录（SKILL.md 所在目录；相对引用以此为基准） */
  baseDir: string;
  /** SKILL.md 正文（frontmatter 已剥离） */
  content: string;
}

/** /name 用户调用手势（DSH SKILL_GESTURE 同款）：用户消息中以空白为界、
 *  kebab-case 的 /<name> token；行中 URL（https://）不命中 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/** 扫描用户消息中的 /<name> 调用手势（去重保序） */
function invokedSkillNames(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.content;
    const texts = typeof content === 'string' ? [content]
      : Array.isArray(content)
        ? content.filter((b): b is { type: 'text'; text: string } =>
            typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string')
          .map((b) => b.text)
        : [];
    for (const text of texts) {
      for (const match of text.matchAll(SKILL_GESTURE)) {
        const name = match[2];
        if (name !== undefined && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/** 技能名 → 目录定位的越界守卫（load 面路径白名单） */
function assertInside(root: string, dirName: string): string {
  const rootAbs = path.resolve(root);
  const dir = path.resolve(rootAbs, dirName);
  if (dir !== rootAbs && !dir.startsWith(rootAbs + path.sep)) {
    throw new Error(`技能目录越界（${dirName}）`);
  }
  return dir;
}

export class SkillsService extends Service {
  /** 事件闭包/工具执行访问 ctx.agents/settings、ctx.tools 注册——M12 铁律 1 */
  static inject = ['agents', 'tools'];

  private dataRoot: string;
  private skillsRoot: string;
  private locationPrefix: string;
  private cache: SkillManifest[] | null = null;

  constructor(ctx: Context, options: SkillRowOptions = {}) {
    super(ctx, 'skills');
    const root = options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data';
    this.dataRoot = path.resolve(root);
    this.skillsRoot = path.join(this.dataRoot, 'skills');
    this.locationPrefix =
      options.locationPrefix ?? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/skills`;

    // ---- before-run 注入 <available_skills>：会话工作区（约定目录） +
    //      全局（白名单过滤）+ 本 Agent 专属 ----
    this.ctx.on('loop/before-run', (call, next) => {
      const state = this.agentSkillState(call.request.agent, call.request.conversationId);
      const groups: SkillGroup[] = [];
      // 工作区组：随 singles 会话挂载的项目资产——不经 enabled/whitelist
      // 门控（与附件同语义：挂了就在，__standard__ 等无记忆预设同样可见）
      for (const g of state.workspace) {
        groups.push({ skills: g.skills, locationPrefix: g.locationPrefix });
      }
      if (!state.disabled) {
        if (state.global.length > 0) {
          groups.push({ skills: state.global, locationPrefix: this.locationPrefix });
        }
        if (state.own.length > 0 && state.ownPrefix) {
          groups.push({ skills: state.own, locationPrefix: state.ownPrefix });
        }
      }
      const block = buildSkillsBlock(groups);
      if (block) {
        call.request = {
          ...call.request,
          system: call.request.system ? `${call.request.system}\n\n${block}` : block,
        };
      }
      return next();
    }, { description: '注入 <available_skills> 会话工作区 + 全局 + 本 Agent 专属技能目录' });

    // ---- /name 用户显式调用：before-step 手势边界确定性注入（DSH
    //      dsh-tool-skill pre-step 同款）——识别用户消息中以空白为界的
    //      /<kebab-name> token，命中已发现技能即为该步注入 <skill_content>
    //      正文。菜单 pick 与手打 token 同一语义，不依赖模型自觉调
    //      load_skill；改写仅本步生效（循环主历史不受影响）。
    this.ctx.on('loop/before-step', (call, next) => {
      const names = invokedSkillNames(call.messages);
      if (names.length === 0) return next();
      const state = this.agentSkillState(call.agent, call.conversationId);
      // 与目录注入同一可见性口径（locateSkill 内含遮蔽序与门控）
      const bodies = names
        .map((name) => this.renderSkillContent(name, state))
        .filter((body) => body !== '');
      if (bodies.length > 0) {
        call.messages = [
          ...call.messages,
          {
            role: 'user',
            content: `<system-reminder>用户以 /<name> 显式调用以下技能，按其指令执行；这些技能已内联注入，无需再经 load_skill 加载。\n${bodies.join('\n')}</system-reminder>`,
          },
        ];
      }
      return next();
    }, { description: '/name 手势确定性注入技能正文（步级）' });

    // ---- load_skill：按 <name> 加载完整指令（参照 DSH skill 工具） ----
    this.ctx.tools.register({
      name: 'load_skill',
      description:
        '按名称加载一个技能的完整指令正文（<available_skills> 中列出的技能：会话工作区、全局与本 Agent 专属均可；加载后按其指令执行，不再重复加载）。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '技能名（<available_skills> 条目中的 <name>，kebab-case）',
          },
        },
        required: ['name'],
      },
      execute: (args, call) =>
        this.loadSkill(
          typeof args.name === 'string' ? args.name : '',
          call.agentId,
          call.conversationId,
        ),
    });
  }

  /** 已发现全局技能清单（懒扫描：首次调用触发；按名称排序） */
  list(): SkillManifest[] {
    if (this.cache === null) this.refresh();
    return this.cache ?? [];
  }

  /** 重扫全局技能目录（目录增删后的刷新口） */
  refresh(): SkillManifest[] {
    this.cache = discoverSkills(this.skillsRoot);
    return this.cache;
  }

  /** 某 Agent 可见的全局（白名单过滤）+ 本 Agent 专属技能（供注入/管理面） */
  listForAgent(agentId: string, conversationId?: string): { global: SkillManifest[]; own: SkillManifest[]; workspace: WorkspaceSkillGroup[] } {
    const state = this.agentSkillState(agentId, conversationId);
    return {
      global: state.disabled ? [] : state.global,
      own: state.disabled ? [] : state.own,
      workspace: state.workspace,
    };
  }

  /**
   * 某 Agent（+ 可选会话）的技能可见态：enabled / 全局白名单 / 专属目录
   * 现扫 / 会话工作区约定目录扫描。注入与 load_skill 共用——各入口看到
   * 的是同一份清单。工作区组不受 disabled/whitelist 门控（会话挂载资产）。
   */
  private agentSkillState(agentId: string | undefined, conversationId?: string): AgentSkillView {
    const state: AgentSkillView = { disabled: false, global: [], own: [], workspace: [] };
    // 会话工作区组（singles 挂载；其余会话形态恒空）——现扫不缓存：
    // 工作区内容随用户编辑演进，弹层/注入按需扫描成本低（约定目录 readdir）
    const wsRoot = this.workspaceOf(conversationId);
    if (wsRoot) state.workspace = discoverWorkspaceSkills(wsRoot);
    if (agentId === undefined) {
      state.global = filterSkills(this.list());
      return state;
    }
    const cfg = this.ctx.agents.settingsOf(agentId, 'skill');
    let whitelist: string[] | undefined;
    if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
      const skillSettings = cfg as SkillSettings;
      if (skillSettings.enabled === false) {
        state.disabled = true;
        return state;
      }
      if (Array.isArray(skillSettings.whitelist)) {
        whitelist = skillSettings.whitelist.filter((s): s is string => typeof s === 'string');
      }
    }
    state.global = filterSkills(this.list(), whitelist);
    const ownRoot = this.agentOwnSkillsRoot(agentId);
    // 预设/未注册 Agent 的 workdir = 数据根 → own 目录即全局 skills 目录：
    // 重复扫描只会把全局清单镜像成"专属"（skills/list 读面会看到双份），
    // 直接不计。常规 Agent（files/<id>）不受影响。
    if (ownRoot === this.skillsRoot) return state;
    const own = discoverSkills(ownRoot);
    if (own.length > 0) {
      state.own = own;
      state.ownRoot = ownRoot;
      state.ownPrefix = ownRoot.replace(/\\/g, '/');
    }
    return state;
  }

  /** 本 Agent 专属技能根：workspace.agentWorkdir 唯一事实源；未装 workspace
   *  行回落 <数据根>/files/<agentId>/ 同一约定（与 ac-memory/ac-archive 口径一致） */
  private agentOwnSkillsRoot(agentId: string): string {
    const ws = this.ctx.get('workspace') as WorkdirSource | undefined;
    const dir = ws ? ws.agentWorkdir(agentId) : path.join(this.dataRoot, 'files', agentId);
    return path.join(dir, 'skills');
  }

  /**
   * 会话工作区根（singles 挂载工作区 → 本机路径；其余会话形态/未挂 = null）。
   * workspace.conversationWorkspaceRoot 唯一事实源（与沙箱允许根/提示词
   * 白名单展示同源不漂移）；workspace 行未装时回落自带链（singles 记录 →
   * listWorkspaces——技能行不因此硬依赖 workspace）。
   */
  private workspaceOf(conversationId: string | undefined): string | null {
    if (!conversationId) return null;
    const ws = this.ctx.get('workspace') as
      | { conversationWorkspaceRoot?(cid: string): string | null }
      | undefined;
    if (typeof ws?.conversationWorkspaceRoot === 'function') {
      return ws.conversationWorkspaceRoot(conversationId);
    }
    const singles = this.ctx.get('singles') as
      | { get(sid: string): { workspaceId?: string } | null }
      | undefined;
    const record = singles?.get(conversationId);
    const wsId = typeof record?.workspaceId === 'string' ? record.workspaceId : '';
    if (!wsId) return null;
    const workspace = this.ctx.get('workspace') as
      | { listWorkspaces(): Array<{ id: string; path: string }> }
      | undefined;
    return workspace?.listWorkspaces().find((w) => w.id === wsId)?.path ?? null;
  }

  /** 按名定位技能（优先序 = 特异性：本 Agent 专属 > 会话工作区 > 全局；
   *  disabled 时全局/专属清单恒空——命中只可能是工作区组） */
  private locateSkill(name: string, state: AgentSkillView): { hit: SkillManifest; root: string; scope: SkillLoadOutput['scope'] } | null {
    const ownHit = state.own.find((s) => s.name === name);
    if (ownHit) return { hit: ownHit, root: state.ownRoot as string, scope: 'agent' };
    for (const g of state.workspace) {
      const wsHit = g.skills.find((s) => s.name === name);
      if (wsHit) return { hit: wsHit, root: g.root, scope: 'workspace' };
    }
    const globalHit = state.global.find((s) => s.name === name);
    if (globalHit) return { hit: globalHit, root: this.skillsRoot, scope: 'global' };
    return null;
  }

  /** /name 手势注入的正文渲染（<skill_content> 包装）；定位不到/读取
   *  失败 → 空串（不注入坏块，模型可回落 load_skill 拿到可读错误） */
  private renderSkillContent(name: string, state: AgentSkillView): string {
    const located = this.locateSkill(name, state);
    if (!located) return '';
    try {
      const dir = assertInside(located.root, located.hit.dirName);
      const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      return `<skill_content name="${escapeXml(name)}">\n${readSkillBody(content)}\n</skill_content>`;
    } catch {
      return '';
    }
  }

  /** load_skill 执行体：按名解析（本 Agent 专属 > 会话工作区 > 全局）+ 读正文 */
  private loadSkill(name: string, agentId: string | undefined, conversationId?: string): ToolResult {
    if (!isSkillName(name)) throw new Error(`技能名 "${name}" 非法（须 kebab-case，如 pdf-export）`);
    if (!agentId) throw new Error('技能加载需要 Agent 身份（load_skill 仅供 Agent 会话内调用）');
    const state = this.agentSkillState(agentId, conversationId);
    const located = this.locateSkill(name, state);
    if (!located) {
      throw new Error(
        state.disabled
          ? `技能 "${name}" 不可用（该 Agent settings.skill.enabled=false，全局/专属技能已停用；会话工作区技能不受此门控）`
          : `技能 "${name}" 不存在或当前不可用（仅目录中列出的技能可加载）`,
      );
    }
    const dir = assertInside(located.root, located.hit.dirName);
    const file = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`技能 "${name}" 读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const output: SkillLoadOutput = {
      name: located.hit.name,
      scope: located.scope,
      baseDir: dir.replace(/\\/g, '/'),
      content: readSkillBody(content),
    };
    return { ok: true, output };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 技能服务（ac-skill 提供）：全局 + 本 Agent 专属 + 会话工作区技能发现、before-run 注入、load_skill */
    skills: SkillsService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— <available_skills>
// 渲染确定性（目录与白名单不变则字节不变；本 Agent 专属组随 Agent 沙箱
// skills/ 内容与请求 Agent 而定；会话工作区组随会话挂载工作区的约定
// 目录内容而定）。显式失效：技能增删/白名单修改/工作区技能增删 =
// invalidate-from-X（该桶一次 system 重置）。load_skill 走工具结果
// （仅追加历史），不进 system——不参与 system 前缀。

export const name = 'ac-skill';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'skill',
  label: '技能注入',
  description: '注入 <available_skills>（全局技能目录 + 本 Agent 专属 files/<agent>/skills + 会话工作区约定目录 .claude/.github/skills 等）+ load_skill 按名加载 + /name 用户显式调用确定性注入',
  fields: [
    { name: 'whitelist', type: 'list', description: '全局技能白名单——留空 = 全部全局技能可见；本 Agent 专属技能不受此约束；每行一个技能名' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '注入 <available_skills>', description: 'Agent 循环启动前拦截（人格/框架/记忆等扩展装配链的一环）', respectsEnabled: true },
    { event: 'loop/before-step', role: '/name 手势注入技能正文', description: '识别用户消息中的 /<name> 调用 token，为该步内联 <skill_content>（菜单 pick 与手打 token 同一语义）', respectsEnabled: true },
  ],
};

export const inject = ['agents', 'tools'];

export function apply(ctx: Context, options: SkillRowOptions = {}) {
  ctx.plugin(SkillsService, options);
}
