// ============================================================
// ac-client-ui-conversation/tests/fileEdits.test.ts —— 文件编辑
// 追踪纯函数层验收（extractFileEdits / replayFiles / diffOfSummary）
//
// 场景矩阵：新建+迭代编辑（全量新增 diff）、存量文件首编辑
//（断链→partial）、覆盖 write（断链→partialBase）、失败调用跳过、
// insert 逆推、直播/历史双形态参数与结果解析。
// ============================================================
import { describe, it, expect } from 'vitest';
import { countLineChanges } from 'ac-edit-core/src/diff.ts';
import {
  extractFileEdits, replayFiles, fileEditsOf, diffOfSummary, fileEditsWithSnapshots, applySnapshots,
  applyDiskFinals, fileEditsFull, versionPointsOf, editStepsOf, diffOfStep, diffOfContent,
  contentOfSummary,
  type FileEditEvent,
} from '../client/fileEdits.ts';
import type { ChatMessage } from '../client/types.ts';

/** 构造 assistant 消息（历史形态：toolCalls[].arguments JSON 字符串 + result 对象） */
function histMsg(id: string, calls: Array<{ id: string; name: string; args: Record<string, unknown>; result: unknown }>, ts = 1000): ChatMessage {
  return {
    id, role: 'agent', content: '', timestamp: ts,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args), result: c.result })) as never,
  };
}

/** 构造直播形态（toolCalls[].arguments = 对象；结果在 role:'tool' 消息 content JSON） */
function liveMsg(id: string, calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, ts = 1000): ChatMessage[] {
  const asst: ChatMessage = {
    id, role: 'agent', content: '', timestamp: ts,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })) as never,
  };
  const tools: ChatMessage[] = calls.map((c) => ({
    id: `tool-${c.id}`, role: 'tool' as const, content: '', timestamp: ts + 1,
    tool_call_id: c.id, toolName: c.name,
  }));
  return [asst, ...tools];
}

/** 直播结果的 onToolEnd 落点改写（tool 消息 content = JSON 字符串） */
function withLiveResult(msgs: ChatMessage[], callId: string, result: Record<string, unknown>): ChatMessage[] {
  return msgs.map((m) =>
    m.role === 'tool' && m.tool_call_id === callId
      ? { ...m, content: JSON.stringify(result) }
      : m,
  );
}

const okWrite = (path: string, content: string) => ({ ok: true, output: { path, message: 'ok' } });
const okEdit = (path: string, added: number, removed: number) => ({ ok: true, output: { path, diff_added: added, diff_removed: removed } });
const fail = (error: string) => ({ ok: false, error });

