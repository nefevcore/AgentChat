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

/** 写入一天的用量记录。
 *  字段语义与 agent-loop accumulateUsage 一致：prompt/total 为最后一次调用值，
 *  accumulated_* 为整次 run 全部 step 之和（accPrompt = hit + miss，accTotal = accPrompt + completion）；
 *  不传 accumulated 即模拟旧格式（单步时代，字段值即全量）。 */
function writeDay(date: string, records: Array<{ agent: string; counterpart: string; total?: number; llm?: string; model?: string; cacheHit?: number; cacheMiss?: number; accTotal?: number }>): void {
  const lines = records.map(r => {
    const completion = r.total !== undefined ? Math.round(r.total / 3) : 5;
    const hit = r.cacheHit ?? 0;
    const miss = r.cacheMiss ?? 0;
    const rec: Record<string, unknown> = {
      timestamp: `${date}T12:00:00.000Z`,
      agent: r.agent,
      counterpart: r.counterpart,
      react_steps: 1,
      prompt_tokens: r.total !== undefined ? Math.round(r.total * 0.8) : 10, // 末步输入
      completion_tokens: completion,                                        // 累计输出
      total_tokens: r.total ?? 15,                                          // 末步 total
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
    };
    if (r.accTotal !== undefined) {
      rec.accumulated_prompt_tokens = hit + miss;
      rec.accumulated_total_tokens = r.accTotal;
    }
    if (r.llm !== undefined) rec.llm = r.llm;
    if (r.model !== undefined) rec.model = r.model;
    return JSON.stringify(rec);
  });
  fs.writeFileSync(path.join(usageDir, `token_${date}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-usage-'));
  usageDir = path.join(tmpRoot, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  state.sessionsDir = path.join(tmpRoot, 'sessions');

  // 数据：3 天前（旧格式无 accumulated，单步时代）/ 昨天 / 今天（今天文件名必须与 today() 一致）
  // 昨天 record1 模拟多步 run：末步 total=20，整次累计 accTotal=180（hit 30 + miss 70 = accPrompt 100，completion 80）
  writeDay(shiftDays(-3), [{ agent: 'alpha', counterpart: 'beta', total: 100, model: 'deepseek-chat', cacheHit: 6, cacheMiss: 94 }]);
  writeDay(shiftDays(-1), [
    { agent: 'alpha', counterpart: 'beta', total: 20, llm: 'deepseek-chat', cacheHit: 30, cacheMiss: 70, accTotal: 180 },
    { agent: 'user', counterpart: 'alpha', total: 7, llm: 'glm-5.3', cacheHit: 1, cacheMiss: 9 },
  ]);
  writeDay(dayStr(new Date()), [{ agent: 'beta', counterpart: 'gamma', total: 300, llm: 'glm-5.3' }]);

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
  // 多步累计口径：昨天 record1 末步 total=20 但整次 run accTotal=180 → 聚合按 180 计
  const ACC_SUM = 100 + 180 + 7 + 300; // 全量（旧格式回退 100 + 多步 180 + 7 + 300）

  it('无参数 → 全量聚合（快照路径）并返回 range 覆盖区间', async () => {
    const data = await getJson();
    expect(data.overall.total_records).toBe(4);
    expect(data.overall.total_tokens).toBe(ACC_SUM);
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

  it('?days=2 → 昨天+今天（多步 run 按累计 accTotal 计，非末步 total）', async () => {
    const data = await getJson('?days=2');
    expect(data.overall.total_tokens).toBe(180 + 7 + 300);
    expect(data.range.from).toBe(shiftDays(-1));
  });

  it('?from=&to= → 自定义区间（含两端）', async () => {
    const from = shiftDays(-3);
    const to = shiftDays(-1);
    const data = await getJson(`?from=${from}&to=${to}`);
    expect(data.overall.total_tokens).toBe(100 + 180 + 7);
    expect(data.range.from).toBe(from);
    expect(data.range.to).toBe(to);
  });

  it('from > to 自动交换；days 非法回退全量', async () => {
    const swapped = await getJson(`?from=${shiftDays(-1)}&to=${shiftDays(-3)}`);
    expect(swapped.overall.total_tokens).toBe(100 + 180 + 7);
    const invalid = await getJson('?days=abc');
    expect(invalid.overall.total_tokens).toBe(ACC_SUM);
  });

  it('范围内无数据文件 → 空结果且 range 为 null', async () => {
    const data = await getJson(`?from=2000-01-01&to=2000-01-02`);
    expect(data.overall.total_tokens).toBe(0);
    expect(data.by_agent).toHaveLength(0);
    expect(data.range.from).toBeNull();
    expect(data.range.to).toBeNull();
  });

  it('by_day 含缓存命中/未命中学段，by_day_llm 按日期 × 模型聚合', async () => {
    const data = await getJson('?days=2'); // 昨天 + 今天
    const yest = shiftDays(-1);
    const todayStr = dayStr(new Date());
    const dayMap = new Map<string, any>(data.by_day.map((d: any) => [d.date, d]));
    expect(dayMap.get(yest)).toMatchObject({ total_cache_hit: 31, total_cache_miss: 79 });
    expect(dayMap.get(todayStr)).toMatchObject({ total_cache_hit: 0, total_cache_miss: 0 });

    // 昨天两模型、今天一模型；多步 run 的模型用量同样按累计口径
    const cells = data.by_day_llm.filter((r: any) => r.date === yest);
    expect(cells).toHaveLength(2);
    const deepseek = cells.find((r: any) => r.llm === 'deepseek-chat');
    const glm = cells.find((r: any) => r.llm === 'glm-5.3');
    expect(deepseek.total_tokens).toBe(180);
    expect(glm.total_tokens).toBe(7);
    expect(data.by_day_llm.filter((r: any) => r.date === todayStr)).toHaveLength(1);
    // 日期升序
    const dates = data.by_day_llm.map((r: any) => r.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('last step 口径独立统计（末步值合计，不与计费口径混淆）', async () => {
    const data = await getJson('?days=2'); // 昨天(16+6 末步) + 今天(240 末步)
    // overall：计费口径 180+7+300=487；last step 口径 = 20+7+300 = 327
    expect(data.overall.total_tokens).toBe(180 + 7 + 300);
    expect(data.overall.last_step_total_tokens).toBe(20 + 7 + 300);
    // by_day：昨日 last_step_total = record1 末步 20 + record2 末步 7
    const yest = shiftDays(-1);
    const du = new Map<string, any>(data.by_day.map((d: any) => [d.date, d]));
    expect(du.get(yest).last_step_total_tokens).toBe(20 + 7);
    // by_agent：末次 run 的末步值（alpha 最新记录 = 昨天 record1 → 20）
    const alpha = data.by_agent.find((a: any) => a.agent === 'alpha');
    expect(alpha.last_total_tokens).toBe(20);
    expect(alpha.last_prompt_tokens).toBe(16); // writeDay 末步 prompt = round(total*0.8)
  });

  it('旧数据（仅 model 字段无 llm / 无 accumulated）正确归因并回退全量', async () => {
    // 3 天前的记录只写 model: deepseek-chat 且无 accumulated_*（单步时代）→ 归因模型、字段值即全量
    const data = await getJson(`?from=${shiftDays(-3)}&to=${shiftDays(-3)}`);
    expect(data.by_day_llm).toHaveLength(1);
    expect(data.by_day_llm[0]).toMatchObject({ llm: 'deepseek-chat', total_tokens: 100 });
    expect(data.by_day[0]).toMatchObject({ total_cache_hit: 6, total_cache_miss: 94 });
  });

  it('无参数（快照路径）同样返回 by_day_llm 与缓存字段', async () => {
    const data = await getJson();
    expect(data.by_day_llm.length).toBeGreaterThan(0);
    for (const d of data.by_day) {
      expect(typeof d.total_cache_hit).toBe('number');
      expect(typeof d.total_cache_miss).toBe('number');
    }
    // 快照重建后 by_day_llm 覆盖全部 3 天（今天实时并入）
    const dates = new Set(data.by_day_llm.map((r: any) => r.date));
    expect(dates.size).toBe(3);
  });

  it('旧版快照（缺 by_day_llm）自动全量重建', async () => {
    // 先正常访问生成新快照，再降级为旧版结构（删 by_day_llm / 版本号 → 2）
    await getJson();
    const snapPath = path.join(usageDir, 'usage_summary.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    delete snap.by_day_llm;
    snap.version = 2;
    for (const d of Object.values(snap.by_day as Record<string, any>)) {
      delete d.total_cache_hit;
      delete d.total_cache_miss;
    }
    fs.writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');

    const data = await getJson();
    // 重建后缓存字段、last step 字段与 by_day_llm 恢复
    expect(data.by_day_llm.length).toBeGreaterThan(0);
    for (const d of data.by_day) {
      expect(typeof d.total_cache_hit).toBe('number');
      expect(typeof d.last_step_total_tokens).toBe('number');
    }
    expect(typeof data.overall.last_step_total_tokens).toBe('number');
  });
});
