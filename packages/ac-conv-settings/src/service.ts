// ============================================================
// ac-conv-settings/src/service.ts —— 会话设置服务（cordis Service）
//
// 本包是会话设置域契约的 owning package：域类型见 ./contract.ts，
// convSettings/* 事件目录见 ./events.ts。
//
// 持久化（规约 1：本服务 owns <root>/meta/conv-settings/<conversationId>.json
// ——数据分层第二层；读侧兼容窗回落旧位置 <root>/conv-settings/<id>.json）：
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
import { humanPresentOf } from 'ac-agents';
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
 * 键描述：纯 UI 展示元数据（cr-1092 grants 随轴退役——值→能力标签注入
 * 通路整体删除，会话授权由消费方直读 effective；enum = UI 选项列表（泛写口
 * 渲染数据源；不承担值域校验——cr-1091 落盘即真相，垃圾值由消费方
 * 天然回落兜底）；label/group/order 供前端目录驱动渲染；options 逐值
 * 展示词。
 * 作用域（cr-1083 conv-scope）：**全部键默认仅有人会话生效**——行为由
 * 读取面统一保证（effective：无人桶恒 {}），ConvSettingsKeyDef 不加
 * per-key 字段（全键统一语义；未来确需无人桶生效的键再加 opt-out）。
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
  /**
   * 选择即写（cr-1259）：泛写口按此分流写时机——true = 控件选择即落盘
   * （per-step 生效），false/缺省 = 发送边界随 flush 一次 patch。**只标给
   * 消费方逐调用读取的键**（写落盘即被下一次消费看见——「写即生效」语义
   * 自洽）；run 装配点读的键（toolMode 收窄工具面）mid-run 写不改变进行中
   * run 的行为，反而制造「改了没生效」的模糊态，不得标。
   */
  immediate?: boolean;
}

const BUILTIN_KEYS: ConvSettingsKeyDef[] = [
  { key: 'model', description: '会话级模型覆盖（name@model 引用或裸模型名）' },
  //（cr-1082：access 键随轴整体退役——「会话级武装」语义并入 approval
  // 键〔设置链 allow = 免弹卡，注 sandbox-access——cr-1248 注入分级〕；
  // 存量 857 键清理见迁移脚本）
  {
    // cr-1049 开放词：核心两档 + 扩展档（tc- 前缀任意——注册表校验在投影
    // 端兜底，未注册词回退常规面 + warn〔cr-1021〕，写入面不跨进程查表）
    key: 'toolMode',
    description: '工具调用模式覆盖（tc-* 轴——核心 tc-base/tc-none + 扩展档开放词）',
  },
  {
    key: 'browserTier',
    enum: ['observe', 'manipulate', 'inject', 'disabled'],
    description: '浏览器档（CDP 直连）',
    group: 'experimental',
    label: '浏览器使用',
    order: 1,
    options: { observe: '只读浏览', manipulate: '交互操作', inject: 'JS 注入', disabled: '禁用浏览器' },
  },
  {
    // cr-1066 权限门：ask 建议的归宿键。cr-1261 会话层四档：allow-sandbox
    // （免卡，沙箱照拦）/ allow-full（免卡全权——越沙箱与机密读默认表）/
    // ask（弹卡，缺省）/ deny（拒）。存量 'allow' 读侧映射 allow-sandbox
    // （保守兼容）；第二/三层（Agent/全局 onAsk）维持三值不受本键值域影响。
    // 进内置键而非门行 registerKey：壳/宿主分树下垫片注册的键宿主 set 面
    // 不认识，内置注册打通宿主读写链全链。
    key: 'approval',
    enum: ['allow-sandbox', 'allow-full', 'ask', 'deny'],
    description: '权限门审批（ask 建议的归宿：allow-sandbox 沙箱内直过 / allow-full 全权直过 / ask 弹卡（缺省）/ deny 拒绝）',
    group: 'experimental',
    label: '工具审批',
    order: 4,
    options: {
      'allow-sandbox': '沙箱内自动放行（越界仍拦）',
      'allow-full': '全权放行（含沙箱外路径/机密文件，慎用）',
      ask: '每次询问（缺省）',
      deny: '本会话一律拒绝',
    },
    // cr-1259：门 onAskOf 逐工具调用读 effective——选择即写落盘即生效
    // （进行中 run 的下一次 tool call 即见；草稿位无会话键仍走发送边界）。
    immediate: true,
  },
  {
    // cr-41：submit_issue 会话开关（用户 2）——输入框「实验性」目录驱动
    // 出现（group experimental，零前端改动）。enabled = 跟随装载
    //（issue-tools 行在装即可用——cr-953 后授权 = 行装载单闸），
    // disabled = 执行前置拦截（issue-tools execute 自查）。
    key: 'issueSubmit',
    enum: ['enabled', 'disabled'],
    description: '跟随装载（issue-tools 行）',
    group: 'experimental',
    label: 'ISSUE 提交',
    order: 2,
    options: { enabled: '本会话启用', disabled: '禁用（防敏感信息外发）' },
  },
];