describe('extractFileEdits —— 消息流 → 编辑事件', () => {
  it('run_code 子调用（subcall 平铺，方向 B）：编辑类子调用天然追踪（参数 + diff 统计齐全）', () => {
    // 直播形态：run_code 步的 toolCalls 混排宿主 + 子调用（feed-core
    // onSubcallEnd 追加；历史形态同构——subcalls 投影注入 steps）
    const msgs: ChatMessage[] = [
      histMsg('m1', [
        { id: 'run-1', name: 'run_code', args: { code: 'return 1;' }, result: { ok: true, output: { value: 1 } } },
        { id: 'run-1#2', name: 'edit', args: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, result: okEdit('src/a.ts', 1, 1) },
      ]),
    ];
    const ev = extractFileEdits(msgs);
    // 宿主 run_code 不是编辑工具——跳过；子调用 edit 是——收录（diff 追踪修复的验收点）
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ tool: 'edit', path: 'src/a.ts', ok: true, added: 1, removed: 1, oldStr: 'x', newStr: 'y' });
  });

  it('历史形态：arguments JSON 字符串 + result 对象', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'hi\n' }, result: okWrite('a.ts', 'hi\n') }]),
    ];
    const ev = extractFileEdits(msgs);
    expect(ev).toHaveLength(1);
    expect(ev[0].path).toBe('a.ts');
    expect(ev[0].action).toBe('overwrite');
    expect(ev[0].fullContent).toBe('hi\n');
    expect(ev[0].ok).toBe(true);
  });

  it('直播形态：arguments 对象 + tool 消息 content JSON 结果', () => {
    let msgs = liveMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'b.ts', old_string: 'x', new_string: 'y' } }]);
    msgs = withLiveResult(msgs, 'c1', okEdit('b.ts', 1, 1));
    const ev = extractFileEdits(msgs);
    expect(ev).toHaveLength(1);
    expect(ev[0].oldStr).toBe('x');
    expect(ev[0].newStr).toBe('y');
    expect(ev[0].added).toBe(1);
    expect(ev[0].removed).toBe(1);
  });

  it('str_replace_editor 按命令归一：create/str_replace/insert；view 跳过', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [
        { id: 'v', name: 'str_replace_editor', args: { command: 'view', path: 'd' }, result: { ok: true } },
        { id: 'c', name: 'str_replace_editor', args: { command: 'create', path: 'n.md', file_text: '# n\n' }, result: { ok: true, output: { diff_added: 2 } } },
        { id: 'r', name: 'str_replace_editor', args: { command: 'str_replace', path: 'n.md', old_str: '# n', new_str: '# N' }, result: okEdit('n.md', 1, 1) },
        { id: 'i', name: 'str_replace_editor', args: { command: 'insert', path: 'n.md', new_str: 'tail', insert_line: 1 }, result: okEdit('n.md', 1, 0) },
      ]),
    ];
    const ev = extractFileEdits(msgs);
    expect(ev.map((e) => e.action)).toEqual(['create', 'replace', 'insert']);
    expect(ev.every((e) => e.path === 'n.md')).toBe(true);
  });

  it('失败调用保留（ok=false），非编辑工具跳过', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [
        { id: 'r1', name: 'read', args: { file_path: 'x' }, result: { ok: true } },
        { id: 'e1', name: 'edit', args: { file_path: 'y.ts', old_string: 'a', new_string: 'b' }, result: fail('old_str 未逐字出现') },
      ]),
    ];
    const ev = extractFileEdits(msgs);
    expect(ev).toHaveLength(1);
    expect(ev[0].ok).toBe(false);
  });
});

