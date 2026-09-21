// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/prompt-undo.test.ts ——
// PromptEditor undo/redo 行为单测（真实 tiptap editor + jsdom）
//
// 覆盖：
//   · 键位：Mod-z 撤销输入；Mod-Shift-z / Mod-y 重做；
//   · 程序性整体重写（addToHistory:false）不进 undo 栈——Ctrl+Z 撤不回
//     发送清空/草稿恢复（对齐旧 textarea：程序性重置打断原生栈）；
//   · 断栈后新编辑重新进栈（每条消息独立可撤销）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { ChatUndoRedo } from '../client/undoRedo.ts';
import { undoDepth } from '@tiptap/pm/history';

function makeEditor() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ed = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, ChatUndoRedo],
  });
  return { ed, host };
}

/** 模拟键位（tiptap keyboard shortcuts 监听在编辑区 DOM） */
function key(ed: Editor, k: string, shift = false) {
  ed.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
    ...(shift ? { shiftKey: true } : {}),
    ...(k.toLowerCase() === 'z' || k.toLowerCase() === 'y' ? { ctrlKey: true } : {}),
  }));
}

describe('ChatUndoRedo（PromptEditor undo/redo）', () => {
  it('输入后 Mod-z 撤销 → 文本回退', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, '你好');
    expect(ed.getText()).toBe('你好');
    expect(undoDepth(ed.state)).toBeGreaterThan(0);
    key(ed, 'z');
    expect(ed.getText()).toBe('');
    ed.destroy();
  });

  it('撤销后 Mod-Shift-z 重做 → 文本恢复', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, 'abc');
    key(ed, 'z');
    expect(ed.getText()).toBe('');
    key(ed, 'z', true);
    expect(ed.getText()).toBe('abc');
    ed.destroy();
  });

  it('Mod-y 也触发重做', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, 'x');
    key(ed, 'z');
    key(ed, 'y');
    expect(ed.getText()).toBe('x');
    ed.destroy();
  });

  it('程序性整体重写（addToHistory:false）不进栈——Ctrl+Z 撤不回清空', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, '旧草稿');
    const depthBefore = undoDepth(ed.state);
    expect(depthBefore).toBeGreaterThan(0);
    // 程序性重写（PromptEditor watch 同款链式事务）
    ed.chain()
      .command(({ tr }) => {
        tr.setMeta("addToHistory", false);
        return true;
      })
      .setContent('<p>新内容</p>', { emitUpdate: false })
      .run();
    // 不进栈：深度不变；且撤销旧条目不会把 doc 拉回重写前状态（'新内容'保持）
    expect(undoDepth(ed.state)).toBe(depthBefore);
    key(ed, 'z');
    expect(ed.getText()).toBe('新内容'); // 程序性重写不可被 Ctrl+Z 撤回
    ed.destroy();
  });

  it('程序性重写后新编辑独立进栈', () => {
    const { ed } = makeEditor();
    ed.chain()
      .command(({ tr }) => {
        tr.setMeta("addToHistory", false);
        return true;
      })
      .setContent('<p></p>', { emitUpdate: false })
      .run();
    ed.commands.insertContentAt(1, '新输入');
    expect(undoDepth(ed.state)).toBeGreaterThan(0);
    key(ed, 'z');
    expect(ed.getText()).toBe('');
    ed.destroy();
  });
});
