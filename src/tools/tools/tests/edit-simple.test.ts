// ============================================================
// edit 工具简化后回归测试（2026-08-20：old_string/new_string 单一形态）
//
// 覆盖：
//   · 正典三参数（file_path/old_string/new_string）成功替换
//   · 唯一性校验（多次出现报错）
//   · 未找到报错 + 恢复建议
//   · 空字符串 new_string = 删除
//   · 模糊匹配（smart quotes）
//   · 旧 camelCase 入参兜底
//   · 已移除形态（DSL input / edits[] / pos）给出迁移引导
//   · CRLF 行尾保留
//   · read/write 无快照依赖（write 后直接 edit 可用）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeEditTool, makeReadTool, makeWriteTool } from '@agentchat/fs';
import type { AgentConfig } from '@agentchat/agent-config';

const dir = path.resolve('workspace/default');
const rel = '__edit_simple_test.md';
const file = path.join(dir, rel);
const editTool = makeEditTool({ agent_id: 'test', name: 'Test' } as AgentConfig);
const writeTool = makeWriteTool({ agent_id: 'test', name: 'Test' } as AgentConfig);
const readTool = makeReadTool({ agent_id: 'test', name: 'Test' } as AgentConfig);

beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8');
});

afterEach(() => {
  fs.rmSync(file, { force: true });
});

function run(args: Record<string, any>) {
  return editTool.execute!(args, undefined as any) as Promise<string>;
}

describe('edit 简化形态（file_path/old_string/new_string）', () => {
  it('正典三参数替换', async () => {
    const res = JSON.parse(await run({ file_path: rel, old_string: 'beta', new_string: 'BETA!' }));
    expect(res.status).toBe('success');
    expect(res.data.edits_applied).toBe(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nBETA!\ngamma\ndelta\n');
  });

  it('多行块替换（含换行）', async () => {
    const res = JSON.parse(await run({
      file_path: rel,
      old_string: 'beta\ngamma',
      new_string: 'B1\nB2\nB3',
    }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nB1\nB2\nB3\ndelta\n');
  });

  it('空 new_string = 删除 old_string', async () => {
    const res = JSON.parse(await run({ file_path: rel, old_string: 'gamma\n', new_string: '' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nbeta\ndelta\n');
  });

  it('多次出现 → 唯一性报错（含恢复建议）', async () => {
    fs.writeFileSync(file, 'x\nalpha\nx\nalpha\n', 'utf-8');
    const res = JSON.parse(await run({ file_path: rel, old_string: 'alpha', new_string: 'A' }));
    expect(res.status).toBe('error');
    expect(res.data.message).toContain('2 次');
    expect(res.data.message).toContain('唯一');
  });

  it('未找到 → 报错含恢复建议', async () => {
    const res = JSON.parse(await run({ file_path: rel, old_string: '不存在的内容', new_string: 'x' }));
    expect(res.status).toBe('error');
    expect(res.data.message).toContain('未找到');
    expect(res.data.message).toContain('read');
  });

  it('模糊匹配：smart quotes 归一化命中', async () => {
    fs.writeFileSync(file, '- 记录: it’s a test\n', 'utf-8');
    // old_string 用直引号（LLM 常见笔误），fuzzy Level 1 应命中弯引号原文
    const res = JSON.parse(await run({ file_path: rel, old_string: '- 记录: it\'s a test', new_string: '- 记录: 已替换' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('- 记录: 已替换\n');
  });

  it('旧 camelCase 入参兜底（filePath/oldText/newText）', async () => {
    const res = JSON.parse(await run({ filePath: rel, oldText: 'delta', newText: 'DELTA' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nbeta\ngamma\nDELTA\n');
  });

  it('CRLF 文件编辑后行尾保留', async () => {
    fs.writeFileSync(file, 'alpha\r\nbeta\r\n', 'utf-8');
    const res = JSON.parse(await run({ file_path: rel, old_string: 'beta', new_string: 'BETA' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\r\nBETA\r\n');
  });
});

describe('已移除形态的迁移引导', () => {
  it('DSL input → 明确迁移错误', async () => {
    const res = JSON.parse(await run({ input: `[${rel}#ab12]\nINS.TAIL:\n+新行` }));
    expect(res.status).toBe('error');
    expect(res.data.message).toContain('Hashline DSL');
    expect(res.data.message).toContain('old_string');
  });

  it('edits[] → 明确迁移错误', async () => {
    const res = JSON.parse(await run({ edits: [{ file_path: rel, old_text: 'beta', new_text: 'B' }] }));
    expect(res.status).toBe('error');
    expect(res.data.message).toContain('edits[]');
    expect(res.data.message).toContain('并行');
  });

  it('pos/op/end 行级定位 → 明确迁移错误', async () => {
    const res = JSON.parse(await run({ file_path: rel, pos: '2', new_string: 'X' }));
    expect(res.status).toBe('error');
    expect(res.data.message).toContain('行级定位');
  });
});

describe('读写衔接（无快照依赖）', () => {
  it('write 后直接 edit 可用（无需中间 read）', async () => {
    await writeTool.execute!({ path: rel, content: 'one\ntwo\n' }, undefined as any);
    const res = JSON.parse(await run({ file_path: rel, old_string: 'two', new_string: 'TWO' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('one\nTWO\n');
  });

  it('read 输出行号:内容（无 TAG 头），可复制 old_string', async () => {
    const raw = await readTool.execute!({ path: rel }, undefined as any);
    const data = JSON.parse(raw as string).data;
    expect(data.content).toContain('2:beta');
    expect(data.content).not.toMatch(/^\[/); // 无 [PATH#TAG] 头
    expect(data.file_tag).toBeUndefined();
  });
});
