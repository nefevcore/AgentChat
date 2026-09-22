// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/prompt-paste-slice.test.ts ——
// 内部回贴段融合（data-pm-slice 开口感知）端到端：
//   段内/跨段局部“剪切→原地回贴”往返不变：getText 复原原文。
// 链路 = PromptEditor.handlePaste 同构：html 带 data-pm-slice → pmSliceDepth
// → text/plain 直取（clipboardTextSerializer 口径）→ replaceSelection 段融合。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Slice, Fragment } from '@tiptap/pm/model';
import { pmSliceDepth } from '../client/pasteText.ts';

function makeEditor() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({ element: host, extensions: [Document, Paragraph, Text],
    editorProps: { clipboardTextSerializer: (s: { content: import("@tiptap/pm/model").Fragment }) =>
      s.content.textBetween(0, s.content.size, "\n") } });
}

/** PromptEditor.handlePaste 内部分支同构：text/plain 直取 + 段融合 */
function pasteInternal(ed: Editor, html: string, plain: string) {
  const depth = pmSliceDepth(html);
  if (!depth) return false;
  if (!plain) return false;
  const paras = plain.split("\n").map(line =>
    line === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: line }] },
  );
  const nodes = paras.map((p: Record<string, unknown>) => ed.state.schema.nodeFromJSON(p));
  const open = (d: number) => Math.min(d, 1);
  ed.view.dispatch(ed.state.tr.replaceSelection(
    new Slice(Fragment.fromArray(nodes), open(depth.openStart), open(depth.openEnd)),
  ));
  return true;
}

/** 剪切 → 原地回贴 → 返回最终 getText（from = 剪切后插入点） */
function cutAndPasteBack(ed: Editor, from: number, to: number): string {
  ed.commands.setTextSelection({ from, to });
  const out = ed.view.serializeForClipboard(ed.state.selection.content());
  ed.commands.deleteSelection();
  ed.commands.setTextSelection(from);
  expect(pasteInternal(ed, out.dom.innerHTML, out.text)).toBe(true);
  return ed.getText({ blockSeparator: '\n' });
}

describe('内部回贴段融合（部分选区剪切→原地粘贴）', () => {
  it('段内中部（含边缘空格）剪切回贴：完全复原（空格不丢）', () => {
    const ed = makeEditor();
    const src = '第一行 文 字 内容';
    ed.commands.setContent('<p>' + src + '</p>');
    const got = cutAndPasteBack(ed, 5, 10); // 选中“文 字 ”（含尾随空格）
    expect(got).toBe(src);
    ed.destroy();
  });

  it('跨段选区（段1中→段2中）剪切回贴：往返不变', () => {
    const ed = makeEditor();
    ed.commands.setContent('<p>一二行</p><p>第二行</p><p>第三行</p>');
    const before = ed.getText({ blockSeparator: '\n' });
    const got = cutAndPasteBack(ed, 4, 10);
    expect(got).toBe(before);
    ed.destroy();
  });

  it('含空段选区剪切回贴：往返不变', () => {
    const ed = makeEditor();
    ed.commands.setContent('<p>aaa</p><p></p><p>bbb</p>');
    const before = ed.getText({ blockSeparator: '\n' });
    const got = cutAndPasteBack(ed, 2, 11);
    expect(got).toBe(before);
    ed.destroy();
  });

  it('到文档尾的部分选区（末段开放回贴）往返不变', () => {
    const ed = makeEditor();
    ed.commands.setContent('<p>一二行</p><p>第二行</p><p>第三行</p>');
    const before = ed.getText({ blockSeparator: '\n' });
    const got = cutAndPasteBack(ed, 3, 15);
    expect(got).toBe(before);
    ed.destroy();
  });

  it('纯单段内复制（open 1/1 无中间段）回贴不裂段', () => {
    const ed = makeEditor();
    ed.commands.setContent('<p>abcdef</p>');
    const got = cutAndPasteBack(ed, 2, 5); // “bcd”
    expect(got).toBe('abcdef');
    ed.destroy();
  });

  it('外部源（无 data-pm-slice）→ pmSliceDepth null（走外部整段插入分支）', () => {
    expect(pmSliceDepth('<p>world</p>')).toBeNull();
    expect(pmSliceDepth('')).toBeNull();
  });

  it('pmSliceDepth：各 open 形态 / 非法值 null', () => {
    expect(pmSliceDepth('<p data-pm-slice="1 1 []">a</p>')).toEqual({ openStart: 1, openEnd: 1 });
    expect(pmSliceDepth('<p data-pm-slice="0 1 []">a</p>')).toEqual({ openStart: 0, openEnd: 1 });
    expect(pmSliceDepth('<p data-pm-slice="1 0 []">a</p>')).toEqual({ openStart: 1, openEnd: 0 });
    expect(pmSliceDepth('<p data-pm-slice="x y">a</p>')).toBeNull();
  });
});
