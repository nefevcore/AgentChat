// ============================================================
// Hashline DSL edit 路径回归测试
//
// 覆盖 2026-08-12 审计（note/edit-tool-audit-20260812.md）修复：
//   P0-1: applyOps 多 op 行号错位（从后往前应用）
//   P0-2: verifySnapshot 并发盲区（外部修改后基于旧行号静默改错位置）
//   P1-3: SWAP 空 body 静默丢弃（空 body = 删除，INS 空 body 显式报错）
//   P2-4: 混合换行文件被强制统一（按行保留原始行尾）
//   P2-5: JSON prepend 先行导致后续行号偏移（prepend 最后执行）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { recordSnapshot, clearSnapshot } from '@agentchat/edit';
import { computeFileHash, hashLine } from '@agentchat/edit';
import { makeEditTool } from '@agentchat/edit';
import type { AgentConfig } from '@agentchat/agent-config';

const dir = path.resolve('workspace/default');
const rel = '__hashline_dsl_test.md';
const file = path.join(dir, rel);
const editTool = makeEditTool({ agent_id: 'test', name: 'Test' } as AgentConfig);

/** DSL patch 输入 */
function patch(body: string): string {
  const tag = computeFileHash(fs.readFileSync(file, 'utf-8'));
  return `[${rel}#${tag}]\n${body}`;
}

/** 执行 DSL edit 并解析 JSON 结果 */
async function runDSL(body: string): Promise<any> {
  const res = await editTool.execute({ input: patch(body) }, undefined as any);
  return JSON.parse(res as string);
}

describe('P0-1：单 section 多 SWAP 行号不错位（从后往前应用）', () => {
  const original = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    recordSnapshot(file, original); // 模拟 read
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('SWAP 2 增加行数后，SWAP 5/8 仍改到原始目标行', async () => {
    const body = [
      'SWAP 2.=2:',
      '+b1',
      '+b2',
      'SWAP 5.=5:',
      '+EPSILON',
      'SWAP 8.=8:',
      '+THETA',
    ].join('\n');
    const res = await runDSL(body);
    expect(res.status).toBe('success');
    // 修复前：SWAP 2 使行数 +1，后续 SWAP 5/8 错位改到 delta/eta
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      'alpha\nb1\nb2\ngamma\ndelta\nEPSILON\nzeta\neta\nTHETA\niota\nkappa\n'
    );
  });

  it('INS.PRE 与后续 SWAP 混用不错位', async () => {
    const body = [
      'INS.PRE 3:',
      '+X',
      'SWAP 6.=6:',
      '+Z6',
    ].join('\n');
    const res = await runDSL(body);
    expect(res.status).toBe('success');
    // SWAP 6 替换原始第 6 行（zeta→Z6），INS.PRE 3 在原始第 3 行前插 X
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      'alpha\nbeta\nX\ngamma\ndelta\nepsilon\nZ6\neta\ntheta\niota\nkappa\n'
    );
  });

  it('相邻多 SWAP（各自多行 body）内容完整（neko 第三轮复现场景）', async () => {
    // neko 第三轮报告（重构前）：DSL 多 SWAP 时第二条内容丢失 → 文件被截断成单行；
    // 次条行号误判报越界。统一管线（applyLineEdits 从后往前）应消除。
    const body = [
      'SWAP 1.=2:',
      '+A1',
      '+A2',
      'SWAP 4.=5:',
      '+D1',
      '+D2',
      'SWAP 8.=9:',
      '+H1',
      '+H2',
      '+H3',
    ].join('\n');
    const res = await runDSL(body);
    expect(res.status).toBe('success');
    // 三个 SWAP 各自内容完整、目标行正确（不截断、不越界）
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      'A1\nA2\ngamma\nD1\nD2\nzeta\neta\nH1\nH2\nH3\nkappa\n'
    );
    expect(res.data.edits_applied).toBe(3);
  });

  it('相邻单行 SWAP（2 与 3 紧邻）不错位', async () => {
    const body = [
      'SWAP 2.=2:',
      '+B1',
      'SWAP 3.=3:',
      '+C1',
    ].join('\n');
    const res = await runDSL(body);
    expect(res.status).toBe('success');
    // 紧邻行：第 2 行→B1、第 3 行→C1（从后往前先 SWAP 3 再 SWAP 2）
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      'alpha\nB1\nC1\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n'
    );
  });
});

describe('P0-2：read 后文件被外部修改 → DSL 报错而非静默改错位置', () => {
  const original = 'alpha\nbeta\ngamma\ndelta\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    recordSnapshot(file, original); // 模拟 read
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('外部插入行后基于旧行号 edit → TAG 不匹配报错，文件不变', async () => {
    // 外部修改：第 2 行前插入一行（行号全部偏移）
    fs.writeFileSync(file, 'alpha\nEXTRA\nbeta\ngamma\ndelta\n');
    const res = await runDSL('SWAP 2.=2:\n+BETA!');
    expect(res.status).toBe('error');
    expect(res.data.message).toMatch(/TAG 不匹配|已被修改/);
    // 文件未被改动
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nEXTRA\nbeta\ngamma\ndelta\n');
  });
});

describe('P1-3：SWAP 空 body = 删除行；INS 空 body 显式报错', () => {
  const original = 'a\nb\nc\nd\ne\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    recordSnapshot(file, original);
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('SWAP 2.=3 空 body → 删除第 2-3 行', async () => {
    const res = await runDSL('SWAP 2.=3:');
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nd\ne\n');
    // edits_applied 不再丢 op（统一返回字段，替代旧 ops_applied）
    expect(res.data.edits_applied).toBe(1);
    // 统一返回：新文件 TAG 供连续 edit 直接使用
    expect(res.data.file_tag).toMatch(/^[0-9a-f]+$/);
  });

  it('SWAP 单行空 body → 删除该行', async () => {
    const res = await runDSL('SWAP 3.=3:');
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\nd\ne\n');
  });

  it('INS.POST 空 body → 显式报错（不再静默丢弃）', async () => {
    const res = await runDSL('INS.POST 2:');
    expect(res.status).toBe('error');
    expect(res.data.message).toMatch(/缺少 body|语法错误/);
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });
});

describe('P2-4：混合换行文件按行保留原始行尾', () => {
  const original = 'a\r\nb\r\nc\r\nd\ne\n'; // 3 CRLF + 2 LF

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original, 'utf-8');
    recordSnapshot(file, original);
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('编辑第 3 行后，未编辑行（d/e）行尾不被强制统一为 CRLF', async () => {
    const res = await runDSL('SWAP 3.=3:\n+C3');
    expect(res.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\r\nb\r\nC3\r\nd\ne\n');
  });
});

describe('P2-5：JSON prepend 最后执行，不偏移后续 hash 行号', () => {
  const original = 'alpha\nbeta\ngamma\ndelta\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    recordSnapshot(file, original);
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('文件开头 prepend + 行号#哈希替换 → 替换仍命中原始第 3 行', async () => {
    const h3 = hashLine('gamma');
    const res = await editTool.execute(
      {
        edits: [
          { filePath: rel, op: 'prepend', newText: 'HEAD' },        // 无 pos → 文件开头
          { filePath: rel, op: 'replace', pos: `3#${h3}`, newText: 'GAMMA' },
        ],
      },
      undefined as any,
    );
    const parsed = JSON.parse(res as string);
    expect(parsed.status).toBe('success');
    // prepend 在替换之后执行：HEAD 加在头部，替换仍作用于原始第 3 行
    expect(fs.readFileSync(file, 'utf-8')).toBe('HEAD\nalpha\nbeta\nGAMMA\ndelta\n');
  });
});