export class ConvSettingsService extends Service {
  private readonly settingsDir: string;
  /** 兼容窗旧目录（<root>/conv-settings——读侧回落，写侧恒新目录） */
  private readonly legacyDir: string;
  /** 键目录：内置 + 生态行注册（注册即归属——卸载自动回收） */
  private keys = new Map<string, ConvSettingsKeyDef>();

  constructor(ctx: Context, options: ConvSettingsRowOptions = {}) {
    super(ctx, 'convSettings');
    const root = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    // 数据分层第二层：会话设置是小而珍贵、不可重建的用户域源数据，
    // 迁入 meta/（此前在数据根顶层）
    this.settingsDir = path.join(root, 'meta', 'conv-settings');
    this.legacyDir = path.join(root, 'conv-settings');
    for (const def of BUILTIN_KEYS) this.keys.set(def.key, def);
  }

  /**
   * 注册扩展键（生态行贡献会话覆盖键的正路——插件不能改 owning 包源码，
   * 经注册面进目录）。注册即归属：注册方卸载时键自动回收（此后不再出现
   * 在键目录/UI；已落盘值保留不清理——消费方天然回落兜底，cr-1091）。
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

  /** 设置文件：meta/conv-settings/<conversationId>.json（兼容窗旧位置回落） */
  private fileOf(conversationId: string): string {
    return path.join(this.settingsDir, conversationId + '.json');
  }

  /** 兼容窗旧文件（<root>/conv-settings/<id>.json——只读不写，不物理迁移） */
  private legacyFileOf(conversationId: string): string {
    return path.join(this.legacyDir, conversationId + '.json');
  }

  private readSettings(conversationId: string): ConvSettings {
    try {
      // 新位置缺席 → 回落旧位置（寄居期文件不迁移；新文件在场恒胜出）
      let text: string;
      try {
        text = fs.readFileSync(this.fileOf(conversationId), 'utf-8');
      } catch {
        text = fs.readFileSync(this.legacyFileOf(conversationId), 'utf-8');
      }
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const raw = parsed as Record<string, unknown>;
      //（cr-1082：access/elevation 读窗随轴退役——存量值静默失效，
      // 由清理脚本物理删除）
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        // cr-1091 回读不校验键域：落盘即真相（字符串即透出——壳侧 Shim
        // 同读法；垃圾值由消费方天然回落兜底）
        if (typeof v === 'string') out[k] = v;
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
   * 决策面读取（cr-1083 conv-scope 批1）：无人桶（self a~a / agent~agent /
   * g-<gid>~member——humanPresentOf 单源）恒返 {}。会话键是用户偏好载体，
   * 无人桶无用户偏好可言——残留键值不得压 Agent 侧同语义配置。get 保持
   * 原样（展示面读残留）；一切参与决策/合成/继承的读取换本方法。
   */
  effective(conversationId: string): ConvSettings {
    return humanPresentOf(conversationId) ? this.get(conversationId) : {};
  }

  /**
   * 合并写（patch 键级：值覆盖、null = 删键；全空结果 = 删文件）。
   * 字符串值原样写入——键域校验已退役（cr-1091：落盘即真相，垃圾值
   * 由消费方天然回落兜底）。emit conv-settings/updated（终态载荷
   * ——观察者见即所得）。
   */
  set(conversationId: string, patch: Record<string, string | null | undefined>): ConvSettings {
    assertConversationId(conversationId);
    const next = this.readSettings(conversationId) as unknown as Record<string, string>;
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string') next[key] = value;
      else delete next[key]; // null/undefined = 清除
    }
    if (Object.keys(next).length > 0) this.writeSettings(conversationId, next);
    else {
      // 全空 = 删文件：新旧两位置一并清（只清新位置会让旧文件复活旧值）
      fs.rmSync(this.fileOf(conversationId), { force: true });
      fs.rmSync(this.legacyFileOf(conversationId), { force: true });
    }
    this.ctx.emit('conv-settings/updated', conversationId, next, Object.keys(next).length > 0 ? 'set' : 'cleared');
    return next as unknown as ConvSettings;
  }

}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话设置服务（ac-conv-settings 提供）：按 conversationId 的会话级覆盖（模型引用等） */
    convSettings: ConvSettingsService;
  }
}
