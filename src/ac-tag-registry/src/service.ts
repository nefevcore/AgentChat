// ============================================================
// ac-tag-registry/src/service.ts —— 能力标签注册中心（cordis Service）
//
// tag 词表的隐式性问题（P1 诊断）：工具行各自声明 requiredTags，但
// 没有任何一处汇聚「当前系统全部合法 tag」——配 Agent 时面对的是
// 手写字符串数组，既不知道有哪些词、也不知道某词解锁什么。本服务
// 把词表变成显式：
//   · 采集：监听 tool/registered · tool/unregistered（ac-tools 发出，
//     注册/回收时同步），按 tag 汇聚消费工具清单——工具行零改动；
//   · 预注册：档位词（full-access/sandbox-access，tierOf 消费）、工具
//     调用模式词（tc-*，toolModeOf 消费；tc-programmatic 是唯一被
//     requiredTags 合法引用的非能力词——标签即授权，见 assert 白名单）
//     与能力族（fs/collab/infra/history），启动即在场；
//   · 分类：reserved（base/档位）≠ tool-required（被工具门禁消费）≠
//     owner（agent:<id> 私有工具标签，等 owner 自行声明）≠ unknown
//     （拼错/外部词——UI 警示）。
//
// 双源校正：ac-tools 的 defs 是 tags→tools 的原始事实，本服务只是
// 附加描述元数据——采集不经过任何注册面，纵贯线最短。注册序上
// 工具行先装载、本行后装载也无妨：视图查询时按 defs 现算，事件
// 仅维护增量缓存。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { TagDeclaration } from './contract.ts';

/** 标签类别（UI 分组依据；'base' 为历史类别，保留类型兼容——base 已退役） */
export type TagCategory = 'base' | 'access-tier' | 'tool-mode' | 'capability' | 'owner' | 'unknown';

/** 目录条目（wire 面：JSON 直出） */
export interface TagCatalogEntry {
  tag: string;
  /** 类别（分组 + 徽章语义） */
  category: TagCategory;
  /** 人类可读说明 */
  description?: string;
  /** 引用本标签的工具（name + 一句话描述 + 注册方行名；类别 = capability） */
  tools: Array<{ name: string; description?: string; owner?: string }>;
  /** 预注册词（档位与能力族；base 已退役）——目录恒有，手工声明不覆盖 */
  reserved?: boolean;
  /** 手工声明方（行名；声明来源标注） */
  declaredBy?: string;
  /** 独立分组（声明方自组；缺省 = capability 通用组） */
  group?: string;
  /** 目录排序提示（缺省 50，组内升序）——分层族按层级呈现 */
  order?: number;
  /** 分层族标记（低 ⊂ 高：勾选高层含低层全部能力） */
  tier?: boolean;
}

/** 预注册词表（面向用户的短描述——经 tags/catalog RPC 直出前端 tooltip）。
 *  base 已退役（全量标签化 2026-09-16：一切出厂工具挂具体标签） */
const RESERVED: Array<{ tag: string; category: TagCategory; description: string }> = [
  {
    tag: 'fs',
    category: 'capability',
    description: '文件读写（read/write/edit/glob/grep）',
  },
  {
    tag: 'collab',
    category: 'capability',
    description: '多 Agent 协作（发消息/查名册/改档案）',
  },
  {
    tag: 'infra',
    category: 'capability',
    description: '会话基础设施（提问/待办/目标/定时/技能/计算等）',
  },
  {
    tag: 'history',
    category: 'capability',
    description: '会话历史回放（grep_history 检索 / read_history 分页读取）',
  },
  {
    tag: 'tc-programmatic',
    category: 'tool-mode',
    description: '程序化档：工具调用经 run_code 写程序编排（LLM 面收窄为单入口）',
  },
  {
    tag: 'tc-none',
    category: 'tool-mode',
    description: '无工具档：移除 LLM 工具面（纯聊天）',
  },
  {
    tag: 'tc-base',
    category: 'tool-mode',
    description: '标准档（缺省）：模型逐个直调工具——预注册仅供目录展示，tags 无需书写',
  },
  {
    tag: 'full-access',
    category: 'access-tier',
    description: '完全访问档：不受沙箱限制（人工授予的信任）',
  },
  {
    tag: 'sandbox-access',
    category: 'access-tier',
    description: '沙箱档：工作区白名单内自由',
  },
];

export class TagRegistryService extends Service {
  static inject = ['tools'];

  /** tag → 消费工具清单（增量缓存；事件驱动维护） */
  private consumers = new Map<string, Array<{ name: string; description?: string; owner?: string }>>();

  constructor(ctx: Context) {
    super(ctx, 'tagRegistry');

    // 采集面：工具注册/回收事件（ac-tools 发出；含动态插件工具）
    ctx.on(
      'tool/registered',
      (def) => {
        for (const tag of def.requiredTags ?? []) this.add(tag, def);
      },
      { description: 'tag-registry：采集工具 requiredTags' },
    );
    ctx.on(
      'tool/unregistered',
      (name) => {
        for (const [tag, list] of this.consumers) {
          const next = list.filter((t) => t.name !== name);
          if (next.length === 0 && !this.isReserved(tag)) this.consumers.delete(tag);
          else this.consumers.set(tag, next);
        }
      },
      { description: 'tag-registry：回收工具 requiredTags' },
    );
  }

  private isReserved(tag: string): boolean {
    return RESERVED.some((r) => r.tag === tag);
  }

