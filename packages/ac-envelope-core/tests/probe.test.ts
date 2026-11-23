// ============================================================
// probe.test.ts —— activation 持有者能力探针（cr-1255 三因子 ③）
//
// probeActivationHolder：connect transportHint 发 probe 帧核对 bootId。
// 证真（null）/ 证死（凭据串）两态；不授权接管（装配窗口的真壳尚无
// socket，无应答 ≠ 死——授权即双壳 split-brain，接管权威归 lock.ts
// 证死因子）。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listenIpc, socketPathFor, probeActivationHolder } from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-probe-' + process.pid);

beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('probeActivationHolder（cr-1255）', () => {
  it('真持有者在听且应答 bootId 匹配 → 证真（null）', async () => {
    const address = socketPathFor(path.resolve(ROOT), 'a1');
    const server = await listenIpc(address, (payload) => {
      if (typeof payload === 'object' && payload !== null && (payload as { manage?: { frame?: { ctrl?: string } } }).manage?.frame?.ctrl === 'probe') {
        return { manage: { id: (payload as { manage: { id: string } }).manage.id, ok: true, value: { bootId: 'b-1', pid: 100 } } };
      }
      return undefined;
    });
    try {
      expect(await probeActivationHolder({ transportHint: address, bootId: 'b-1', pid: 100 }, 2_000)).toBeNull();
    } finally {
      await server.close();
    }
  }, 10_000);

  it('无人监听（pid 复用现场——旧壳 socket 已亡）→ 证死（凭据含无法连接）', async () => {
    const address = socketPathFor(path.resolve(ROOT), 'ghost');
    const evidence = await probeActivationHolder({ transportHint: address, bootId: 'b-1', pid: 100 }, 2_000);
    expect(evidence).toContain('无法连接');
  }, 10_000);

  it('在听但应答 bootId 不匹配（换代后的新壳占同名地址）→ 证死（凭据含不匹配）', async () => {
    const address = socketPathFor(path.resolve(ROOT), 'mismatch');
    const server = await listenIpc(address, (payload) => {
      if (typeof payload === 'object' && payload !== null && (payload as { manage?: { frame?: { ctrl?: string } } }).manage?.frame?.ctrl === 'probe') {
        return { manage: { id: (payload as { manage: { id: string } }).manage.id, ok: true, value: { bootId: 'b-OTHER', pid: 200 } } };
      }
      return undefined;
    });
    try {
      const evidence = await probeActivationHolder({ transportHint: address, bootId: 'b-1', pid: 100 }, 2_000);
      expect(evidence).toContain('不匹配');
    } finally {
      await server.close();
    }
  }, 10_000);

  it('连接在但永不回帧（半死壳——事件循环卡死）→ 超时证死', async () => {
    const address = socketPathFor(path.resolve(ROOT), 'wedged');
    const server = await listenIpc(address, () => undefined); // 收帧不回
    try {
      const evidence = await probeActivationHolder({ transportHint: address, bootId: 'b-1', pid: 100 }, 500);
      expect(evidence).toContain('无应答');
    } finally {
      await server.close();
    }
  }, 10_000);
});
