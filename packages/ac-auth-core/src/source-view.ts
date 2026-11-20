// ============================================================
// source-view.ts —— source 视图读授权词汇（cr-1166 timer-v3 §五/§七）
//
// InlineAsset.spec 定形：{ kind: 'source-view', source, view }——授权某
// Agent 读 exports/<source>/<view>/ 物化面（timer 源触发的配套读面）。
// 只走 per-agent inline（GlobalAsset 无此形态——源视图是小额直享，与
// inline 的定位一致，设计 §五「读授权：per-agent inline asset」）。
//
// 查询单源：timer set 校验（宿主 timer-face）、timers 行分发（防直改
// timer.json 绕过）、fs 工具读白名单（exports 双禁表上的授权豁免口）
// 三方共用 sourceViewsOf——权限口径一处定形不漂移。
// ============================================================
import { readAgentAuth } from './disk.ts';
import type { EffectiveAsset, ProjectionEnv } from './auth.ts';
import { projectEffective } from './auth.ts';

/** spec 判形（宽松读取——非法形态视同无授权） */
export function isSourceViewSpec(spec: Record<string, unknown> | undefined): spec is { kind: 'source-view'; source: string; view: string } {
  return spec !== undefined
    && (spec as { kind?: unknown }).kind === 'source-view'
    && typeof (spec as { source?: unknown }).source === 'string' && (spec as { source?: unknown }).source !== ''
    && typeof (spec as { view?: unknown }).view === 'string' && (spec as { view?: unknown }).view !== '';
}

/** 物化目录名（消费方拼 dataRoot 用） */
export function sourceViewDir(source: string, view: string): string {
  if (/[\\/]/.test(source) || source === '.' || source === '..') throw new Error('source 名含路径组件: ' + source);
  if (/[\\/]/.test(view) || view === '.' || view === '..') throw new Error('view 名含路径组件: ' + view);
  return source + '/' + view;
}

/**
 * Agent 的已授权 source 视图集（per-agent inline 投影——denials 生效、
 * 与 projectEffective 的 inline 路径同语义；rowset 不参与：inline 资产
 * 不受行集闸）。
 */
export function sourceViewsOf(dataRoot: string, agentId: string): Array<{ source: string; view: string }> {
  const agent = readAgentAuth(dataRoot, agentId);
  const env: ProjectionEnv = { global: { version: 1, entries: [] }, agent: agent ?? undefined, rowset: new Set() };
  const out: Array<{ source: string; view: string }> = [];
  for (const eff of projectEffective(env) as EffectiveAsset[]) {
    if (eff.via !== 'inline') continue;
    const spec = eff.asset.spec as Record<string, unknown> | undefined;
    if (isSourceViewSpec(spec)) out.push({ source: spec.source, view: spec.view });
  }
  return out;
}

/** 特定视图是否已授权（timer set 校验 + timers 分发共用判定） */
export function hasSourceView(dataRoot: string, agentId: string, source: string, view: string): boolean {
  return sourceViewsOf(dataRoot, agentId).some((sv) => sv.source === source && sv.view === view);
}
