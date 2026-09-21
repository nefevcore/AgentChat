// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/undo-clear-history.test.ts ——
// clearChatHistory（程序性清栈）单测
//
// 场景：发送清空/草稿恢复后，旧编辑条目在新 doc 上映射不过去——
// 不清栈则发送后首 Ctrl+Z 撤出空事件（体感像 undo 失灵）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { ChatUndoRedo, clearChatHistory } from '../client/undoRedo.ts';
import { undoDepth, redoDepth, undo } from '@tiptap/pm/history';

describe('clearChatHistory', () => {
  it('发送清空后栈归零（旧条目不残留）', () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = new Editor({ element: host, extensions: [Document, Paragraph, Text, ChatUndoRedo] });
    // 用户编辑（进栈）
    ed.commands.insertContentAt(1, "hello");
    expect(undoDepth(ed.state)).toBeGreaterThan(0);
    // 发送清空（addToHistory:false + 清栈）
    ed.chain().command(({ tr }) => { tr.setMeta("addToHistory", false); return true; }).setContent("", { emitUpdate: false }).run();
    clearChatHistory(ed);
    expect(undoDepth(ed.state)).toBe(0);
    expect(redoDepth(ed.state)).toBe(0);
    ed.destroy();
  });

  it('清栈后新编辑正常进栈可撤销（栈功能不受损）', () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = new Editor({ element: host, extensions: [Document, Paragraph, Text, ChatUndoRedo] });
    ed.commands.insertContentAt(1, "a");
    clearChatHistory(ed);
    ed.commands.insertContentAt(2, "b");
    expect(undoDepth(ed.state)).toBeGreaterThan(0);
    ed.commands.command(({ state, dispatch }) => undo(state, dispatch));
    expect(ed.getText()).toBe("a");
    ed.destroy();
  });

  it('空栈时 clearChatHistory 无痕直通（不产生多余事务）', () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ed = new Editor({ element: host, extensions: [Document, Paragraph, Text, ChatUndoRedo] });
    const before = ed.state.doc;
    clearChatHistory(ed); // 初始空栈
    expect(ed.state.doc).toBe(before); // doc 引用不变 = 零事务副作用
    ed.destroy();
  });
});