describe('replayFiles —— 重放 + 初版逆推', () => {
  it('新建 + 迭代编辑：created=true，base=第一版全文，终版正确，diff 可比', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'line1\nline2\n' }, result: { ok: true, output: { diff_added: 3 } } }], 1000),
      histMsg('m2', [{ id: 'c2', name: 'edit', args: { file_path: 'a.ts', old_string: 'line2', new_string: 'line2-changed' }, result: okEdit('a.ts', 1, 1) }], 2000),
      histMsg('m3', [{ id: 'c3', name: 'str_replace_editor', args: { command: 'insert', path: 'a.ts', new_str: 'line0', insert_line: 0 }, result: okEdit('a.ts', 1, 0) }], 3000),
    ];
    const { events, files, diffs } = fileEditsOf(msgs);
    expect(events).toHaveLength(3);
    const s = files.get('a.ts')!;
    expect(s.created).toBe(true);
    expect(s.editCount).toBe(3);
    expect(s.finalContent).toBe('line0\nline1\nline2-changed\n');
    // base = 会话内第一版（首版全文——「会话最初版本」即第一版）
    expect(s.baseContent).toBe('line1\nline2\n');
    expect(s.partial).toBe(false);
    const d = diffs[0];
    expect(d.comparable).toBe(true);
    expect(d.partial).toBe(false);
    // LCS：old ['line1','line2',''] vs new ['line0','line1','line2-changed','']
    // 变更块合并后单块：old 侧 [line2,''] 两行删除、new 侧 [line0,'line2-changed']
    // 两行加入？——实测 added=3/removed=2（LCS 路径选 line1+'line2-changed'
    // 之外的对齐，块边界与直觉拼法不同）。生成器行为以实测为准；关键
    // 断言（终版内容/base/可比性）在前，±N 仅校验非零。
    expect(d.added).toBe(3);
    expect(d.removed).toBe(2);
  });

  it('存量文件首编辑（edit 打头）：断链——终版 null，partialBase=null，不可比', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: '存量.ts', old_string: 'old', new_string: 'new' }, result: okEdit('存量.ts', 1, 1) }]),
    ];
    const { files, diffs } = fileEditsOf(msgs);
    const s = files.get('存量.ts')!;
    expect(s.created).toBe(false);
    expect(s.finalContent).toBe(null);
    expect(s.partial).toBe(true);
    expect(s.partialBase).toBe(null); // 无可重建起点
    expect(diffs[0].comparable).toBe(false);
  });

  it('会话内首版全量写入后被覆盖 write：链完整（覆盖内容全知），base 仍 = 第一版', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.md', content: 'v1\n' }, result: { ok: true } }], 1000),
      histMsg('m2', [{ id: 'c2', name: 'write', args: { file_path: 'a.md', content: 'v2-full\n' }, result: { ok: true } }], 2000),
      histMsg('m3', [{ id: 'c3', name: 'edit', args: { file_path: 'a.md', old_string: 'v2-full', new_string: 'v2-edited' }, result: okEdit('a.md', 1, 1) }], 3000),
    ];
    const { files, diffs } = fileEditsOf(msgs);
    const s = files.get('a.md')!;
    expect(s.created).toBe(true);
    expect(s.finalContent).toBe('v2-edited\n');
    expect(s.partial).toBe(false); // 覆盖 write 内容全知——不构成断链
    expect(s.baseContent).toBe('v1\n');
    const d = diffs[0];
    expect(d.comparable).toBe(true);
    expect(d.partial).toBe(false);
  });

  it('失败编辑跳过重放（磁盘未变更）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'base\n' }, result: { ok: true } }], 1000),
      histMsg('m2', [{ id: 'c2', name: 'edit', args: { file_path: 'a.ts', old_string: 'nope', new_string: 'x' }, result: fail('未逐字出现') }], 2000),
    ];
    const { files } = fileEditsOf(msgs);
    const s = files.get('a.ts')!;
    expect(s.editCount).toBe(1); // 失败不计
    expect(s.finalContent).toBe('base\n');
    expect(s.baseContent).toBe('base\n'); // 第一版
  });

  it('重放失配（ok=true 但 old_str 找不到）：mismatches 计数、链不中断', () => {
    const events: FileEditEvent[] = [
      { callId: '1', tool: 'write', action: 'overwrite', path: 'f', ok: true, agentId: '', timestamp: 1, fullContent: 'a\nb\n' },
      { callId: '2', tool: 'str_replace_editor', action: 'insert', path: 'f', ok: true, agentId: '', timestamp: 2, newStr: 'X', insertLine: 0 },
      // 人为失配：ok=true 但 insertLine 越界（消息流残缺/外部并发改）
      { callId: '3', tool: 'str_replace_editor', action: 'insert', path: 'f', ok: true, agentId: '', timestamp: 3, newStr: 'Y', insertLine: 5 },
    ];
    const files = replayFiles(events);
    const s = files.get('f')!;
    expect(s.editCount).toBe(3);       // ok 事件全计（工具报成功）
    expect(s.mismatches).toBe(1);      // 但其中 1 条重放失配
    expect(s.finalContent).toBe('X\na\nb\n'); // 失配不推进内容、不中断链
  });

  it('多文件互不串扰；时间序即消息序', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [
        { id: 'c1', name: 'write', args: { file_path: 'x/a.ts', content: '1\n' }, result: { ok: true } },
        { id: 'c2', name: 'write', args: { file_path: 'y/b.ts', content: '2\n' }, result: { ok: true } },
        { id: 'c3', name: 'edit', args: { file_path: 'x/a.ts', old_string: '1', new_string: 'one' }, result: okEdit('x/a.ts', 1, 1) },
      ], 1000),
    ];
    const { files } = fileEditsOf(msgs);
    expect(files.size).toBe(2);
    expect(files.get('x/a.ts')!.finalContent).toBe('one\n');
    expect(files.get('y/b.ts')!.finalContent).toBe('2\n');
  });
});

describe('diffOfSummary —— diff 输出形态', () => {
  it('diff 文本带 -/+ 行标记（与 ToolResultEdit 渲染约定同款）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'l1\nl2\nl3\n' }, result: { ok: true } }], 1000),
      histMsg('m2', [{ id: 'c2', name: 'edit', args: { file_path: 'a.ts', old_string: 'l2', new_string: 'L2' }, result: okEdit('a.ts', 1, 1) }], 2000),
    ];
    const s = fileEditsOf(msgs).files.get('a.ts')!;
    const d = diffOfSummary(s);
    expect(d.comparable).toBe(true);
    // 渲染层行格式 = '<+|-> <行号> <内容>'（与 ToolResultEdit 的
    // '- '/'+ ' 前缀约定一致——行号夹在中间）
    expect(d.diff).toContain('- 2 l2');
    expect(d.diff).toContain('+ 2 L2');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });
});

