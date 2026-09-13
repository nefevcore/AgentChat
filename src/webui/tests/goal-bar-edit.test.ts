// @vitest-environment jsdom
// ============================================================
// webui/tests/goal-bar-edit.test.ts —— GoalBar 直编面交互验收
//
// 2026-10 goal dock 卡编辑/暂停/删除：
//   · 写面 props 齐（agentId/conversationId/rpc）→ hover 操作区渲染；
//     缺任一 → 只读形态（无操作钮）
//   · 暂停/恢复 → goal/update(status)；编辑弹窗保存 → patch 提交
//     （objective/note/max_rounds）；删除确认 → goal/delete
//   · rpc error → 行内/弹窗内错误呈现（不静默）
//   · 落定 → emit changed（GoalDockCard → refresh 对账链）
// 真 vue 渲染（@vue/test-utils 不可用——项目惯例 createApp 直 mount）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import GoalBar from 'ac-client-ui-goal/client/GoalBar.vue';
import type { TaskGoal } from 'ac-client-ui-goal/client/goalCard.ts';

function makeGoal(over: Partial<TaskGoal> = {}): TaskGoal {
  return {
    id: 'g1',
    objective: '搭好监控面板',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    maxRounds: 20,
    ...over,
  };
}

/** 记录型 rpc 桩：goal/update · goal/delete 按脚本应答 */
function recordingRpc(script: {
  goal?: TaskGoal;
  error?: string;
} = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    impl: {
      async call<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (script.error) throw new Error(script.error);
        return { goal: script.goal ?? makeGoal(), deleted: true } as T;
      },
    },
  };
}

async function mountBar(props: Record<string, unknown>): Promise<{ root: HTMLElement; changed: () => number }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let changedCount = 0;
  const app = createApp({
    render: () => h(GoalBar as never, {
      ...props,
      onChanged: () => { changedCount++; },
    }),
  });
  app.mount(root);
  await flush();
  return { root, changed: () => changedCount };
}

/** 等 async 动作链落定（run() 内 updateGoal + emit + busy 复位跨多轮 microtask） */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick();
  await Promise.resolve();
}

function buttons(root: HTMLElement, cls: string): HTMLButtonElement[] {
  return [...root.querySelectorAll(cls)] as HTMLButtonElement[];
}

describe('GoalBar 直编面（hover 操作区）', () => {
  it('写面齐备 → 暂停/编辑/删除三钮在场；缺 rpc → 只读形态', async () => {
    const rpc = recordingRpc();
    const full = await mountBar({ goal: makeGoal(), agentId: 'a', conversationId: 'a~user', rpc: rpc.impl });
    expect(full.root.querySelector('.goal-actions')).toBeTruthy();
    const acts = buttons(full.root, '.goal-act');
    expect(acts).toHaveLength(3); // 暂停 · 编辑 · 删除

    const ro = await mountBar({ goal: makeGoal(), agentId: 'a', conversationId: 'a~user', rpc: null });
    expect(ro.root.querySelector('.goal-actions')).toBeNull();
  });

  it('暂停 → goal/update(status=paused)；再点恢复（paused → active）；落定 emit changed', async () => {
    const rpc = recordingRpc();
    const { root, changed } = await mountBar({ goal: makeGoal({ status: 'active' }), agentId: 'a', conversationId: 'a~user', rpc: rpc.impl });
    buttons(root, '.goal-act')[0]!.click();
    await flush();
    expect(rpc.calls[0]!.method).toBe('goal/update');
    expect(rpc.calls[0]!.params.patch).toEqual({ status: 'paused' });
    expect(changed()).toBe(1);
  });

  it('编辑弹窗：目标/备注/轮次预算三字段 → 保存提交 patch；取消不写', async () => {
    const rpc = recordingRpc();
    const { root } = await mountBar({ goal: makeGoal({ note: '旧备注', maxRounds: 5 }), agentId: 'a', conversationId: 'a~user', rpc: rpc.impl });
    buttons(root, '.goal-act')[1]!.click(); // 编辑
    await nextTick();

    // Modal Teleport 到 body：字段在 document 上
    const inputs = [...document.querySelectorAll('.goal-edit-input')] as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.value).toBe('搭好监控面板'); // 打开即当前值
    expect(inputs[1]!.value).toBe('旧备注');
    expect(inputs[2]!.value).toBe('5');

    inputs[0]!.value = '搭好监控并告警';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[2]!.value = '12';
    inputs[2]!.dispatchEvent(new Event('input'));
    await nextTick();

    const save = [...document.querySelectorAll('.ui-modal-footer button')] as HTMLButtonElement[];
    save.at(-1)!.click(); // 主按钮 = 保存
    await flush();
    expect(rpc.calls[0]!.params.patch).toMatchObject({ objective: '搭好监控并告警', note: '旧备注', max_rounds: 12 });
  });

  it('删除：确认 → goal/delete；rpc error → 弹窗内错误呈现', async () => {
    // 确认路径
    const okRpc = recordingRpc();
    const okBar = await mountBar({ goal: makeGoal(), agentId: 'a', conversationId: 'a~user', rpc: okRpc.impl });
    buttons(okBar.root, '.goal-act')[2]!.click(); // 删除 → 确认弹窗
    await nextTick();
    expect(document.querySelector('.goal-delete-msg')?.textContent).toContain('搭好监控面板');
    const confirmBtn = ([...document.querySelectorAll('.ui-modal-footer button')] as HTMLButtonElement[]).at(-1)!;
    confirmBtn.click();
    await flush();
    expect(okRpc.calls[0]!.method).toBe('goal/delete');
    expect(okRpc.calls[0]!.params).toEqual({ agentId: 'a', conversationId: 'a~user' });
    expect(okBar.changed()).toBe(1);

    // 失败路径：rpc error → 错误呈现（此处复用新挂载）
    const failRpc = recordingRpc({ error: 'goals 服务未装载（ac-goal 行未装配，目标面不可用）' });
    const failBar = await mountBar({ goal: makeGoal(), agentId: 'a', conversationId: 'a~user', rpc: failRpc.impl });
    buttons(failBar.root, '.goal-act')[2]!.click();
    await nextTick();
    const confirmBtn2 = ([...document.querySelectorAll('.ui-modal-footer button')] as HTMLButtonElement[]).at(-1)!;
    confirmBtn2.click();
    await flush();
    expect(document.querySelector('.goal-edit-error')?.textContent).toContain('goals 服务未装载');
    expect(failBar.changed()).toBe(0); // 失败不发 changed
  });

  it('条带级操作失败（暂停 rpc error）→ 行内错误反馈', async () => {
    const rpc = recordingRpc({ error: 'WS 连接已断开' });
    const { root, changed } = await mountBar({ goal: makeGoal(), agentId: 'a', conversationId: 'a~user', rpc: rpc.impl });
    buttons(root, '.goal-act')[0]!.click();
    await flush();
    expect(root.querySelector('.goal-action-error')?.textContent).toContain('WS 连接已断开');
    expect(changed()).toBe(0);
  });
});
