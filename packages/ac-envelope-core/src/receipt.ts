// ============================================================
// receipt.ts —— 观察回执 payload schema（五步闭环步 4；R-7 回执三元组）
//
// 双向（D5 环）：成功 = 新版本指纹 + 行状态；失败 = 已回退至的根。
// rollbackTargets 不裸列根——恒 (根, 快照时间, 健康证据) 三元组
//（R-7 回滚目标规则）。回执进 agent 经验流（与 R-4 装载回执同构——
// 静默生效是反自治的）。kind = receipt → ledger-only（不进 inbox A4）。
// ============================================================

import type { Envelope } from './envelope.ts';

/** 回滚目标三元组（R-7 裁决形态） */
export interface RollbackTargetRef {
  root: string;
  snapshotId: string;
  takenAt: string;
  evidence: 'boot-smoke' | 'run-settled' | 'bench-gate';
  epoch?: string;
}

/** 观察回执 payload（kind = receipt） */
export interface ReceiptPayload {
  /** 回执类别：upgrade-success / upgrade-failed */
  subject: 'upgrade-success' | 'upgrade-failed';
  /** 升级目标主体指纹根（成功 = 生效根；失败 = 未生效根） */
  root: string;
  /** 变更主体（agent id / host） */
  agent: string;
  ok: boolean;
  /** 成功线：本快照点 id（新 last known good） */
  snapshotId?: string;
  /** 失败线：已回退至的快照 id 与根 */
  rolledBackTo?: { snapshotId: string; root: string };
  /** 可退目标列（R-7 三元组——最新在前） */
  rollbackTargets: RollbackTargetRef[];
  /** 失败原因（失败线） */
  reason?: string;
  /** 注释性伴随 */
  note?: string;
}

/** 构造观察回执信封（宿主 → 被影响 agent） */
export function makeReceiptEnvelope(input: {
  uuid: string;
  requestId: string;
  to: string;
  payload: ReceiptPayload;
}): Envelope {
  return {
    uuid: input.uuid,
    requestId: input.requestId,
    sender: 'host',
    to: input.to,
    kind: 'receipt',
    budget: 0,
    payload: input.payload,
  };
}

/** payload 结构校验（纯函数——fail-closed 只收集） */
export function validateReceiptPayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<ReceiptPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  if (p.subject !== 'upgrade-success' && p.subject !== 'upgrade-failed') issues.push('subject 非法');
  if (typeof p.root !== 'string' || p.root.length === 0) issues.push('root 缺席');
  if (typeof p.agent !== 'string' || p.agent.length === 0) issues.push('agent 缺席');
  if (typeof p.ok !== 'boolean') issues.push('ok 非布尔');
  if (!Array.isArray(p.rollbackTargets)) issues.push('rollbackTargets 缺席');
  else {
    for (const t of p.rollbackTargets) {
      const tt = t as Partial<RollbackTargetRef>;
      if (typeof tt.root !== 'string' || typeof tt.snapshotId !== 'string' || typeof tt.takenAt !== 'string') {
        issues.push('rollbackTargets 含非三元组条目');
        break;
      }
    }
  }
  if (p.subject === 'upgrade-success' && p.ok !== true) issues.push('成功回执 ok 须 true');
  if (p.subject === 'upgrade-failed' && p.ok !== false) issues.push('失败回执 ok 须 false');
  if (p.subject === 'upgrade-failed' && (p.rolledBackTo === undefined || typeof p.rolledBackTo.snapshotId !== 'string')) {
    issues.push('失败回执缺 rolledBackTo');
  }
  return issues;
}