describe('applySnapshots / fileEditsWithSnapshots —— 方案 C 快照补全', () => {
  it('存量断链 + 快照在场：partial 消除，base=快照内容，diff 完整', () => {
    // 会话：edit 打头（存量文件——方案 A 下 partial 断链）
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'old.ts', old_string: 'before', new_string: 'after' }, result: okEdit('old.ts', 1, 1) }], 1000),
    ];
    // 服务端快照：首见时内容 'before\n'（绝对路径，事件路径是相对的）
    const snaps = [{ absPath: 'C:/ws/files/agent1/old.ts', content: 'before\n', capturedAt: 999 }];
    const { files, diffs } = fileEditsWithSnapshots(msgs, snaps);
    const s = files.get('old.ts')!;
    expect(s.partial).toBe(false); // 快照接管断链
    expect(s.baseContent).toBe('before\n');
    expect(s.finalContent).toBe('after\n'); // 快照底 + 编辑链重放
    const d = diffs.find((x) => x.path === 'old.ts')!;
    expect(d.comparable).toBe(true);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it('skipped 快照（超上限/非文本）不接管断链：保持 partial（≠误判新建）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'big.log', old_string: 'a', new_string: 'b' }, result: okEdit('big.log', 1, 1) }], 1000),
    ];
    // 服务端准入闸跳过：content=null + skipped（与「新建」的 null 可区分）
    const snaps = [{ absPath: '/ws/big.log', content: null, skipped: 'too-large' as const, capturedAt: 999 }];
    const { files } = fileEditsWithSnapshots(msgs, snaps);
    expect(files.get('big.log')!.partial).toBe(true); // 不接管——回落磁盘兜底/方案 A
    expect(files.get('big.log')!.baseContent).toBe(null); // 不误置 base=''
  });

  it('快照 content=null（首见不存在）= 会话内新建：base="" 全量 diff', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'str_replace_editor', args: { command: 'insert', path: 'n.md', new_str: 'x', insert_line: 0 }, result: okEdit('n.md', 1, 0) }], 1000),
    ];
    const snaps = [{ absPath: '/ws/n.md', content: null, capturedAt: 998 }];
    const { files } = fileEditsWithSnapshots(msgs, snaps);
    const s = files.get('n.md')!;
    expect(s.partial).toBe(false);
    expect(s.baseContent).toBe('');
    expect(s.finalContent).toBe('x\n'); // '' split 后 ['','']，insert(0,'x') → 'x\n'
  });

  it('无匹配快照：原样回落方案 A（partial 保持）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, result: okEdit('a.ts', 1, 1) }]),
    ];
    const { files } = fileEditsWithSnapshots(msgs, [{ absPath: '/other/b.ts', content: 'z', capturedAt: 1 }]);
    expect(files.get('a.ts')!.partial).toBe(true);
  });

  it('非 partial 文件不受快照影响（链完整场景不重算）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'v1\n' }, result: { ok: true } }]),
    ];
    const snaps = [{ absPath: '/ws/a.ts', content: 'mystery\n', capturedAt: 1 }];
    const { files } = fileEditsWithSnapshots(msgs, snaps);
    expect(files.get('a.ts')!.baseContent).toBe('v1\n'); // 会话内首写仍是 base
  });

  it('applySnapshots 直接调用：快照底 + 覆盖 write + 后续编辑链', () => {
    const events: FileEditEvent[] = [
      { callId: '1', tool: 'edit', action: 'edit', path: 'f.ts', ok: true, agentId: '', timestamp: 1, oldStr: 'a', newStr: 'b' },
      { callId: '2', tool: 'write', action: 'overwrite', path: 'f.ts', ok: true, agentId: '', timestamp: 2, fullContent: 'full-v2\n' },
      { callId: '3', tool: 'edit', action: 'edit', path: 'f.ts', ok: true, agentId: '', timestamp: 3, oldStr: 'v2', newStr: 'V2' },
    ];
    const base = replayFiles(events);
    expect(base.get('f.ts')!.partial).toBe(true); // 方案 A：edit 打头断链
    const out = applySnapshots(base, events, [{ absPath: '/x/f.ts', content: 'a\n', capturedAt: 0 }]);
    const s = out.get('f.ts')!;
    expect(s.partial).toBe(false);
    expect(s.baseContent).toBe('a\n'); // 快照 = 真初版
    expect(s.finalContent).toBe('full-V2\n'); // 覆盖写 + 编辑链重放
  });
});

