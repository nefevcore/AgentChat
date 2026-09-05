// ============================================================
// attachment-lines.test.ts —— [附件] 行剥离（刷新后气泡与实况同形）
//
// 背景 bug：发送带附件的消息时 composeContent 把 `[附件] <路径>` 行
// 合成进正文（LLM 通路——非视觉模型靠它拿路径 read 附件），刷新后
// 历史回放的正文原样带回该行——气泡里既渲染附件 chips 又露出
// `[附件] files/admin/_tmp/xxx.jpg` 路径文本，重复且突兀。
//
// 修复后不变量（展示转换层剥离，落盘正文与 LLM 行为零变化）：
//   · splitAttachmentLines：尾部连续 [附件] 行 → 剥离 + 恢复 chips；
//     与 attachments 旁挂 chips 按 ref 去重合并，顺序 = 行序；
//   · 安全门：非 files/ 路径、无 chips 覆盖、非降级形的同形文本行
//     视为用户正文原样保留（防误吞手打文本）；
//   · pair/group 历史转换与 buildTurns（chips-only 消息不再被当
//     空白占位跳过）同口径。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  splitAttachmentLines,
  pairMessageToChatMessage,
  groupMessageToChatMessage,
  buildTurns,
} from '../src/utils/feed.ts';
import type { FileAttachment } from '../src/types';

/** attachments 旁挂引用转出的 chips（attachmentFilesOf 同款形状） */
function refChip(ref: string, filename?: string): FileAttachment {
  return { hash: '', filename: filename ?? ref, filesize: 0, text: ref };
}

describe('splitAttachmentLines 基本剥离', () => {
  it('图片消息（用户报告的形态）：行剥离 + 与 attachments chips 去重，正文只留用户输入', () => {
    const split = splitAttachmentLines(
      '看这张图\n[附件] files/admin/_tmp/2caa65e063f3.jpg',
      [refChip('files/admin/_tmp/2caa65e063f3.jpg', '照片.jpg')],
    );
    expect(split.content).toBe('看这张图');
    expect(split.files).toEqual([refChip('files/admin/_tmp/2caa65e063f3.jpg', '照片.jpg')]);
  });

  it('非图片文件（无 attachments 旁挂）：行恢复为可预览 chip（filename=basename）', () => {
    const split = splitAttachmentLines('文档在这\n[附件] files/user/_tmp/季度报告.pdf');
    expect(split.content).toBe('文档在这');
    expect(split.files).toEqual([{ hash: '', filename: '季度报告.pdf', filesize: 0, text: 'files/user/_tmp/季度报告.pdf' }]);
  });

  it('纯附件无正文：content 剥为空串，chips 兜底（chips-only 气泡）', () => {
    const split = splitAttachmentLines('[附件] files/user/_tmp/a.png');
    expect(split.content).toBe('');
    expect(split.files?.map((f) => f.filename)).toEqual(['a.png']);
  });

  it('混合多附件：行序 = 发送时 files 序（图片去重用旁挂 chip，文件行恢复）', () => {
    const split = splitAttachmentLines(
      '两个都看看\n[附件] files/u/_tmp/img.png\n[附件] files/u/_tmp/doc.pdf',
      [refChip('files/u/_tmp/img.png', '截图.png')],
    );
    expect(split.content).toBe('两个都看看');
    expect(split.files).toEqual([
      refChip('files/u/_tmp/img.png', '截图.png'),
      { hash: '', filename: 'doc.pdf', filesize: 0, text: 'files/u/_tmp/doc.pdf' },
    ]);
  });

  it('路径未登记降级形：保留全文作 chip（无路径不可预览），说明文字不丢', () => {
    const split = splitAttachmentLines('发你了\n[附件] 报告.pdf（已上传，路径未记录）');
    expect(split.content).toBe('发你了');
    expect(split.files).toEqual([{ hash: '', filename: '报告.pdf（已上传，路径未记录）', filesize: 0 }]);
  });
});

describe('splitAttachmentLines 安全门（防误吞用户正文）', () => {
  it('手打同形但非上传路径的行不剥离', () => {
    const content = '路径是 docs/readme.md';
    expect(splitAttachmentLines(content)).toEqual({ content, files: undefined });
    expect(splitAttachmentLines('[附件] docs/readme.md').content).toBe('[附件] docs/readme.md');
  });

  it('尾部行链中途遇到不过门的行即停：其上同形行保留为正文', () => {
    // 从尾向头：files/_tmp/y.png 过门 → docs/x.md 不过门（非 files/）即停
    const split = splitAttachmentLines('正文\n[附件] docs/x.md\n[附件] files/_tmp/y.png');
    expect(split.content).toBe('正文\n[附件] docs/x.md');
    expect(split.files?.map((f) => f.filename)).toEqual(['y.png']);
  });

  it('无 [附件] 字样的正文零开销透传（files 原样带回）', () => {
    const files = [refChip('files/u/_tmp/a.png', 'a.png')];
    expect(splitAttachmentLines('普通消息', files)).toEqual({ content: '普通消息', files });
  });

  it('attachments 在场但正文无对应行（旧记录）：原 chips 保留', () => {
    const files = [refChip('files/u/_tmp/old.png', '旧图.png')];
    const split = splitAttachmentLines('旧消息正文', files);
    expect(split.content).toBe('旧消息正文');
    expect(split.files).toBe(files);
  });
});

describe('历史转换器同口径（[附件] 行不进气泡正文）', () => {
  it('pairMessageToChatMessage：user 行正文剥离 + chips 合并', () => {
    const m = pairMessageToChatMessage({
      role: 'agent', // 中性 role:'agent' + agent_id=user（M21/D13 入站行词汇）
      content: '看图\n[附件] files/admin/_tmp/x.jpg',
      agent_id: 'user',
      message_id: 'm1',
      timestamp: '2026-09-05T00:00:00Z',
      attachments: [{ kind: 'image', ref: 'files/admin/_tmp/x.jpg', filename: 'x.jpg' }],
    }, 'admin');
    expect(m.content).toBe('看图');
    expect(m.files).toEqual([{ hash: '', filename: 'x.jpg', filesize: 0, text: 'files/admin/_tmp/x.jpg' }]);
  });

  it('groupMessageToChatMessage：群历史行同款剥离（无 attachments 时行恢复 chip）', () => {
    const m = groupMessageToChatMessage({
      role: 'agent',
      content: '文件在附件\n[附件] files/_tmp/报表.xlsx',
      agent_id: 'user',
      timestamp: '2026-09-05T00:00:00Z',
    });
    expect(m.content).toBe('文件在附件');
    expect(m.files).toEqual([{ hash: '', filename: '报表.xlsx', filesize: 0, text: 'files/_tmp/报表.xlsx' }]);
  });
});

describe('buildTurns：chips-only 用户消息不再被当空白跳过', () => {
  it('content 空 + files 在场 → 用户气泡保留（final 携带 files）', () => {
    const turns = buildTurns([
      { id: 'u1', role: 'agent', content: '', timestamp: 1, agent_id: 'user', files: [refChip('files/u/_tmp/a.png', 'a.png')] },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].agent_id).toBe('user');
    expect(turns[0].final?.files?.map((f) => f.filename)).toEqual(['a.png']);
  });

  it('真正全空的消息仍跳过（空气泡不回归）', () => {
    const turns = buildTurns([
      { id: 'u1', role: 'agent', content: '', timestamp: 1, agent_id: 'user' },
    ]);
    expect(turns).toHaveLength(0);
  });
});