  private add(tag: string, def: { name: string; description?: string }): void {
    // owner 私有标签（agent:<id>）：等 owner 自行声明，不进 capability 目录
    if (tag.startsWith('agent:')) return;
    const list = this.consumers.get(tag) ?? [];
    if (!list.some((t) => t.name === def.name)) {
      list.push({ name: def.name, ...(def.description ? { description: def.description } : {}) });
      this.consumers.set(tag, list);
    }
  }

  /**
   * 手工声明扫描（A1 注册制同款）：cordis registry 各行包入口模块的
   * `export const tagDeclarations: TagDeclaration[]`（插件包为「不从
   * requiredTags 可推导」的标签自行注册——browser 动作分层先例）。
   * Runtime.plugin = 首次注册时的源插件对象（collectExtensionCatalog
   * 读 extension 自述的同款路径）；形状不符如实跳过（fail-soft）。
   */
  private collectDeclarations(): Array<TagDeclaration & { row: string }> {
    const out: Array<TagDeclaration & { row: string }> = [];
    for (const runtime of this.ctx.registry.values()) {
      if (!runtime.name) continue;
      const decls = (runtime as unknown as { plugin?: { tagDeclarations?: unknown } }).plugin?.tagDeclarations;
      if (!Array.isArray(decls)) continue;
      for (const d of decls) {
        if (
          !d || typeof d !== 'object' ||
          typeof (d as { tag?: unknown }).tag !== 'string' || (d as { tag: string }).tag === '' ||
          typeof (d as { description?: unknown }).description !== 'string'
        ) continue;
        const t = d as TagDeclaration;
        if (t.tag.startsWith('agent:')) continue; // owner 词表不收
        out.push({ ...t, row: runtime.name });
      }
    }
    return out;
  }

  /**
   * 目录视图（tags/catalog RPC 数据源）：预注册 + 工具面采集 + 手工
   * 声明合并，按 tag 字典序稳定输出。快照语义——每次现算，纵贯线不
   * 依赖装载序。合并规则：手工声明补描述/排序元数据；requiredTags
   * 采集到的消费工具如实并入（双源对同一词 = 描述来自声明、工具清单
   * 取并集——browser 的 observe 两者都有，正好合成完整语义）。
   * 注：base 退役（全量标签化 2026-09-16）——不再预注册；存量 tags
   * 里的 'base' 由前端归一剔除（无门禁语义，保留也不影响能力判定）。
   */
  catalog(): TagCatalogEntry[] {
    const byTag = new Map<string, TagCatalogEntry>();
    for (const r of RESERVED) {
      byTag.set(r.tag, { tag: r.tag, category: r.category, description: r.description, tools: [], reserved: true });
    }
    // 手工声明（先于采集合并：声明可为纯领域词——无任何工具引用也进目录）
    for (const d of this.collectDeclarations()) {
      if (byTag.has(d.tag)) continue; // 预注册词不让声明覆盖
      byTag.set(d.tag, {
        tag: d.tag,
        category: 'capability',
        description: d.description,
        tools: (d.tools ?? []).map((name) => ({ name })),
        ...(d.row ? { declaredBy: d.row } : {}),
        ...(d.group ? { group: d.group } : {}),
        ...(d.order !== undefined ? { order: d.order } : {}),
        ...(d.tier === true ? { tier: true } : {}),
      });
    }
    for (const def of this.ctx.tools.listWithOwner()) {
      for (const tag of def.requiredTags ?? []) {
        if (tag.startsWith('agent:')) continue; // owner 私有标签不进目录（等 owner 自行声明）
        const existing = byTag.get(tag);
        if (existing) {
          // 已有条目（预注册或手工声明）：消费工具如实并入（预注册词
          // 不例外——2026-09-16 起能力族预注册也需要解锁计数与工具
          // 清单；reserved 仍标记"声明不被覆盖"，采集面照常并入）
          if (!existing.tools.some((t) => t.name === def.name)) {
            existing.tools.push({ name: def.name, ...(def.description ? { description: def.description } : {}), owner: def.owner });
          }
          continue;
        }
        const list = this.consumers.get(tag) ?? [];
        const merged = list.some((t) => t.name === def.name)
          ? list
          : [...list, { name: def.name, ...(def.description ? { description: def.description } : {}), owner: def.owner }];
        byTag.set(tag, { tag, category: 'capability', tools: merged });
      }
    }
    // 校正增量缓存与 defs 的漂移（事件遗漏/时序差的兜底）
    for (const [tag, tools] of this.consumers) {
      if (byTag.has(tag)) continue;
      byTag.set(tag, { tag, category: tag.startsWith('agent:') ? 'owner' : 'capability', tools });
    }
    return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /**
   * 断言（档位/模式纪律的机制化）：非能力词（档位 + 全部 tc-* 模式词）
   * 被任何 requiredTags 引用即抛错——2026-09-17 优化裁决：tc-* 回归纯
   * 模式词（run_code 授权词 = infra；「程序化」是形态选择非授权门槛，
   * 会话覆盖/Agent tags 任一可选程序化档，无需预配标签）。启动期检查
   * （boot 后调用一次；测试/宿主可随时复查）。
   */
  assertNoTierInToolRequirements(): void {
    const modeWords = RESERVED.filter((r) => r.category !== 'capability').map((r) => r.tag);
    for (const def of this.ctx.tools.list()) {
      for (const t of def.requiredTags ?? []) {
        if (modeWords.includes(t)) {
          throw new Error(
            `工具 "${def.name}" 的 requiredTags 引用了非能力标签 "${t}"——档位/模式词由 tierOf / toolModeOf 单源判定（AgentConfig.tags），不进任何工具的能力门禁`,
          );
        }
      }
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 能力标签注册中心（ac-tag-registry 提供） */
    tagRegistry: TagRegistryService;
  }
}
