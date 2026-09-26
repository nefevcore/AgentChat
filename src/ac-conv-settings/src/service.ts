// ============================================================
// ac-conv-settings/src/service.ts —— 会话设置服务（cordis Service）
//
// 本包是会话设置域契约的 owning package：域类型见 ./contract.ts，
// convSettings/* 事件目录见 ./events.ts。
//
// 持久化（规约 1：本服务 owns <root>/conv-settings/<conversationId>.json）：
//   · 文件名即 conversationId（规约 2）——对桶 `a~b` / 群 gid 均文件系统
//     安全（Agent id 禁 `~`/路径分隔/`..`，M19 承重墙；gid/sid 由各域
//     生成器保证无路径字符）；
//   · 原子写（tmp + rename，同 singles）；
//   · 覆盖语义：逐键可选，键删除 = 文件删除（无键可存即无文件）。
// 独立会话（sid）不进本域（singles session.json 自包含语义——防双源；
// 调用方边界分流：ChatInput 按会话形态选写口，web-api deliver 合并点
// 对 singles 会话跳过本服务查询）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type { ConvSettings } from './contract.ts';

export interface ConvSettingsRowOptions {
  /** 数据根目录（缺省 AGENTCHAT_DATA_ROOT → './data'；设置目录 = <root>/conv-settings） */
  root?: string;
}

/** conversationId 词法校验：非空，禁路径分隔/遍历/空白（对桶 `~` 合法） */
function assertConversationId(conversationId: string): void {
  if (
    !conversationId ||
    conversationId.includes('/') ||
    conversationId.includes('\\') ||
    conversationId.includes('..') ||
    /\s/.test(conversationId)
  ) {
    throw new Error(`conversationId "${conversationId}" 非法（非空，禁路径分隔 / .. / 空白）`);
  }
}

/**
 * 键描述：值域 + UI 展示元数据 + 能力等效声明。enum = 值域枚举
 * （undefined = 任意非空字符串）；label/group/order 供前端目录驱动
 * 渲染；options 逐值展示词；**grants = 值→等效能力标签映射**（会话
 * 覆盖为该值时向调用方能力集注入这些标签——工具可见性单源
 * capabilitySetOf 的会话维度扩展，见 ac-agents sessionCapsOf）。删键/
 * 未覆盖 = 不注入（回落 Agent tags）。
 */
export interface ConvSettingsKeyDef {
  key: string;
  enum?: string[];
  description?: string;
  /** UI 组（'experimental' = 实验性菜单渲染；缺省不出前端目录——纯消费面键） */
  group?: 'experimental';
  label?: string;
  order?: number;
  /** 值展示词表（enum 各值的 UI 文案；缺省直显枚举值） */
  options?: Record<string, string>;
  /** 值→等效能力标签（会话授权注入能力集——tier 类键的可见性通路） */
  grants?: Record<string, string[]>;
}

const BUILTIN_KEYS: ConvSettingsKeyDef[] = [
  { key: 'model', description: '会话级模型覆盖（name@model 引用或裸模型名）' },
  { key: 'elevation', enum: ['sandbox-access', 'full-access'], description: '会话提权水位（机制唤醒继承）' },
  { key: 'toolMode', enum: ['tc-base', 'tc-programmatic', 'tc-none'], description: '工具调用模式覆盖（tc-* 标签轴）' },
  {
    key: 'browserTier',
    enum: ['observe', 'manipulate', 'inject', 'disabled'],
    description: '浏览器档（CDP 直连）',
    group: 'experimental',
    label: '浏览器使用',
    order: 1,
    options: { observe: '只读浏览', manipulate: '交互操作', inject: 'JS 注入', disabled: '禁用浏览器' },
    grants: {
      observe: ['web', 'observe'],
      manipulate: ['web', 'observe', 'manipulate'],
      inject: ['web', 'observe', 'manipulate', 'inject'],
    },
  },
];


export class ConvSettingsService extends Service {
  private readonly settingsDir: string;
  /** 键目录：内置 + 生态行注册（注册即归属——卸载自动回收） */
  private keys = new Map<string, ConvSettingsKeyDef>();

