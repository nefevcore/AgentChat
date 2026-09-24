// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/prompt-paste-external.test.ts ——
// 外部源粘贴（无 data-pm-slice）段融合端到端：归一 + trim + 开放切片插入。
// 链路 = PromptEditor.handlePaste 外部源分支同构：normalizePasteText/纯文本
// → trimPastedText → insertTextAsParagraphs（开放切片，宿主段融合）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Slice, Fragment } from '@tiptap/pm/model';
import { normalizePasteText, trimPastedText } from '../client/pasteText.ts';

function makeEditor(html: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({ element: host, extensions: [Document, Paragraph, Text], content: html });
}

/** PromptEditor.insertTextAsParagraphs 同构（开放切片，open 1/1） */
function insertTextAsParagraphs(ed: Editor, text: string) {
  const paras = text.split("\n").map(line =>
    line === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: line }] });
  const nodes = paras.map((p: Record<string, unknown>) => ed.state.schema.nodeFromJSON(p));
  ed.view.dispatch(ed.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)));
}

/** handlePaste 外部源分支同构 */
function pasteExternal(ed: Editor, html: string, plain: string) {
  const raw = html && html.includes("<") ? normalizePasteText(html) : plain;
  if (!raw) return;
  const text = trimPastedText(raw);
  if (text) insertTextAsParagraphs(ed, text);
}

describe('外部源粘贴段融合（textarea 语义）', () => {
  const cases: Array<[string, string, number | [number, number], string, string, string]> = [
    // [名, 初始html, 光标/选区, 粘贴html, 粘贴plain, 期望]
    ["空框粘贴单行(富文本)", "<p></p>", 1, "<html><body><!--StartFragment-->hello<!--EndFragment--></body></html>", "hello", "hello"],
    ["空框粘贴多行(富文本)", "<p></p>", 1, "<p>a</p><p>b</p>", "a\nb", "a\nb"],
    ["段中粘贴单行", "<p>abcdef</p>", 4, "hello", "hello", "abchellodef"],
    ["段尾粘贴单行", "<p>abc</p>", 4, "hello", "hello", "abchello"],
    ["段首粘贴单行", "<p>abc</p>", 1, "hello", "hello", "helloabc"],
    ["段中粘贴多行", "<p>abcdef</p>", 4, "<p>x</p><p>y</p>", "x\ny", "abcx\nydef"],
    ["段中粘贴含空行", "<p>abcdef</p>", 4, "<p>x</p><p><br></p><p>y</p>", "x\n\ny", "abcx\n\nydef"],
    ["首尾带空白行(富文本)", "<p></p>", 1, "<div><br></div>\n<p>hello</p>\n<div><br></div>", "", "hello"],
    ["选区替换粘贴", "<p>abcdef</p>", [2, 5], "hello", "hello", "ahelloef"],
  ];
  for (const [name, html, sel, pasteHtml, pastePlain, want] of cases) {
    it(name, () => {
      const ed = makeEditor(html);
      if (Array.isArray(sel)) ed.commands.setTextSelection({ from: sel[0], to: sel[1] });
      else ed.commands.setTextSelection(sel);
      pasteExternal(ed, pasteHtml, pastePlain);
      expect(ed.getText({ blockSeparator: "\n" })).toBe(want);
      ed.destroy();
    });
  }

  it('纯空白粘贴：不插入任何内容', () => {
    const ed = makeEditor("<p>abc</p>");
    ed.commands.setTextSelection(4);
    pasteExternal(ed, "", "  \n  ");
    expect(ed.getText({ blockSeparator: "\n" })).toBe("abc");
    ed.destroy();
  });
});