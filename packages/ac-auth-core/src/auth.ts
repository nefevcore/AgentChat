// ============================================================
// auth.ts —— 授权注册表 schema 与投影算法（授权草稿 B/C 节）
//
// 两层皆宿主单写（D3 修订「封死子树自授」）；壳恒只读、每 run 前重读
//（R-6 直读同构第四层）。投影算法（C 节）：
//   effective(agent) = { a ∈ 全局层有效条目 ∪ per-agent 内联条目 | a ∉ denials }
//                       ∩ 行集（装配期派生清单）
//   · denials 优先于一切（显式拒绝 > 全局授予 > per-agent 授予）
//   · children 不做运行时投影——物化即快照（R-5）
// ============================================================

// —— B1. 全局层 auth.json ——

export type GlobalAsset =
  | { kind: 'credential'; ref: string }   // credentials/ 内条目名（引用不复制）
  | { kind: 'row-load'; rowId: string }   // 行装载授权（装载 = 授权动作，cr-484）
  | { kind: 'mcp-server'; name: string }; // MCP 服务器放行（R-12）

export interface GlobalAuthEntry {
  /** 稳定条目 id（UUIDv7） */
  id: string;
  asset: GlobalAsset;
  grantedAt: string;
  grantSource: 'user-webui' | 'grant-letter' | 'install' | 'materialize';
  /** 墓碑：非空 = 已吊销（不物理删——审计 + 指纹稳定） */
  revokedAt?: string;
  note?: string;
}

export interface GlobalAuth {
  version: 1;
  /** additive-only：新增不改旧；删除 = 墓碑条目 */
  entries: GlobalAuthEntry[];
}

// —— B2. per-agent 层 agents/<id>/auth.json ——

/** 内联字面量资产（不进全局层的小额授予——per-agent 直享） */
export interface InlineAsset {
  kind: 'inline';
  /** 资产描述（自由形状——如只读目录路径；消费方按 kind 解释） */
  spec: Record<string, unknown>;
  note?: string;
}

/** 授权资产引用（globalId / row / mcp / inline 四选一） */
export type AssetRef =
  | { globalId?: string; row?: string; mcp?: string; inline?: InlineAsset }
    & ({ globalId: string } | { row: string } | { mcp: string } | { inline: InlineAsset });

export interface AgentAuth {
  version: 1;
  agentId: string;
  /** children 有：物化来源（快照溯源，R-5） */
  parentId?: string;
  /** children 有：spawn 时间 */
  materializedAt?: string;
  /** 授权资产引用集（全局条目 id 或内联字面量） */
  grants: AssetRef[];
  /** 显式拒绝集（投影减法项；user 对 child 的收紧） */
  denials: AssetRef[];
}

// —— C. 投影算法（纯函数——壳 tools 门每 run 前现算） ——

/** 投影产出的单条生效资产 */
export type EffectiveAsset =
  | { via: 'global'; entry: GlobalAuthEntry }
  | { via: 'inline'; asset: InlineAsset };

/** AssetRef 的稳定字面键（denials 匹配用：同类同目标即同键） */
function assetKeyOf(ref: AssetRef): string {
  if (ref.globalId !== undefined) return 'g:' + ref.globalId;
  if (ref.row !== undefined) return 'r:' + ref.row;
  if (ref.mcp !== undefined) return 'm:' + ref.mcp;
  return 'i:' + JSON.stringify(ref.inline?.spec ?? {});
}

function assetKeyOfGlobal(entry: GlobalAuthEntry): string {
  if (entry.asset.kind === 'credential') return 'c:' + entry.asset.ref;
  if (entry.asset.kind === 'row-load') return 'r:' + entry.asset.rowId;
  return 'm:' + entry.asset.name;
}

export interface ProjectionEnv {
  /** 全局层（数据根 auth.json 直读产物） */
  global: GlobalAuth;
  /** per-agent 层（agents/<id>/auth.json 直读产物；缺席 = 空） */
  agent: AgentAuth | undefined;
  /**
   * 行集（装配期派生清单——A9 全域单一）：行装载授权（row-load / row
   * 引用）只对装了该行的 agent 生效（声明面与授权面双闸）。
   */
  rowset: ReadonlySet<string>;
}

