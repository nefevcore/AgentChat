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
//
// 懒扫描：首次消费（list/注入）才读目录并缓存；refresh() 重扫
// （技能目录增删后调用，webui/管理面的刷新口）。
// ============================================================
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）
import {
  buildSkillsBlock,
  discoverSkills,
  filterSkills,
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
  /** 技能白名单（name 或 dirName 命中皆可；空白名单 = 全部） */
  whitelist?: string[];
}

export class SkillsService extends Service {
  /** 事件闭包访问 ctx.agents（settings['skill'] 查询）——M12 铁律 1 */
  static inject = ['agents'];

  private skillsRoot: string;
  private locationPrefix: string;
  private cache: SkillManifest[] | null = null;

  constructor(ctx: Context, options: SkillRowOptions = {}) {
    super(ctx, 'skills');
    const root = options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data';
    this.skillsRoot = path.resolve(root, 'skills');
    this.locationPrefix =
      options.locationPrefix ?? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/skills`;

    this.ctx.on('loop/before-run', (call, next) => {
      const agentId = call.request.agent;
      const cfg = agentId ? this.ctx.agents.settingsOf(agentId, 'skill') : undefined;
      let whitelist: string[] | undefined;
      if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
        const skillSettings = cfg as SkillSettings;
        if (skillSettings.enabled === false) return next();
        if (Array.isArray(skillSettings.whitelist)) {
          whitelist = skillSettings.whitelist.filter((s): s is string => typeof s === 'string');
        }
      }
      const block = buildSkillsBlock(filterSkills(this.list(), whitelist), this.locationPrefix);
      if (block) {
        call.request = {
          ...call.request,
          system: call.request.system ? `${call.request.system}\n\n${block}` : block,
        };
      }
      return next();
    }, { description: '注入 <available_skills> 全局技能目录' });
  }

  /** 技能目录根（诊断用） */
  get root(): string {
    return this.skillsRoot;
  }

  /** 已发现技能清单（懒扫描：首次调用触发；按名称排序） */
  list(): SkillManifest[] {
    if (this.cache === null) this.refresh();
    return this.cache ?? [];
  }

  /** 重扫技能目录（目录增删后的刷新口） */
  refresh(): SkillManifest[] {
    this.cache = discoverSkills(this.skillsRoot);
    return this.cache;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 技能服务（ac-skill 提供）：全局技能目录发现 + before-run 注入 */
    skills: SkillsService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— <available_skills>
// 渲染确定性（目录与白名单不变则字节不变）。显式失效：技能增删/白名单
// 修改 = invalidate-from-X（该桶一次 system 重置）。

export const name = 'ac-skill';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'skill',
  label: '技能注入',
  description: '注入 <available_skills> 全局技能目录（whitelist per-Agent 白名单）',
  fields: [
    { name: 'whitelist', description: '技能白名单——留空 = 全部全局技能可见；每行一个技能名' },
    { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '注入 <available_skills>', description: 'Agent 循环启动前拦截（人格/框架/记忆等扩展装配链的一环）', respectsEnabled: true }],
};


export const inject = ['agents'];

export function apply(ctx: Context, options: SkillRowOptions = {}) {
  ctx.plugin(SkillsService, options);
}
