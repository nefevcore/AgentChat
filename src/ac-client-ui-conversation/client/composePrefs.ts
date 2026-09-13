// ============================================================
// ac-client-ui-conversation/client/composePrefs.ts —— 输入栏
// 组合偏好持久化（上次会话选择回放）
//
// 输入栏工具栏四项选择（Agent/预设 · 模型 · 思考强度 · 快捷提权）
// 的「上次选择」记录：localStorage 单键 agentchat.composePrefs。
// 新开会话（及视角切换重挂载）时回放——用户不必每次重新设置。
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
//     （服务端校验，失效静默回落），effort/elevation 直接设为初值；
//   · effort ''/elevation '' 与「未记录」都合法记录值（''=明确选择
//     的关闭态/跟随态，回放时保持——非缺省值才覆写）。
// ============================================================

/** 思考强度档位（与 ChatInput EFFORT_OPTIONS 同词表；''=关闭思考） */
export type ComposeEffort = '' | 'low' | 'high' | 'max';
/** 快捷提权档位（access-tier 档位词汇；''=跟随 Agent 自有档位） */
export type ComposeElevation = '' | 'sandbox-access' | 'full-access';

/** 输入栏组合偏好（wire 形 = 持久形态；逐键可选） */
export interface ComposePrefs {
  /** 上次选定的 Agent/预设 id（新建独立会话透传；''=默认预设） */
  agentId?: string;
  /** 上次选定的模型（name@model 引用或裸名；''=默认模型） */
  model?: string;
  /** 上次思考强度（''=思考关闭） */
  effort?: ComposeEffort;
  /** 上次快捷提权档位（''=未武装） */
  elevation?: ComposeElevation;
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

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** 读取组合偏好（无记录/损坏 → null：全部走各控件缺省值） */
export function loadComposePrefs(): ComposePrefs | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: ComposePrefs = {};
    const agentId = asString(v.agentId);
    if (agentId) out.agentId = agentId;
    const model = asString(v.model);
    if (model) out.model = model;
    if (typeof v.effort === 'string' && EFFORTS.has(v.effort as ComposeEffort)) out.effort = v.effort as ComposeEffort;
    if (typeof v.elevation === 'string' && ELEVATIONS.has(v.elevation as ComposeElevation)) out.elevation = v.elevation as ComposeElevation;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null; // 损坏/不可用：无偏好回放
  }
}

/** 合并写（patch 键级：值覆盖；未识别键忽略）。失败静默（无 localStorage 面） */
export function saveComposePrefs(patch: ComposePrefs): void {
  try {
    const next: ComposePrefs = { ...(loadComposePrefs() ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'agentId':
        case 'model':
          if (typeof value === 'string' && value) (next as Record<string, unknown>)[key] = value;
          break;
        case 'effort':
          if (typeof value === 'string' && EFFORTS.has(value as ComposeEffort)) next.effort = value as ComposeEffort;
          break;
        case 'elevation':
          if (typeof value === 'string' && ELEVATIONS.has(value as ComposeElevation)) next.elevation = value as ComposeElevation;
          break;
        default:
          break; // 未知键忽略（wire 宽容）
      }
    }
    store?.setItem(KEY, JSON.stringify(next));
  } catch { /* ignore：不可用即无持久化 */ }
}