/**
 * 投影（C 节）：全局有效条目 ∪ per-agent 内联 − denials ∩ 行集。
 * credential 与 mcp-server 资产不受行集闸（非行装载语义）；row-load
 * 与 row 引用受行集闸。denials 匹配同类同目标（global 条目按其资产键，
 * 亦可用 globalId 直接指认）。
 */
export function projectEffective(env: ProjectionEnv): EffectiveAsset[] {
  const denials = env.agent?.denials ?? [];
  const denied = new Set<string>(denials.map(assetKeyOf));
  const deniedGlobalIds = new Set<string>(
    denials.filter((d) => d.globalId !== undefined).map((d) => d.globalId as string),
  );
  const out: EffectiveAsset[] = [];
  const seen = new Set<string>();
  // 1. 全局层有效条目（非墓碑）——denial 双路匹配：globalId 指认条目 / 资产键同类同目标
  for (const entry of env.global.entries) {
    if (entry.revokedAt) continue;
    const key = assetKeyOfGlobal(entry);
    if (denied.has(key) || deniedGlobalIds.has(entry.id)) continue;
    if (entry.asset.kind === 'row-load' && !env.rowset.has(entry.asset.rowId)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ via: 'global', entry });
  }
  // 2. per-agent 内联条目（grants 中 inline 形态）
  for (const ref of env.agent?.grants ?? []) {
    if (ref.inline === undefined) continue;
    const key = assetKeyOf(ref);
    if (denied.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ via: 'inline', asset: ref.inline });
  }
  // 3. per-agent 行引用授权（row 词汇——等效全局 row-load 但只授本 agent）
  for (const ref of env.agent?.grants ?? []) {
    if (ref.row === undefined) continue;
    const key = assetKeyOf(ref);
    if (denied.has(key) || seen.has(key)) continue;
    if (!env.rowset.has(ref.row)) continue;
    seen.add(key);
    out.push({ via: 'global', entry: {
      id: 'agent-row:' + ref.row,
      asset: { kind: 'row-load', rowId: ref.row },
      grantedAt: '',
      grantSource: 'grant-letter',
    } });
  }
  // 4. per-agent mcp 引用（同构——等效全局 mcp-server 放行但只授本 agent；
  //    影子派生授权 deriveChildAuth 产出此词汇）
  for (const ref of env.agent?.grants ?? []) {
    if (ref.mcp === undefined) continue;
    const key = assetKeyOf(ref);
    if (denied.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ via: 'global', entry: {
      id: 'agent-mcp:' + ref.mcp,
      asset: { kind: 'mcp-server', name: ref.mcp },
      grantedAt: '',
      grantSource: 'grant-letter',
    } });
  }
  return out;
}

// —— 影子派生授权（R-5：spawn ⊆ 授权投影，非授权状态变更——CLI 可 spawn 的成立条件） ——

/**
 * 派生子授权层：父投影快照为子内联 grants（快照非镜像——父此后改授权
 * 不传播），再叠加收紧 denials。产物 = 子 auth.json 的 AgentAuth 形态
 *（物化面归 agents-core children 树；本函数纯计算）。
 */
export function deriveChildAuth(input: {
  childId: string;
  parentId: string;
  parentEnv: ProjectionEnv;
  /** 追加收紧（默认空——子授权严格不多于父） */
  extraDenials?: AssetRef[];
  materializedAt: string;
}): AgentAuth {
  const parentAssets = projectEffective(input.parentEnv);
  // 父投影 → 子内联 grants（行装载授权转 row 引用词汇；credential/mcp 转 inline 快照）
  const grants: AssetRef[] = [];
  for (const a of parentAssets) {
    if (a.via === 'global' && a.entry.asset.kind === 'row-load') {
      grants.push({ row: a.entry.asset.rowId });
    } else if (a.via === 'global' && a.entry.asset.kind === 'credential') {
      grants.push({ inline: { kind: 'inline', spec: { credentialRef: a.entry.asset.ref }, note: 'derived from ' + a.entry.id } });
    } else if (a.via === 'global' && a.entry.asset.kind === 'mcp-server') {
      grants.push({ mcp: a.entry.asset.name });
    } else if (a.via === 'inline') {
      grants.push({ inline: a.asset });
    }
  }
  return {
    version: 1,
    agentId: input.childId,
    parentId: input.parentId,
    materializedAt: input.materializedAt,
    grants,
    denials: input.extraDenials ?? [],
  };
}
