// ============================================================
// member-trace.test.ts —— 群成员轨迹下钻读键（cr-1328 dual-view P4a）
//
// fetchPairHistory convKey：成员流键 gid~member 原序直传（不 sort——
// member 恒最右键库规格）；缺席回落 pairKey sort 语义（现状不变）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { fetchPairHistory } from 'ac-client-ui-conversation/client/historyApi.ts';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const rpc = {
  call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { records: [] };
  },
};

describe('cr-1328 P4a：成员流读键原序直传', () => {
  it('convKey 在场：conversationId 原样直传（不 sort 重排）', async () => {
    calls.length = 0;
    await fetchPairHistory('g-x', 'zeta', 50, 0, rpc as never, undefined, 'g-x~zeta');
    expect(calls[0]!.params.conversationId).toBe('g-x~zeta');
  });

  it('convKey 缺席：pairKey 语义不变（sort 键）', async () => {
    calls.length = 0;
    await fetchPairHistory('beta', 'alpha', 50, 0, rpc as never);
    expect(calls[0]!.params.conversationId).toBe('alpha~beta');
  });
});
