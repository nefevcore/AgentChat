// ============================================================
// 2026-08-20 工具面调整回归：
//   · read(file_path, offset, limit) 分段读取
//   · write(file_path, content) 命名
//   · grep_history / read_history（query_history 拆分后）
//   · bash description → extractLabel
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeReadTool, makeWriteTool } from '@agentchat/fs';
import { makeGrepHistoryTool, makeReadHistoryTool } from '@agentchat/session-tools';
import { makeBashTool } from '@agentchat/shell';
import { chatSessionFile } from '@agentchat/toolkit';
import type { AgentConfig } from '@agentchat/agent-config';

const dir = path.resolve('workspace/default');
const rel = '__tool_adjust_test.md';
const file = path.join(dir, rel);
const config = { agent_id: 'test', name: 'Test' } as AgentConfig;
const readTool = makeReadTool(config);
const writeTool = makeWriteTool(config);

beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
});
afterEach(() => fs.rmSync(file, { force: true }));

describe('read(file_path, offset, limit)', () => {
  it('默认读全文，行号从 1 开始', async () => {
    const data = JSON.parse(String(await readTool.execute!({ file_path: rel }, undefined as any)));
    expect(data.status).toBe('success');
    expect(data.data.total_lines).toBe(51); // 50 行 + 尾空行
    expect(data.data.content.startsWith('1:line-01')).toBe(true);
    expect(data.data.truncated).toBeUndefined();
  });

  it('offset/limit 分段读取，行号全局连续', async () => {
    const data = JSON.parse(String(await readTool.execute!({ file_path: rel, offset: 10, limit: 5 }, undefined as any)));
    const lines = data.data.content.split('\n');
    expect(lines[0]).toBe('10:line-10');
    expect(lines[4]).toBe('14:line-14');
    expect(data.data.truncated).toBe(true);
    expect(data.data.next_offset).toBe(15);
  });

  it('offset 超出范围返回空段', async () => {
    const data = JSON.parse(String(await readTool.execute!({ file_path: rel, offset: 999 }, undefined as any)));
    expect(data.status).toBe('success');
    expect(data.data.content).toBe('');
  });

  it('旧 path 参数兼容', async () => {
    const data = JSON.parse(String(await readTool.execute!({ path: rel, limit: 2 }, undefined as any)));
    expect(data.status).toBe('success');
    expect(data.data.content.split('\n')[0]).toBe('1:line-01');
  });
});

describe('write(file_path, content)', () => {
  it('正典命名写入', async () => {
    const res = JSON.parse(String(await writeTool.execute!({ file_path: rel, content: 'a\nb\n' }, undefined as any)));
    expect(res.status).toBe('ok');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\n');
  });
  it('旧 path 参数兼容', async () => {
    const res = JSON.parse(String(await writeTool.execute!({ path: rel, content: 'x' }, undefined as any)));
    expect(res.status).toBe('ok');
    expect(fs.readFileSync(file, 'utf-8')).toBe('x');
  });
});

describe('grep_history / read_history', () => {
  // 用 chatSessionFile 计算真实路径（字典序 lo~hi 命名），测试隔离目录
  const sessFile = chatSessionFile('test', '__ut_hist__');
  const grepTool = makeGrepHistoryTool(config);
  const histTool = makeReadHistoryTool(config);

  beforeEach(() => {
    fs.mkdirSync(path.dirname(sessFile), { recursive: true });
    const msgs = [
      { role: 'user', agent_id: 'user', content: '你好，约定明天开会', timestamp: '2026-08-19T10:00:00.000Z' },
      { role: 'assistant', agent_id: 'test', content: '好的，记住了', timestamp: '2026-08-19T10:00:05.000Z' },
      { role: 'user', agent_id: 'user', content: '会议改到周三', timestamp: '2026-08-19T11:00:00.000Z' },
      { role: 'assistant', agent_id: 'test', content: '已更新日程', timestamp: '2026-08-19T11:00:05.000Z' },
      { role: 'assistant', agent_id: 'test', content: '长消息测试。' + '细节数据'.repeat(120), timestamp: '2026-08-19T12:00:00.000Z' },
    ];
    fs.writeFileSync(sessFile, msgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  });
  afterEach(() => fs.rmSync(path.dirname(sessFile), { recursive: true, force: true }));

  it('grep_history 按关键词检索全部命中', async () => {
    const out = String(await grepTool.execute!({ pattern: '会议', agent_id: '__ut_hist__' }, undefined as any));
    expect(out).toContain('共 1 条');
    expect(out).toContain('会议改到周三');
  });

  it('grep_history 无命中给出提示', async () => {
    const out = String(await grepTool.execute!({ pattern: '不存在', agent_id: '__ut_hist__' }, undefined as any));
    expect(out).toContain('未找到');
  });

  it('read_history 分页读取（默认最新在前）', async () => {
    const out = String(await histTool.execute!({ agent_id: '__ut_hist__', limit: 2 }, undefined as any));
    expect(out).toContain('共 5 条');
    expect(out).toContain('offset=2');
  });

  it('长消息预览标注截断与全文长度', async () => {
    const out = String(await histTool.execute!({ agent_id: '__ut_hist__', limit: 1 }, undefined as any));
    expect(out).toContain('已截断');
    expect(out).toContain('全文 486 字符'); // 6（"长消息测试。"）+ 4×120（"细节数据".repeat）
  });

  it('read_history full=true 输出完整内容', async () => {
    const out = String(await histTool.execute!({ agent_id: '__ut_hist__', limit: 1, full: true }, undefined as any));
    expect(out).toContain('全文模式');
    expect(out).not.toContain('已截断');
    expect(out).toContain('长消息测试。'); // 全文开头可见
    const fullText = '长消息测试。' + '细节数据'.repeat(120);
    expect(out).toContain(fullText.slice(-30)); // 全文结尾可见（未被截断）
  });

  it('grep_history 命中长消息时给全文引导提示', async () => {
    const out = String(await grepTool.execute!({ pattern: '长消息', agent_id: '__ut_hist__' }, undefined as any));
    expect(out).toContain('共 1 条');
    expect(out).toContain('已截断');
    expect(out).toContain('full=true');
  });

  it('二选一冲突与缺失报错', async () => {
    expect(String(await grepTool.execute!({ pattern: 'x', agent_id: 'a', group_id: 'g' }, undefined as any))).toContain('二选一');
    expect(String(await histTool.execute!({}, undefined as any))).toContain('agent_id');
  });
});

describe('bash description → extractLabel', () => {
  const bashTool = makeBashTool(config);
  it('有 description 时展示 description', () => {
    expect(bashTool.extractLabel!({ command: 'npm test', description: '跑单测' })).toBe('跑单测');
  });
  it('无 description 回退 command', () => {
    expect(bashTool.extractLabel!({ command: 'npm test' })).toBe('npm test');
  });
});
