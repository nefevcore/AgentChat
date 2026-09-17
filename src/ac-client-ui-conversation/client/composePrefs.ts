// ============================================================
// ac-client-ui-conversation/client/composePrefs.ts —— 输入栏
// 组合偏好持久化（上次会话选择回放）
//
// 输入栏工具栏五项选择（Agent/预设 · 模型 · 思考强度 · 快捷提权 ·
// 工具使用模式）的「上次选择」记录：localStorage 单键
// agentchat.composePrefs。新开会话（及视角切换重挂载）时回放——用户
// 不必每次重新设置。
//
// 归位说明（与 lastContext 同款裁决）：本件住 conversation 行 client
// （唯一读写方 ChatInput + 新建透传消费方 SessionList〔singles 行，
// 经 package.json 依赖面 import——conversation 行已是 singles 行的
// 依赖〕）；不引 DOM lib——localStorage 经结构化类型访问（本包进根
// tsc 程序），jsdom/node 环境缺省 undefined → try/catch 兜底无持久化。
//
// 语义边界：
//   · 记录的是「最后被用户选定的值」，不做会话级区分（全局一份）；
//   · 回放值仅作初值——Agent/模型在新建会话时作为创建参数透传
//     （服务端校验，失效静默回落），effort/elevation/programmatic
//     直接设为初值；
//   · effort ''/elevation '' 与「未记录」都合法记录值（''=明确选择
//     的关闭态/跟随态，回放时保持——非缺省值才覆写）。agentId/model
//     同语义（2026-09 修复）：'' = 明确选回默认预设/默认模型——写回
//     覆盖旧记录，新会话跟随（不再残留旧模式；'' ≠ 未记录）。
//     programmatic（2026-09-17 开关化）false 同为合法记录值（明确选
//     回标准模式）；true 只作 UI 回放初值——实际生效以会话
//     conv-settings 为准（选择即写会话，新会话不自动开）。
// ============================================================

/** 思考强度档位（与 ChatInput EFFORT_OPTIONS 同词表；''=关闭思考） */
export type ComposeEffort = '' | 'low' | 'high' | 'max';
/** 快捷提权档位（access-tier 档位词汇；''=跟随 Agent 自有档位） */
export type ComposeElevation = '' | 'sandbox-access' | 'full-access';
/** 工具使用模式（程序化开关，research §十；false=标准模式） */
export type ComposeProgrammatic = boolean;

/** 输入栏组合偏好（wire 形 = 持久形态；逐键可选） */
export interface ComposePrefs {
  /** 上次选定的 Agent/预设 id（新建独立会话透传；''=明确选了默认预设） */
  agentId?: string;
  /** 上次选定的模型（name@model 引用或裸名；''=明确选了默认模型） */
  model?: string;
  /** 上次思考强度（''=思考关闭） */
  effort?: ComposeEffort;
  /** 上次快捷提权档位（''=未武装） */
  elevation?: ComposeElevation;
  /** 上次工具使用模式（false=标准；true=程序化——选择即写会话 conv-settings，回放仅作 UI 初值） */
  programmatic?: ComposeProgrammatic;
}

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——既有 try/catch 兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

const KEY = 'agentchat.composePrefs';

const EFFORTS = new Set<ComposeEffort>(['', 'low', 'high', 'max']);
const ELEVATIONS = new Set<ComposeElevation>(['', 'sandbox-access', 'full-access']);

/** 读取组合偏好（无记录/损坏 → null：全部走各控件缺省值。
 *  agentId/model 的 '' 是合法记录值（明确选回默认）——带出供消费方
 *  区分「未记录」与「选了默认」；SessionList 透传时 '' 不进创建参数
 *  （singles/create 的 agentId 缺省即默认预设）。 */
export function loadComposePrefs(): ComposePrefs | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: ComposePrefs = {};
    for (const key of ['agentId', 'model'] as const) {
      if (typeof v[key] === 'string') out[key] = v[key] as string;
    }
    if (typeof v.effort === 'string' && EFFORTS.has(v.effort as ComposeEffort)) out.effort = v.effort as ComposeEffort;
    if (typeof v.elevation === 'string' && ELEVATIONS.has(v.elevation as ComposeElevation)) out.elevation = v.elevation as ComposeElevation;
    if (typeof v.programmatic === 'boolean') out.programmatic = v.programmatic;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null; // 损坏/不可用：无偏好回放
  }
}

/** 合并写（patch 键级：值覆盖；未识别键忽略）。失败静默（无 localStorage 面）。
 *  agentId/model 的 '' 同为合法写值——明确选回默认时覆盖旧记录（新会话
 *  跟随），与 effort/elevation 的关闭态语义一致。 */
export function saveComposePrefs(patch: ComposePrefs): void {
  try {
    const next: ComposePrefs = { ...(loadComposePrefs() ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'agentId':
        case 'model':
          if (typeof value === 'string') (next as Record<string, unknown>)[key] = value;
          break;
        case 'effort':
          if (typeof value === 'string' && EFFORTS.has(value as ComposeEffort)) next.effort = value as ComposeEffort;
          break;
        case 'elevation':
          if (typeof value === 'string' && ELEVATIONS.has(value as ComposeElevation)) next.elevation = value as ComposeElevation;
          break;
        case 'programmatic':
          if (typeof value === 'boolean') next.programmatic = value;
          break;
        default:
          break; // 未知键忽略（wire 宽容）
      }
    }
    store?.setItem(KEY, JSON.stringify(next));
  } catch { /* ignore：不可用即无持久化 */ }
}
