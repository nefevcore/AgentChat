<script setup lang="ts">
/**
 * PromptEditor —— ChatInput 编辑面（tiptap v3 单层渲染，2026-09-21 转正）。
 *
 * 动机：原路线 = 透明文字 textarea + 同度量 div 遮罩（.ta-highlight），
 * 两条排版管线（编辑控件 vs DOM 布局）存在引擎级残余错位（kerning/断行
 * 点/亚像素取整），只能逼近无法归零。本组件把文字与 token 药丸放进同一
 * 个 contenteditable DOM——错位在物理上不可能发生。
 *
 * 设计约束（与原 textarea 面对齐）：
 * - 文档模型 = 纯文本段落（Document/Paragraph/Text），send/draft 出口
 *   getText('\n') 与原 v-model 字符串逐字节一致——数据模型零改动；
 * - token 检测单源：mention.ts tokenizeMentionHighlights 原函数喂
 *   ProseMirror Decoration（token 均不跨行 → 按段落独立 tokenize 等价）；
 * - 键盘协议委托回 ChatInput.onKeydown（弹层导航/Enter 语义/忙态手势
 *   原样复用；preventDefault 后 PM 跳过默认插入）；
 * - 文件粘贴委托 onPasteFiles（返回 true 抑制默认插入）；文本粘贴走
 *   pasteText 归一（text/html 优先：块边界/<br> 保换行、<a> 还原 URL、
 *   <pre> 原样），按 \n 分段插入——不交给 PM 默认解析（空段/链接会失真）；
 *   内部回贴（data-pm-slice 开口标记）走段融合语义（replaceSelection
 *   原生融合开放段——段内局部剪切回贴不再裂段）；
 * - IME：PM 原生组合处理；组合期 onActivity 静默（等价原 isComposing 门）。
 * - 复制出口：clipboardTextSerializer 定制 text/plain = getText('\n')
 *   口径（PM 默认块分隔 "\n\n" 会把换行复制成空行）。
 *
 */
import { computed, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { Editor, Extension } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Plugin } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { splitBlock } from '@tiptap/pm/commands';
import { Slice, Fragment } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { tokenizeMentionHighlights } from './mention.ts';
import { clipboardText, normalizePasteText, pmSliceDepth } from './pasteText.ts';
import { ChatUndoRedo, clearChatHistory } from './undoRedo.ts';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  /** 键盘协议委托（ChatInput.onKeydown：弹层导航/Enter 语义）；preventDefault 后本层抑制 PM 默认 */
  onKeydown?: (e: KeyboardEvent) => void;
  /** 文件粘贴（返回 true = 已消费，抑制默认插入）；纯文本粘贴不拦截 */
  onPasteFiles?: (e: ClipboardEvent) => boolean;
  /** 文本/选区活动（≈ textarea 路径的 @input/@keyup/@click/@select 聚合；组合期自动静默） */
  onActivity?: () => void;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

/** token 药丸 decoration：段落文本独立 tokenize（token 不跨行，与整篇等价），
 *  段内偏移 +1 直映 doc 位置（offset+1 = 段内容起点）。 */
function buildTokenDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    const base = offset + 1;
    for (const t of tokenizeMentionHighlights(node.textContent)) {
      decos.push(Decoration.inline(base + t.start, base + t.end, { class: 'pe-tok pe-tok-' + t.kind }));
    }
  });
  return DecorationSet.create(doc, decos);
}

const HighlightPlugin = Extension.create({
  name: 'chatTokenHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        decorations(state) {
          return buildTokenDecorations(state.doc);
        },
      },
    })];
  },
});