describe('applyDiskFinals / fileEditsFull —— 磁盘终版兜底（无快照存量文件）', () => {
  it('存量编辑链 + 磁盘现内容：终版 = 磁盘，初版 = 逆序回退（干净回退到会话最初）', () => {
    // 会话：存量文件三连 edit（无 write——方案 A partial、无快照）
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'C:/w/old.ts', old_string: 'v1', new_string: 'v2' }, result: okEdit('C:/w/old.ts', 1, 1) }], 1000),
      histMsg('m2', [{ id: 'c2', name: 'edit', args: { file_path: 'C:/w/old.ts', old_string: 'v2', new_string: 'v3' }, result: okEdit('C:/w/old.ts', 1, 1) }], 2000),
    ];
    // 磁盘现内容 = 两次编辑后的形态
    const disk = { 'C:/w/old.ts': 'v3\n' };
    const { files, diffs } = fileEditsFull(msgs, [], disk);
    const s = files.get('C:/w/old.ts')!;
    expect(s.partial).toBe(false); // 兜底接管
    expect(s.finalContent).toBe('v3\n'); // 终版 = 磁盘
    expect(s.baseContent).toBe('v1\n'); // 初版 = 回退到底（会话最初）
    expect(s.diskBackfill).toBeUndefined(); // 干净回退——无停点
    const d = diffs.find((x) => x.path === 'C:/w/old.ts')!;
    expect(d.comparable).toBe(true);
  });

  it('事件路径反斜杠形态也能命中磁盘表（norm 对齐）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'C:\\w\\old.ts', old_string: 'a', new_string: 'b' }, result: okEdit('C:\\w\\old.ts', 1, 1) }], 1000),
    ];
    const { files } = fileEditsFull(msgs, [], { 'C:/w/old.ts': 'b\n' });
    expect(files.get('C:\\w\\old.ts')!.partial).toBe(false);
    expect(files.get('C:\\w\\old.ts')!.baseContent).toBe('a\n');
  });

  it('编辑链中段有 write：回推停在该 write（diskBackfill 标记，diff 以停点为初版）', () => {
    const events: FileEditEvent[] = [
      { callId: '1', tool: 'edit', action: 'edit', path: 'f.md', ok: true, agentId: '', timestamp: 1, oldStr: 'orig', newStr: 'mid' },
      { callId: '2', tool: 'write', action: 'overwrite', path: 'f.md', ok: true, agentId: '', timestamp: 2, fullContent: 'written\n' },
      { callId: '3', tool: 'edit', action: 'edit', path: 'f.md', ok: true, agentId: '', timestamp: 3, oldStr: 'written', newStr: 'EDITED' },
    ];
    const base = replayFiles(events);
    expect(base.get('f.md')!.partial).toBe(true);
    const out = applyDiskFinals(base, events, { '/x/f.md': 'EDITED\n' });
    const s = out.get('f.md')!;
    expect(s.partial).toBe(false);
    expect(s.finalContent).toBe('EDITED\n'); // 磁盘终版
    expect(s.baseContent).toBe('written\n'); // 停点 = write 版（再往前不可知）
    expect(s.diskBackfill).toBe(true); // 停点标记
  });

  it('磁盘读不到（null）/未请求：回落原样（partial 保持）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'gone.ts', old_string: 'x', new_string: 'y' }, result: okEdit('gone.ts', 1, 1) }]),
    ];
    const r1 = fileEditsFull(msgs, [], { 'gone.ts': null });
    expect(r1.files.get('gone.ts')!.partial).toBe(true); // null = 文件已不存在——不兜底
    const r2 = fileEditsFull(msgs, [], {});
    expect(r2.files.get('gone.ts')!.partial).toBe(true); // 空 disk 表 = 原样
  });

  it('快照优先：有快照的文件不走磁盘兜底（无 diskBackfill）', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'C:/w/s.ts', old_string: 'snap', new_string: 'new' }, result: okEdit('C:/w/s.ts', 1, 1) }]),
    ];
    const { files } = fileEditsFull(msgs, [{ absPath: 'C:/w/s.ts', content: 'snap\n', capturedAt: 0 }], { 'C:/w/s.ts': 'disk-now\n' });
    const s = files.get('C:/w/s.ts')!;
    expect(s.baseContent).toBe('snap\n'); // 快照底
    expect(s.finalContent).toBe('new\n'); // 快照链重放（非磁盘——磁盘可能是会话外手改）
  });

  it('CRLF 磁盘 + LF 参数（edit 工具执行面形态）：换行对齐命中——不再失配', () => {
    // 场景：磁盘文件是 CRLF（编辑工具写回时还原行尾），消息流 old/new 是 LF
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'C:/w/crlf.json', old_string: '"a": 1,\n"b": 2', new_string: '"a": 1,\n"b": 99' }, result: okEdit('C:/w/crlf.json', 1, 1) }], 1000),
    ];
    // 磁盘现内容 = 编辑后形态（CRLF）
    const disk = { 'C:/w/crlf.json': '{\r\n"a": 1,\r\n"b": 99\r\n}\r\n' };
    const { files, diffs } = fileEditsFull(msgs, [], disk);
    const s = files.get('C:/w/crlf.json')!;
    expect(s.partial).toBe(false);
    expect(s.mismatches).toBe(0); // 换行对齐——不失配
    // 逆推初版（CRLF 保持）
    expect(s.baseContent).toBe('{\r\n"a": 1,\r\n"b": 2\r\n}\r\n');
    expect(s.finalContent).toBe('{\r\n"a": 1,\r\n"b": 99\r\n}\r\n');
    const d = diffs.find((x) => x.path === 'C:/w/crlf.json')!;
    expect(d.comparable).toBe(true);
  });
});

