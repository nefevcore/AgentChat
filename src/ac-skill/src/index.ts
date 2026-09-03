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
//   · load_skill 工具（参照 DSH dsh-tool-skill）：目录只给摘要
//     （name/description/location），模型按需经工具加载完整正文，
//     不再依赖 read 路径猜测；全局与本 Agent 专属均可按名加载。
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
  filterSkills,
  isSkillName,
  readSkillBody,
  type SkillGroup,
  type SkillManifest,
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
  /** settings['skill'].enabled=false → 软停用（不注入也不可加载） */
  disabled: boolean;
  /** 全局技能（白名单过滤后；该 Agent 可见的共享技能池） */
  global: SkillManifest[];
  /** 本 Agent 专属技能（files/<agentId>/skills；不受全局白名单约束） */
  own: SkillManifest[];
  /** 本 Agent 专属技能根目录（原始路径；无专属技能时为 undefined） */
  ownRoot?: string;
  /** 本 Agent 专属技能 SKILL.md location 前缀（POSIX 形） */
  ownPrefix?: string;
}

/** workspace 服务最小结构面（结构化读取，不引运行时依赖） */
interface WorkdirSource {
  agentWorkdir(agentId: string): string;
}

/** load_skill 工具输出形状 */
export interface SkillLoadOutput {
  /** 技能名（<name>） */
  name: string;
  /** 来源：global = 全局共享池 / agent = 本 Agent 专属 */
  scope: 'global' | 'agent';
  /** 技能目录（SKILL.md 所在目录；相对引用以此为基准） */
  baseDir: string;
  /** SKILL.md 正文（frontmatter 已剥离） */
  content: string;
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

    // ---- before-run 注入 <available_skills>：全局（白名单过滤） + 本 Agent 专属 ----
    this.ctx.on('loop/before-run', (call, next) => {
      const state = this.agentSkillState(call.request.agent);
      if (state.disabled) return next();
      const groups: SkillGroup[] = [];
      if (state.global.length > 0) {
        groups.push({ skills: state.global, locationPrefix: this.locationPrefix });
      }
      if (state.own.length > 0 && state.ownPrefix) {
        groups.push({ skills: state.own, locationPrefix: state.ownPrefix });
      }
      const block = buildSkillsBlock(groups);
      if (block) {
        call.request = {
          ...call.request,
          system: call.request.system ? `${call.request.system}\n\n${block}` : block,
        };
      }
      return next();
    }, { description: '注入 <available_skills> 全局 + 本 Agent 专属技能目录' });

    // ---- load_skill：按 <name> 加载完整指令（参照 DSH skill 工具） ----
    this.ctx.tools.register({
      name: 'load_skill',
      description:
        '按名称加载一个技能的完整指令正文（<available_skills> 中列出的技能：全局与本 Agent 专属均可；加载后按其指令执行，不再重复加载）。',
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
        this.loadSkill(typeof args.name === 'string' ? args.name : '', call.agentId),
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
  listForAgent(agentId: string): { global: SkillManifest[]; own: SkillManifest[] } {
    const state = this.agentSkillState(agentId);
    return { global: state.disabled ? [] : state.global, own: state.disabled ? [] : state.own };
  }

  /**
   * 某 Agent 的技能可见态（enabled / 全局白名单 / 专属目录现扫）。
   * 注入与 load_skill 共用——两入口看到的是同一份清单。
   */
  private agentSkillState(agentId: string | undefined): AgentSkillView {
    const state: AgentSkillView = { disabled: false, global: [], own: [] };
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

  /** load_skill 执行体：按名解析（本 Agent 专属优先于全局）+ 读正文 */
  private loadSkill(name: string, agentId: string | undefined): ToolResult {
    if (!isSkillName(name)) throw new Error(`技能名 "${name}" 非法（须 kebab-case，如 pdf-export）`);
    if (!agentId) throw new Error('技能加载需要 Agent 身份（load_skill 仅供 Agent 会话内调用）');
    const state = this.agentSkillState(agentId);
    if (state.disabled) throw new Error('技能已停用（该 Agent settings.skill.enabled=false）');

    // 本 Agent 专属优先（同名专属技能遮蔽全局同名技能）
    const ownHit = state.own.find((s) => s.name === name);
    const hit = ownHit ?? state.global.find((s) => s.name === name);
    if (!hit) {
      throw new Error(`技能 "${name}" 不存在或当前不可用（仅目录中列出的技能可加载）`);
    }
    const root = ownHit ? (state.ownRoot as string) : this.skillsRoot;
    const dir = assertInside(root, hit.dirName);
    const file = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`技能 "${name}" 读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const output: SkillLoadOutput = {
      name: hit.name,
      scope: ownHit ? 'agent' : 'global',
      baseDir: dir.replace(/\\/g, '/'),
      content: readSkillBody(content),
    };
    return { ok: true, output };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 技能服务（ac-skill 提供）：全局 + 本 Agent 专属技能发现、before-run 注入、load_skill */
    skills: SkillsService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— <available_skills>
// 渲染确定性（目录与白名单不变则字节不变；本 Agent 专属组随 Agent 沙箱
// skills/ 内容与请求 Agent 而定）。显式失效：技能增删/白名单修改 =
// invalidate-from-X（该桶一次 system 重置）。load_skill 走工具结果
// （仅追加历史），不进 system——不参与 system 前缀。

export const name = 'ac-skill';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'skill',
  label: '技能注入',
  description: '注入 <available_skills>（全局技能目录 + 本 Agent 专属 files/<agent>/skills）+ load_skill 按名加载',
  fields: [
    { name: 'whitelist', type: 'list', description: '全局技能白名单——留空 = 全部全局技能可见；本 Agent 专属技能不受此约束；每行一个技能名' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '注入 <available_skills>', description: 'Agent 循环启动前拦截（人格/框架/记忆等扩展装配链的一环）', respectsEnabled: true }],
};

export const inject = ['agents', 'tools'];

export function apply(ctx: Context, options: SkillRowOptions = {}) {
  ctx.plugin(SkillsService, options);
}
