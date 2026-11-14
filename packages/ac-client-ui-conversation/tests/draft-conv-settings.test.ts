// ============================================================
// draft-conv-settings.test.ts —— cr-1084 草稿期会话键不写哨兵
//
// 主诉实锤链：新会话（草稿位，哨兵 __pending__）在实验性菜单选
// 「工具审批=本会话自动放行」→ conv-settings/set 直接写哨兵键 →
// 首条消息 dispatchDraft 签发真实 sid 物化，键留在哨兵上永不被 run
// 读到（权限门 onAskOf 第一层 effective(sid) 落空 → 回落缺省 deny）。
//
// 修复形状（源断言——ChatInput 重组件无整挂先例，按 draft-single
// src.toContain 同款锁定接线；搬运语义的组件级行为在
// ac-client-ui-singles/tests/draft-single.test.ts）：
//   · 五个会话键写口全走 setConvSetting 统一边界（草稿位 → board 暂存）；
//   · 两个读侧 watch 草稿位分支：暂存值即真相，偏好回放也写暂存；
//   · 直写 conv-settings/set 的调用面只剩 setConvSetting 本体一处。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'ChatInput.vue'), 'utf-8');

describe('cr-1084 草稿期会话键分流（ChatInput 写口接线）', () => {
  it('conv-settings/set 直写面只剩 setConvSetting 本体（五写口全收口）', () => {
    const hits = src.match(/rpc\.call\('conv-settings\/set'/g) ?? [];
    expect(hits).toHaveLength(1); // setConvSetting 内的常规分支——唯一合法直写点
  });

  it('统一写口/读口/草稿判定三件在场', () => {
    expect(src).toContain('const onDraft = computed(');
    expect(src).toContain('function setConvSetting(');
    expect(src).toContain('function convSettingStored(');
    expect(src).toContain('if (onDraft.value) {'); // 写口草稿分流
  });

  it('五个写口全经 setConvSetting（model / toolMode×2 / browserTier×2 / extKey 泛写）', () => {
    const calls = src.match(/setConvSetting\(/g) ?? [];
    // 定义 1 处 + 写口 6 处（selectModel 1v1、toolMode 继承、selectToolMode、
    // browserTier 继承、selectBrowserTier、selectExtKey）+ 草稿读侧偏好回放 2 处
    expect(calls.length).toBeGreaterThanOrEqual(9);
  });

  it('读侧草稿分支：toolMode/experimental 两 watch 均有暂存回显路径', () => {
    expect(src.match(/convSettingStored\(/g)?.length).toBeGreaterThanOrEqual(4); // 定义 + 三消费（toolMode/browserTier/extKey 循环）
  });
});