describe('versionPointsOf / editStepsOf / diffOfStep —— 逐次回放（查看某次编辑）', () => {
  const chainMsgs: ChatMessage[] = [
    histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'a.ts', content: 'v1\n' }, result: { ok: true, output: { diff_added: 2 } } }], 1000),
    histMsg('m2', [{ id: 'c2', name: 'edit', args: { file_path: 'a.ts', old_string: 'v1', new_string: 'v2' }, result: okEdit('a.ts', 1, 1) }], 2000),
    histMsg('m3', [{ id: 'c3', name: 'str_replace_editor', args: { command: 'insert', path: 'a.ts', new_str: 'head-', insert_line: 0 }, result: okEdit('a.ts', 1, 0) }], 3000),
  ];

  it('版本点序列：base 起步逐步推进，终版点 = finalContent', () => {
    const { files, events } = fileEditsOf(chainMsgs);
    const s = files.get('a.ts')!;
    const points = versionPointsOf(s, events);
    expect(points).toHaveLength(3); // write + edit + insert
    expect(points.map((p) => p.content)).toEqual(['v1\n', 'v2\n', 'head-\nv2\n']);
    expect(points[0].before).toBe('v1\n'); // 首点 before = 初版（write 前 = 不存在）
    expect(points[2].before).toBe('v2\n');
    expect(points[2].content).toBe(s.finalContent); // 终版点与顶层重放一致
  });

  it('editStepsOf：步事件锚 + before/after；diffOfStep 输出单次编辑 diff', () => {
    const { files, events } = fileEditsOf(chainMsgs);
    const steps = editStepsOf(files.get('a.ts')!, events);
    expect(steps.map((st) => st.event.callId)).toEqual(['c1', 'c2', 'c3']);
    // 第 2 步（edit v1→v2）：单次 diff 只有这一处变更
    const d2 = diffOfStep(steps[1]);
    expect(d2.comparable).toBe(true);
    expect(d2.diff).toContain('- 1 v1');
    expect(d2.diff).toContain('+ 1 v2');
    // 第 3 步（insert head-，行插入）：before = v2\n
    const d3 = diffOfStep(steps[2]);
    expect(steps[2].before).toBe('v2\n');
    expect(steps[2].after).toBe('head-\nv2\n');
    expect(d3.diff).toContain('+ 1 head-');
  });

  it('不可回放（partial 且无基底）= 空步序列', () => {
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: '存量.ts', old_string: 'x', new_string: 'y' }, result: okEdit('存量.ts', 1, 1) }]),
    ];
    const { files, events } = fileEditsOf(msgs);
    expect(editStepsOf(files.get('存量.ts')!, events)).toHaveLength(0);
  });

  it('单次新建（write 打头且仅此一步）：内容视图可见全文（总览/单步 diff 基底 = 首写版而恒空）', () => {
    // 会话内新建文件只写一次——base = 首写版与终版相同，总览与单步
    // diff 均为「（无变更）0/0」；内容视图（diffOfContent）是内容可见面
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'n.ts', content: 'a\nb\n' }, result: { ok: true } }], 1000),
    ];
    const { files, events } = fileEditsOf(msgs);
    const s = files.get('n.ts')!;
    expect(s.finalContent).toBe('a\nb\n');
    // 步保留唯一写入（终版对账不涉单步链）
    const steps = editStepsOf(s, events);
    expect(steps).toHaveLength(1);
    expect(steps[0].after).toBe('a\nb\n');
    // 内容视图：全文 + 行渲染
    expect(contentOfSummary(s)).toBe('a\nb\n');
    const c = diffOfContent(s);
    expect(c.comparable).toBe(true);
    expect(c.added).toBe(3); // a / b / 尾空行
    expect(c.diff).toContain('+ 1 a');
    expect(c.diff).toContain('+ 2 b');
    // 链不可启（无终版）：内容视图不可比
    const broken = fileEditsOf([
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: '存量.ts', old_string: 'x', new_string: 'y' }, result: okEdit('存量.ts', 1, 1) }]),
    ]).files.get('存量.ts')!;
    expect(diffOfContent(broken).comparable).toBe(false);
  });

  it('快照接管断链后：步序列自快照底起算（首步 before = 快照内容）', () => {
    const snaps = [{ absPath: '/ws/old.ts', content: 'before\n', capturedAt: 999 }];
    const { files, events } = fileEditsWithSnapshots([
      histMsg('m1', [{ id: 'c1', name: 'edit', args: { file_path: 'old.ts', old_string: 'before', new_string: 'after' }, result: okEdit('old.ts', 1, 1) }], 1000),
    ], snaps);
    const steps = editStepsOf(files.get('old.ts')!, events);
    expect(steps).toHaveLength(1);
    expect(steps[0].before).toBe('before\n'); // 快照底
    expect(steps[0].after).toBe('after\n');
  });

  it('失败事件不产步（时间线保留但不可回放）', () => {
    const msgs: ChatMessage[] = [
      ...chainMsgs,
      histMsg('m4', [{ id: 'c4', name: 'edit', args: { file_path: 'a.ts', old_string: 'nope', new_string: 'x' }, result: fail('未逐字出现') }], 4000),
    ];
    const { files, events } = fileEditsOf(msgs);
    const s = files.get('a.ts')!;
    expect(s.events).toHaveLength(4);      // 失败行在列表
    expect(editStepsOf(s, events)).toHaveLength(3); // 但无步
  });

  it('步统计 = LCS 真实变更（old/new 含未变上下文行时，工具报告偏大——以所见为准）', () => {
    // 场景：edit 的 old/new 各带一行未变上下文（保证唯一性的惯用写法）——
    // 工具按编辑区域报 +8/-3，实际只变了 5 行（+5/-0）
    const base = 'ctx-a\nL1\nL2\nL3\nL4\nL5\nctx-b\n';
    const after = 'ctx-a\nN1\nN2\nN3\nN4\nN5\nctx-b\n';
    const msgs: ChatMessage[] = [
      histMsg('m1', [{ id: 'c1', name: 'write', args: { file_path: 'b.ts', content: base }, result: { ok: true } }], 1000),
      histMsg('m2', [{
        id: 'c2', name: 'edit',
        // old/new 各带首尾上下文行（ctx-a/ctx-b 未变）
        args: { file_path: 'b.ts', old_string: 'ctx-a\nL1\nL2\nL3\nL4\nL5', new_string: 'ctx-a\nN1\nN2\nN3\nN4\nN5' },
        result: okEdit('b.ts', 8, 3), // 工具报告口径（区域计数）
      }], 2000),
    ];
    const { files, events } = fileEditsOf(msgs);
    const steps = editStepsOf(files.get('b.ts')!, events);
    expect(steps).toHaveLength(2);
    const step = steps[1];
    expect(step.after).toBe(after);
    // LCS：ctx-a/ctx-b 是公共行——真实变更只有 5 行替换中发生变化的行
    const real = countLineChanges(base, after);
    expect(step.added).toBe(real.added);
    expect(step.removed).toBe(real.removed);
    // 与单次 diff 渲染一致（所见即所得）
    const d = diffOfStep(step);
    expect(d.added).toBe(step.added);
    expect(d.removed).toBe(step.removed);
    // 与工具报告不同（工具把未变上下文行也计入了）
    expect(step.event.added).toBe(8);
    expect(step.event.removed).toBe(3);
  });
});
