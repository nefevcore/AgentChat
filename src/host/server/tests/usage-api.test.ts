// ============================================================
// usage API 日期范围过滤 —— GET /api/usage/tokens?days= / from= to=
// ============================================================
import express from 'express';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// configService.getGlobalConfig → 临时 usage 目录（usageDir = dirname(sessionsDir)/usage）
const state = vi.hoisted(() => ({ sessionsDir: '' }));
vi.mock('../src/config-service', () => ({
  configService: { getGlobalConfig: () => ({ sessionsDir: state.sessionsDir }) },
}));

import { createUsageRouter } from '../src/api/usage';

let tmpRoot: string;
let usageDir: string;
let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

/** YYYY-MM-DD（与后端 today() 同口径：UTC） */
function dayStr(d: Date): string { return d.toISOString().slice(0, 10); }

function shiftDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return dayStr(d);
}

function writeDay(date: string, records: Array<{ agent: string; counterpart: string; total?: number }>): void {
  const lines = records.map(r => JSON.stringify({
    timestamp: `${date}T12:00:00.000Z`,
    agent: r.agent,
    counterpart: r.counterpart,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: r.total ?? 15,
    react_steps: 1,
  }));
  fs.writeFileSync(path.join(usageDir, `token_${date}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-usage-'));
  usageDir = path.join(tmpRoot, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  state.sessionsDir = path.join(tmpRoot, 'sessions');

  // 数据：3 天前 / 昨天 / 今天（今天文件名必须与 today() 一致）
  writeDay(shiftDays(-3), [{ agent: 'alpha', counterpart: 'beta', total: 100 }]);
  writeDay(shiftDays(-1), [
    { agent: 'alpha', counterpart: 'beta', total: 20 },
    { agent: 'user', counterpart: 'alpha', total: 7 },
  ]);
  writeDay(dayStr(new Date()), [{ agent: 'beta', counterpart: 'gamma', total: 300 }]);

  app = express();
  app.use('/api/usage', createUsageRouter());
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function getJson(qs = ''): Promise<any> {
  const resp = await fetch(`${baseUrl}/api/usage/tokens${qs}`);
  expect(resp.ok).toBe(true);
  return resp.json();
}

describe('usage API 日期范围过滤', () => {
  it('无参数 → 全量聚合（快照路径）并返回 range 覆盖区间', async () => {
    const data = await getJson();
    expect(data.overall.total_records).toBe(4);
    expect(data.overall.total_tokens).toBe(100 + 20 + 7 + 300);
    // gamma 仅作为 counterpart 出现，不进 by_agent
    expect(data.by_agent.map((a: any) => a.agent).sort()).toEqual(['alpha', 'beta', 'user']);
    expect(data.range.from).toBe(shiftDays(-3));
    expect(data.range.to).toBe(dayStr(new Date()));
  });

  it('?days=1 → 仅今天', async () => {
    const data = await getJson('?days=1');
    expect(data.overall.total_records).toBe(1);
    expect(data.overall.total_tokens).toBe(300);
    expect(data.range.from).toBe(dayStr(new Date()));
    // by_pair 仅 beta|gamma
    expect(data.by_pair).toHaveLength(1);
    expect(data.by_pair[0].total_tokens).toBe(300);
  });

  it('?days=2 → 昨天+今天', async () => {
    const data = await getJson('?days=2');
    expect(data.overall.total_tokens).toBe(20 + 7 + 300);
    expect(data.range.from).toBe(shiftDays(-1));
  });

  it('?from=&to= → 自定义区间（含两端）', async () => {
    const from = shiftDays(-3);
    const to = shiftDays(-1);
    const data = await getJson(`?from=${from}&to=${to}`);
    expect(data.overall.total_tokens).toBe(100 + 20 + 7);
    expect(data.range.from).toBe(from);
    expect(data.range.to).toBe(to);
  });

  it('from > to 自动交换；days 非法回退全量', async () => {
    const swapped = await getJson(`?from=${shiftDays(-1)}&to=${shiftDays(-3)}`);
    expect(swapped.overall.total_tokens).toBe(100 + 20 + 7);
    const invalid = await getJson('?days=abc');
    expect(invalid.overall.total_tokens).toBe(100 + 20 + 7 + 300);
  });

  it('范围内无数据文件 → 空结果且 range 为 null', async () => {
    const data = await getJson(`?from=2000-01-01&to=2000-01-02`);
    expect(data.overall.total_tokens).toBe(0);
    expect(data.by_agent).toHaveLength(0);
    expect(data.range.from).toBeNull();
    expect(data.range.to).toBeNull();
  });
});
