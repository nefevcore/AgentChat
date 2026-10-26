// ============================================================
// packages/ac-client-ui-onboarding/tests/onboarding-dom.test.ts ——
// 组件编排面回归锁（cr-479/480 深审补测试）。
//
// · DEFAULT_TAGS 与 __standard__ 预设的镜像 parity（后端改词 → CI 即红，
//   防双处走散——LLM_SAMPLING_KEYS cr-329 同款形态）。
// · ProfileStep 头像 file input 必须嵌在 <label> 内（cr-480：无 for 关联，
//   在 label 外则点击头像永不唤起文件选择器）。
// · requestSkip 的 -1 哨兵契约（cr-479：探测失败静默降级不弹确认——
//   经 shouldConfirmSkip 纯函数断言，组件行为由模板消费该函数保证）。
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { DEFAULT_TAGS, shouldConfirmSkip } from '../client/onboardingState.ts';
import ProfileStep from '../client/steps/ProfileStep.vue';

const mounted: Array<() => void> = [];
afterEach(() => { for (const off of mounted.splice(0)) off(); });

async function tick(n = 4) { for (let i = 0; i < n; i++) await nextTick(); }

// ◐c 退役批（cr-696）：STANDARD_TAGS parity 锁随 ac-agent-presets-builtin 退役删除（预设面归 preview 域）

describe('cr-479 · 跳过确认 -1 哨兵契约（探测失败静默降级）', () => {
  it('-1（探测失败）且未确认过 → 不拦（Math.max 钳制回归锁）', () => {
    expect(shouldConfirmSkip(-1, false)).toBe(false);
  });
});

describe('cr-480 · ProfileStep 头像 file input 嵌 label 内（DOM 结构锁）', () => {
  it('点击头像（label）能唤起文件选择器：input[type=file] 是 label 的后代', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp({
      render: () => h(ProfileStep as never, {
        // defaultRpc 无 runtime → agents/get-config 拒绝桩 → loadError 面（不影响 DOM 结构断言）
      }),
    });
    app.mount(root);
    mounted.push(() => { app.unmount(); root.remove(); });
    await tick();
    const label = root.querySelector('label.pf-avatar-uploader');
    const input = root.querySelector('input[type=file]');
    expect(label).toBeTruthy();
    expect(input).toBeTruthy();
    expect(label!.contains(input!)).toBe(true); // label 无 for → input 必须是其后代
  });
});
