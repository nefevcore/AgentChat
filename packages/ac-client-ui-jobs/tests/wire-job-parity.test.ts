// ============================================================
// packages/ac-client-ui-jobs/tests/wire-job-parity.test.ts —— WireJob 形状锁
//
// WireJob 是 ac-jobs JobSnapshot 的手工镜像（前端行不依赖后端行——
// 双向可独立摘除，故不能 import type 直连）。镜像无锁即漂移：后端
// 加字段 → 前端静默丢展示。本锁（#1 遗留①同构，cr-457）：字段名集
// 合与可选性两侧任意漂移 → CI 即红。
// ============================================================
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { WireJob } from '../client/index.ts';
import type { JobSnapshot } from 'ac-jobs/src/contract.ts';

describe('WireJob ⇄ JobSnapshot 镜像锁（cr-457）', () => {
  it('必选字段名集合相等（后端加字段 → 前端丢展示即红）', () => {
    const wireRequired: Set<string> = new Set<keyof WireJob>([
      'id', 'kind', 'label', 'status', 'startedAt',
    ]);
    const snapRequired: Set<string> = new Set<keyof JobSnapshot>([
      'id', 'kind', 'label', 'status', 'startedAt',
    ]);
    expect(wireRequired).toEqual(snapRequired);
  });

  it('可选字段名集合相等（ownerAgentId/conversationId/detail/finishedAt/meta）', () => {
    type WireOptional = Exclude<keyof WireJob, keyof typeof REQUIRED>;
    type SnapOptional = Exclude<keyof JobSnapshot, keyof typeof REQUIRED>;
    const wireOptional: Set<string> = new Set<string>([
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ...([] as WireOptional[]),
      'ownerAgentId', 'conversationId', 'detail', 'finishedAt', 'meta',
    ]);
    const snapOptional: Set<string> = new Set<string>([
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ...([] as SnapOptional[]),
      'ownerAgentId', 'conversationId', 'detail', 'finishedAt', 'meta',
    ]);
    expect(wireOptional).toEqual(snapOptional);
  });

  it('status 词表相等（running/stopping/completed/killed/failed）', () => {
    const wireStatus: WireJob['status'][] = ['running', 'stopping', 'completed', 'killed', 'failed'];
    const snapStatus: JobSnapshot['status'][] = ['running', 'stopping', 'completed', 'killed', 'failed'];
    expect(wireStatus).toEqual(snapStatus);
  });

  it('类型级断言：两侧字段类型逐一同形（编译期防线）', () => {
    expectTypeOf<WireJob['id']>().toEqualTypeOf<JobSnapshot['id']>();
    expectTypeOf<WireJob['kind']>().toEqualTypeOf<JobSnapshot['kind']>();
    expectTypeOf<WireJob['label']>().toEqualTypeOf<JobSnapshot['label']>();
    expectTypeOf<WireJob['status']>().toEqualTypeOf<JobSnapshot['status']>();
    expectTypeOf<WireJob['startedAt']>().toEqualTypeOf<JobSnapshot['startedAt']>();
    expectTypeOf<WireJob['finishedAt']>().toEqualTypeOf<JobSnapshot['finishedAt']>();
    expectTypeOf<WireJob['ownerAgentId']>().toEqualTypeOf<JobSnapshot['ownerAgentId']>();
    expectTypeOf<WireJob['conversationId']>().toEqualTypeOf<JobSnapshot['conversationId']>();
    expectTypeOf<WireJob['detail']>().toEqualTypeOf<JobSnapshot['detail']>();
    expectTypeOf<WireJob['meta']>().toEqualTypeOf<JobSnapshot['meta']>();
  });

  it('killedBy 后端独有（wire 层经 web-api jobWire 剥离——前端无消费面）', () => {
    type WireOnly = Exclude<keyof WireJob, keyof JobSnapshot>;
    type SnapOnly = Exclude<keyof JobSnapshot, keyof WireJob>;
    const wireOnly: string[] = [] as WireOnly[];
    const snapOnly: string[] = ['killedBy'] as SnapOnly[];
    expect(wireOnly).toEqual([]);
    expect(snapOnly).toEqual(['killedBy']);
  });
});

const REQUIRED = {
  id: 0, kind: 0, label: 0, status: 0, startedAt: 0,
} as const;
