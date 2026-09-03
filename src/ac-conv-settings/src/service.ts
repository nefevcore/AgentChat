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

export class ConvSettingsService extends Service {
  private readonly settingsDir: string;

  constructor(ctx: Context, options: ConvSettingsRowOptions = {}) {
    super(ctx, 'convSettings');
    this.settingsDir = path.resolve(
      options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data',
      'conv-settings',
    );
  }

  /** 设置文件：<root>/conv-settings/<conversationId>.json */
  private fileOf(conversationId: string): string {
    return path.join(this.settingsDir, conversationId + '.json');
  }

  private readSettings(conversationId: string): ConvSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileOf(conversationId), 'utf-8')) as Partial<ConvSettings>;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: ConvSettings = {};
      if (typeof raw.model === 'string' && raw.model) out.model = raw.model;
      return out;
    } catch {
      return {}; // 不存在/损坏 = 无覆盖
    }
  }

  private writeSettings(conversationId: string, settings: ConvSettings): void {
    fs.mkdirSync(this.settingsDir, { recursive: true });
    const tmp = `${this.fileOf(conversationId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmp, this.fileOf(conversationId));
  }

  /** 读会话设置（无 → 空对象；零覆盖语义） */
  get(conversationId: string): ConvSettings {
    assertConversationId(conversationId);
    return this.readSettings(conversationId);
  }

  /**
   * 合并写（patch 键级：值覆盖、null/'' = 删键；全空结果 = 删文件）。
   * emit conv-settings/updated（终态载荷——观察者见即所得）。
   */
  set(conversationId: string, patch: Record<string, string | null | undefined>): ConvSettings {
    assertConversationId(conversationId);
    const next = this.readSettings(conversationId);
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'model') continue; // 首期唯一键；未知键忽略（wire 宽容）
      if (value === null || value === undefined || value === '') delete next.model;
      else next.model = value;
    }
    if (Object.keys(next).length > 0) this.writeSettings(conversationId, next);
    else fs.rmSync(this.fileOf(conversationId), { force: true });
    this.ctx.emit('conv-settings/updated', conversationId, next, Object.keys(next).length > 0 ? 'set' : 'cleared');
    return next;
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