  constructor(ctx: Context, options: ConvSettingsRowOptions = {}) {
    super(ctx, 'convSettings');
    this.settingsDir = path.resolve(
      options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data',
      'conv-settings',
    );
    for (const def of BUILTIN_KEYS) this.keys.set(def.key, def);
  }

  /**
   * 注册扩展键（生态行贡献会话覆盖键的正路——插件不能改 owning 包源码，
   * 经注册面进目录；值域枚举校验与内置键同一管线）。注册即归属：注册方
   * 卸载时键自动回收（此后新值不进；存量落盘值回读同校验也被清——
   * 消费方拿到空覆盖即回落默认，宽松降级不炸）。
   * 键冲突（含与内置键撞名）抛错——fail-loud 不静默覆盖。
   */
  registerKey(def: ConvSettingsKeyDef): void {
    if (this.keys.has(def.key)) throw new Error(`conv-settings 键 "${def.key}" 已注册`);
    this.keys.set(def.key, def);
    // 注册即归属：this.ctx 经 tracker 指向调用方插件 context——其卸载自动回收键
    this.ctx.fiber.effect(() => () => this.keys.delete(def.key), `convSettings.key:${def.key}`);
  }

  /** 键目录快照（治理/UI 展示） */
  listKeys(): ConvSettingsKeyDef[] {
    return [...this.keys.values()];
  }

  /** 键域校验单源：合法枚举值 → true；无此键/非法值 → false */
  private isValid(key: string, value: string): boolean {
    const def = this.keys.get(key);
    if (!def) return false;
    if (def.enum === undefined) return value !== '';
    return def.enum.includes(value);
  }

  /** 设置文件：<root>/conv-settings/<conversationId>.json */
  private fileOf(conversationId: string): string {
    return path.join(this.settingsDir, conversationId + '.json');
  }

  private readSettings(conversationId: string): ConvSettings {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.fileOf(conversationId), 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const raw = parsed as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        // 回读同校验：注册面回收后的存量值仍受值域把关（枚举变更 → 旧值静默清）
        if (typeof v === 'string' && this.keys.has(k) && this.isValid(k, v)) out[k] = v;
      }
      return out as unknown as ConvSettings;
    } catch {
      return {}; // 不存在/损坏 = 无覆盖
    }
  }

  private writeSettings(conversationId: string, settings: Record<string, string>): void {
    fs.mkdirSync(this.settingsDir, { recursive: true });
    const tmp = `${this.fileOf(conversationId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmp, this.fileOf(conversationId));
  }

  /** 读会话设置（无 → 空对象；零覆盖语义）。扩展键值以 Record 透出 */
  get(conversationId: string): ConvSettings {
    assertConversationId(conversationId);
    return this.readSettings(conversationId);
  }

  /**
   * 合并写（patch 键级：值覆盖、null = 删键；全空结果 = 删文件）。
   * 键域校验单源（isValid——内置与注册键同一管线）：合法枚举值原样
   * 写入，无此键/非法值 = 清除。emit conv-settings/updated（终态载荷
   * ——观察者见即所得）。
   */
  set(conversationId: string, patch: Record<string, string | boolean | null | undefined>): ConvSettings {
    assertConversationId(conversationId);
    const next = this.readSettings(conversationId) as unknown as Record<string, string>;
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string' && this.isValid(key, value)) next[key] = value;
      else delete next[key]; // null/undefined/非法值/未注册键 = 清除
    }
    if (Object.keys(next).length > 0) this.writeSettings(conversationId, next);
    else fs.rmSync(this.fileOf(conversationId), { force: true });
    this.ctx.emit('conv-settings/updated', conversationId, next, Object.keys(next).length > 0 ? 'set' : 'cleared');
    return next as unknown as ConvSettings;
  }

  /** 清除全部覆盖（删文件）；幂等 */
  clear(conversationId: string): void {
    assertConversationId(conversationId);
    const existed = fs.existsSync(this.fileOf(conversationId));
    fs.rmSync(this.fileOf(conversationId), { force: true });
    if (existed) this.ctx.emit('conv-settings/updated', conversationId, {}, 'cleared');
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话设置服务（ac-conv-settings 提供）：按 conversationId 的会话级覆盖（模型引用等） */
    convSettings: ConvSettingsService;
  }
}
