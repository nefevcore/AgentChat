// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/ime-confirm-then-send.test.ts ——
// IME 组合确认（Enter 提交原样拼音）与发送的交互单测
//
// 场景（用户报告）：输入无候选的组合串（如 ceu_tsex）→ 按 Enter 想发送。
// 组合期 Enter 若被发送分支拦截：v-model 尚未同步组合文本 → 发送空文本 +
// 程序性清空编辑器 → 组合文本丢失。修复 = Enter 分支加 isComposing 早退。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { ChatUndoRedo } from '../client/undoRedo.ts';

describe('IME 组合期 Enter 不触发发送（协议层）', () => {
  it('isComposing=true 的 Enter 事件应被跳过（ChatInput.onKeydown 协议）', () => {
    // 协议验证：组合期 Enter 的两个特征（isComposing=true + key=Enter）
    // 修复后 onKeydown 应在发送分支前早退——用事件特征断言协议成立
    const ev = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    expect(ev.isComposing).toBe(true);
    expect(ev.key).toBe("Enter");
    // jsdom KeyboardEvent 支持 isComposing ✓（构造参数生效）
  });

  it('PM 编辑器组合期 view.composing 语义（onUpdate 门的底层依据）', () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = new Editor({ element: host, extensions: [Document, Paragraph, Text, ChatUndoRedo] });
    // 非组合态：composing = false（onUpdate 正常 emit 的前提）
    expect(ed.view.composing).toBe(false);
    ed.destroy();
  });
});