const editor = useEditor({
  content: textToHtml(props.modelValue),
  extensions: [Document, Paragraph, Text, ChatUndoRedo, HighlightPlugin],
  editable: !props.disabled,
  editorProps: {
    attributes: { class: 'pe-editor', 'aria-label': '消息输入框' },
    // 复制/剪切/拖拽的 text/plain 出口：单换行口径（PM 默认 "\n\n"
    // 富文本段距会把输入框的换行复制成空行——复制出去再粘回换行翻倍）
    clipboardTextSerializer: (slice) => clipboardText(slice.content),
    handleKeyDown(_view: EditorView, event: KeyboardEvent): boolean {
      if (props.disabled) return false;
      props.onKeydown?.(event);
      if (event.defaultPrevented) return true;
      // IME 组合期的 Enter/Shift+Enter = 确认候选/原样提交——不拦截（PM 组合处理消费）
      if (event.isComposing) return false;
      // Shift+Enter = 换行（= 文本面 \n：段落分裂，getText(blockSeparator) 还原）
      if (event.key === 'Enter' && event.shiftKey) {
        splitBlock(_view.state, _view.dispatch);
        return true;
      }
      return false;
    },
    handlePaste(_view: EditorView, event: ClipboardEvent): boolean {
      if (props.disabled) return false;
      if (props.onPasteFiles?.(event)) return true; // 文件粘贴已消费
      // 文本粘贴：text/html 优先（富文本来源），归一后按段插入——
      // PM 默认解析会吞空段换行、丢 <a> 的 href，故不委托默认
      const data = event.clipboardData;
      const html = data?.getData('text/html');
      // 内部回贴判定：html 带 PM 开口标记（data-pm-slice）。text/plain 是
      // 本编辑器序列化出口（clipboardTextSerializer 单换行、空格原样）——
      // 直取零失真；html 只作来源与开口深度判定
      const depth = html ? pmSliceDepth(html) : null;
      if (depth) {
        const inner = data?.getData('text/plain') ?? '';
        if (inner) {
          insertPastedSlice(inner, depth); // 段融合（开放端与宿主段无缝拼接）
          event.preventDefault();
          return true;
        }
      }
      // 外部源：text/html 优先（富文本），归一后整段块插入
      const text = html && html.includes('<')
        ? normalizePasteText(html)
        : (data?.getData('text/plain') ?? '');
      if (!text) return false;
      insertTextAsParagraphs(text);
      event.preventDefault();
      return true;
    },
  },
  onUpdate({ editor: ed }) {
    if (ed.view.composing) return; // IME 组合期不 emit（等价原 v-model 组合门）
    emit('update:modelValue', ed.getText({ blockSeparator: '\n' }));
    if (!programmatic) props.onActivity?.();
  },
  onSelectionUpdate({ editor: ed }) {
    if (ed.view.composing || programmatic) return;
    props.onActivity?.();
  },
});

/** 程序性写入门：外部改值/光标操作期间的 dispatch 会回声 onSelectionUpdate
 *  （selection 重映射），mention 检测不应由程序性变更触发——置旗抑制，
 *  微任务尾清旗（dispatch 回声同步发，保险延后一拍）。 */
let programmatic = false;
function withoutActivityEcho(fn: () => void): void {
  programmatic = true;
  try {
    fn();
  } finally {
    void Promise.resolve().then(() => { programmatic = false; });
  }
}

/** 外部程序性改值（发送清空/草稿恢复/mention 替换）→ 回写编辑器。
 *  等值守门：用户输入 echo 回流的 modelValue 不再 setContent。 */
watch(() => props.modelValue, (v) => {
  const ed = editor.value;
  if (!ed || ed.isDestroyed) return;
  if (ed.getText({ blockSeparator: '\n' }) === v) return;
  withoutActivityEcho(() => {
    // 程序性整体重写不进 undo 栈（addToHistory:false 与官方 focus/blur 事务同款）；
    // 随后清空栈——上一条消息的残留条目在新 doc 上映射不过去，若不清，发送后
    // 首 Ctrl+Z 会撤出空事件（体感像失灵）
    ed.chain().command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      return true;
    }).setContent(textToHtml(v), { emitUpdate: false }).run();
    clearChatHistory(ed);
  });
});

watch(() => props.disabled, (d) => editor.value?.setEditable(!d));

const isEmpty = computed(() => editor.value?.isEmpty ?? true);

/** 粘贴文本按段插入：\n 分段 → 每段一个 Paragraph（空行 = 空段，
 *  与 textToHtml 同构——空段 <p><br></p> 由 PM 空段自表达，
 *  getText('\n') 还原时换行数守恒）。 */
function insertTextAsParagraphs(text: string): void {
  const ed = editor.value;
  if (!ed) return;
  const parts = text.split('\n').map(line =>
    line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] },
  );
  ed.chain().focus().insertContentAt(ed.state.selection.from, parts).run();
}

/** 内部回贴（data-pm-slice 开口标记）：replaceSelection 走 PM 原生段融
 *  合——首/末开放段与落点宿主段无缝拼接（段内局部“剪切→回贴”零裂段），
 *  中间段完整落段。开口深度 clamp 到 0/1（schema 最深 = doc 下段落）。 */
function insertPastedSlice(text: string, depth: { openStart: number; openEnd: number }): void {
  const ed = editor.value;
  if (!ed) return;
  const paras = text.split('\n').map(line =>
    line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] },
  );
  const nodes = paras.map(p => ed.state.schema.nodeFromJSON(p));
  // 依开口深度打开首/末段边界：open=1 时首末段与宿主段融合（replaceSelection
  // 原生语义——段内局部剪切回贴零裂段），open=0 时闭合（该端按整段落段）
  const open = (d: number) => Math.min(d, 1);
  ed.view.dispatch(ed.state.tr.replaceSelection(
    new Slice(Fragment.fromArray(nodes), open(depth.openStart), open(depth.openEnd)),
  ));
}

/** 纯文本 → PM HTML（段落化；<>& 转义防解析） */
function textToHtml(text: string): string {
  if (text === '') return '<p></p>';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.split('\n').map(l => (l === '' ? '<p><br></p>' : '<p>' + esc(l) + '</p>')).join('');
}

