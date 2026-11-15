// ============================================================
// ac-host-face-core/tests/promise.test.ts —— 静态承诺面常量形状（cr-1114 批1）
//
// 单源下沉后的形状锁定：宿主行 discover 与壳侧 boot 注册消费同一常量，
// 此处锁名/词面基线防漂移（改词面 = 显式改本测试）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { HOST_FACE_TOOLS, HOST_FACE_SECTIONS, HOST_FACE_PROMISE_SECTIONS } from '../src/index.ts';
import { isHostFaceFrame } from '../src/index.ts';

describe('host-face 静态承诺面（cr-1114 批1）', () => {
  it('HOST_FACE_TOOLS：timer + update_agent_profile，schema 完整', () => {
    expect(HOST_FACE_TOOLS.map((t) => t.name)).toEqual(['timer', 'update_agent_profile']);
    for (const t of HOST_FACE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('承诺面段 = 壳内恒无 owner 的段（GUIDELINES_TIMER）；全量段含补位段', () => {
    expect(HOST_FACE_PROMISE_SECTIONS.map((s) => s.name)).toEqual(['GUIDELINES_TIMER']);
    const names = HOST_FACE_SECTIONS.map((s) => s.name);
    expect(names).toContain('TERMINOLOGY');
    expect(names).toContain('GUIDELINES_COLLAB');
    expect(names).toContain('GUIDELINES_TIMER');
    // 承诺面 ⊆ 全量段
    for (const p of HOST_FACE_PROMISE_SECTIONS) {
      const inAll = HOST_FACE_SECTIONS.find((s) => s.name === p.name);
      expect(inAll).toBeDefined();
      expect(inAll!.text).toBe(p.text);
    }
  });
});

void isHostFaceFrame;
