// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/prompt-copy.test.ts ——
// PromptEditor 复制序列化单测（clipboardText：text/plain 出口口径）
//
// 背景：PM 默认 clipboardTextSerializer 用 "\\n\\n" 块分隔（富文本段距
// 语义），而输入框文档模型 = 纯文本段落（Shift+Enter = 一个换行）——
// 默认口径会把输入框的换行复制成空行，复制出去再粘回来换行翻倍。
// 验证走 EditorView.serializeForClipboard（PM 复制事件的真实管线，
// copy/cut/dragstart 的 text/plain 同一出口）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { clipboardText } from '../client/pasteText.ts';

/** 输入框 schema 的 Editor（PromptEditor 同扩展集，去掉 undo/高亮等无关面） */
function makeEditor(props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ed = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text],
    editorProps: props,
  });
  return { ed, host };
}

/** 全选 → PM 复制管线（serializeForClipboard 消费 clipboardTextSerializer
 *  prop）→ 剪贴板 text/plain 文本。*/
function copiedText(ed: Editor): string {
  const slice = ed.state.doc.slice(0, ed.state.doc.content.size);
  return ed.view.serializeForClipboard(slice).text;
}

describe('clipboardText（输入框复制 text/plain 口径）', () => {
  it('注册后：空行保持空行、相邻段恰一个换行（不翻倍）', () => {
    const { ed } = makeEditor({
      clipboardTextSerializer: (slice: { content: import('@tiptap/pm/model').Fragment }) => clipboardText(slice.content),
    });
    ed.commands.insertContentAt(1, '<p>第一行</p><p></p><p>第二行</p>');
    expect(ed.getText({ blockSeparator: '\n' })).toBe('第一行\n\n第二行');
    expect(copiedText(ed)).toBe('第一行\n\n第二行'); // 中间是真空行（一个空段）
    ed.destroy();
  });

  it('注册后：单换行（相邻两段）复制后仍是单换行', () => {
    const { ed } = makeEditor({
      clipboardTextSerializer: (slice: { content: import('@tiptap/pm/model').Fragment }) => clipboardText(slice.content),
    });
    ed.commands.insertContentAt(1, '<p>甲</p><p>乙</p>');
    expect(copiedText(ed)).toBe('甲\n乙');
    ed.destroy();
  });

  it('未注册时 PM 默认 \\n\\n 块分隔（翻倍对照，锁定修复动机）', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, '<p>甲</p><p>乙</p>');
    expect(copiedText(ed)).toBe('甲\n\n乙');
    ed.destroy();
  });

  it('clipboardText 纯函数：与编辑器 getText 口径一致（含空行/多段）', () => {
    const { ed } = makeEditor();
    ed.commands.insertContentAt(1, '<p>a</p><p></p><p></p><p>b</p>');
    expect(clipboardText(ed.state.doc.content)).toBe('a\n\n\nb');
    expect(clipboardText(ed.state.doc.content)).toBe(ed.getText({ blockSeparator: '\n' }));
    ed.destroy();
  });
});