// ---- 控制面（ChatInput 的 mention 检测/替换经此操作——与 textarea 元素同语义） ----

/** 段落地图：段文本 + 段内容起点 doc 位（文本索引 ↔ doc 位置的换算底座） */
function paraMap(): Array<{ text: string; pos: number }> {
  const out: Array<{ text: string; pos: number }> = [];
  editor.value?.state.doc.forEach((node, offset) => {
    out.push({ text: node.textContent, pos: offset + 1 });
  });
  return out;
}

/** 文本索引（getText 口径，\n 分隔）→ doc 位置；token 不跨行，边界归属前段 */
function mapPos(map: Array<{ text: string; pos: number }>, idx: number): number | null {
  let acc = 0;
  for (const p of map) {
    if (idx <= acc + p.text.length) return p.pos + (idx - acc);
    acc += p.text.length + 1;
  }
  return null;
}

/** 当前光标（文本索引口径——detectMention 直用） */
function caret(): number {
  const ed = editor.value;
  if (!ed) return 0;
  return ed.state.doc.textBetween(0, ed.state.selection.from, '\n', '').length;
}

/** 替换文本区间 [start,end) 为 insert（mention token 替换/摘除；字面插入不经 HTML 解析） */
function replaceRange(start: number, end: number, insert: string): void {
  const ed = editor.value;
  if (!ed) return;
  const m = paraMap();
  const from = mapPos(m, start);
  const to = mapPos(m, end);
  if (from === null || to === null || to < from) return;
  ed.view.dispatch(ed.state.tr.insertText(insert, from, to));
}

/** 置光标（文本索引口径） */
function setCaret(pos: number): void {
  const ed = editor.value;
  if (!ed) return;
  const p = mapPos(paraMap(), pos) ?? ed.state.doc.content.size;
  withoutActivityEcho(() =>
    ed.chain().focus().setTextSelection(Math.min(p, ed.state.doc.content.size)).run());
}

function focus(): void {
  editor.value?.commands.focus();
}

defineExpose({ focus, caret, replaceRange, setCaret });
</script>

<template>
  <div class="pe-wrap">
    <EditorContent :editor="editor" />
    <div v-if="isEmpty && placeholder" class="pe-placeholder">{{ placeholder }}</div>
  </div>
</template>

<style scoped>
/* 单层渲染：文字与 token 药丸同 DOM——度量对齐由结构保证，非样式逼近。
 * 度量值与原 textarea 面一致（14px/1.5/63px 三整行/padding 0 2px）。 */
.pe-wrap {
  position: relative;
  min-height: 63px;
}

.pe-wrap :deep(.pe-editor) {
  outline: none;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  /* 高度与原 textarea 面同策略：固定恰好 3 整行（1.5 × 14px × 3），
     超出内容内滚；滚动条隐藏（经典滚动条占内容宽会改变换行点） */
  min-height: 63px;
  max-height: 63px;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding: 0 2px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  color: var(--color-text-primary);
  caret-color: var(--color-text-primary);
}

.pe-wrap :deep(.pe-editor)::-webkit-scrollbar {
  display: none;
}

.pe-wrap :deep(.pe-editor p) {
  margin: 0;
}

.pe-placeholder {
  position: absolute;
  top: 0;
  left: 2px;
  color: var(--color-text-muted);
  pointer-events: none;
  font-size: 14px;
  line-height: 1.5;
}

/* token 药丸（与原 .tok-* 同视觉：颜色 + 底色承担，零水平占位） */
.pe-wrap :deep(.pe-tok) {
  border-radius: var(--radius-sm);
  padding: 1px 0;
  font-weight: inherit;
}
.pe-wrap :deep(.pe-tok-skill)   { color: #7c5cff; background: color-mix(in srgb, #7c5cff 12%, transparent); }
.pe-wrap :deep(.pe-tok-file)    { color: #2f7ff6; background: color-mix(in srgb, #2f7ff6 12%, transparent); }
.pe-wrap :deep(.pe-tok-agent)   { color: #18a058; background: color-mix(in srgb, #18a058 12%, transparent); }
.pe-wrap :deep(.pe-tok-session) { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
html.dark .pe-wrap :deep(.pe-tok-skill)   { color: #a38bff; background: color-mix(in srgb, #a38bff 14%, transparent); }
html.dark .pe-wrap :deep(.pe-tok-file)    { color: #6aa6ff; background: color-mix(in srgb, #6aa6ff 14%, transparent); }
html.dark .pe-wrap :deep(.pe-tok-agent)   { color: #4cc98a; background: color-mix(in srgb, #4cc98a 14%, transparent); }
html.dark .pe-wrap :deep(.pe-tok-session) { color: #f0a24a; background: color-mix(in srgb, #f0a24a 14%, transparent); }
</style>