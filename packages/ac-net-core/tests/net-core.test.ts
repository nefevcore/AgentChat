// ============================================================
// ac-net-core 单测（cr-1158）：网卡分析 / DNS 探测 / 状态机翻转 /
// 本地端点判定。全部纯函数（时钟与探测注入），同参恒值。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  analyzeInterfaces,
  initialNetState,
  isLocalBaseUrl,
  nextNetState,
  OFFLINE_CONFIRM,
  probeDns,
  type InterfaceSignal,
  type NetState,
} from '../src/index.ts';

const WITH = { names: ['以太网'], hasAddress: true } satisfies InterfaceSignal;
const WITHOUT = { names: [], hasAddress: false } satisfies InterfaceSignal;

describe('analyzeInterfaces', () => {
  it('滤 loopback/链路本地/无地址；虚拟网卡有地址如实计入', () => {
    const r = analyzeInterfaces({
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null, scopeid: undefined }],
      '以太网': [
        { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa', internal: false, cidr: null, scopeid: undefined },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa', internal: false, cidr: null, scopeid: 4 },
      ],
      'Wi-Fi': [ // 只有链路本地 v4（169.254）——不算有效
        { address: '169.254.3.4', netmask: '255.255.0.0', family: 'IPv4', mac: 'bb', internal: false, cidr: null, scopeid: undefined },
      ],
      'vEthernet (WSL)': [
        { address: '172.30.1.1', netmask: '255.255.255.0', family: 'IPv4', mac: 'cc', internal: false, cidr: null, scopeid: undefined },
      ],
      '空接口': [],
    });
    expect(r.names).toEqual(['以太网', 'vEthernet (WSL)']);
    expect(r.hasAddress).toBe(true);
  });
  it('全断 → 无信号', () => {
    expect(analyzeInterfaces({}).hasAddress).toBe(false);
  });
});

describe('probeDns', () => {
  it('成功返回耗时；失败返回 undefined（吞噬错误）', async () => {
    const ok = await probeDns('example.com', async () => '1.2.3.4');
    expect(typeof ok).toBe('number');
    const fail = await probeDns('nope.invalid', async () => { throw new Error('ENOTFOUND'); });
    expect(fail).toBeUndefined();
  });
});

describe('nextNetState 状态机', () => {
  const t0 = 1_000_000;
  it('在线期网卡有信号：零 DNS 探测（wantDns=false）', () => {
    const s = nextNetState(initialNetState(t0), WITH, undefined, t0 + 5000);
    expect(s.online).toBe(true);
    expect(s.flipped).toBe(false);
    expect(s.wantDns).toBe(false);
  });

  it('断网：连续 OFFLINE_CONFIRM 轮无信号 + DNS 失败才翻转 offline', () => {
    let s: NetState & { flipped: boolean; wantDns: boolean } = { ...initialNetState(t0), flipped: false, wantDns: false };
    // 第 1 轮无信号：疑似，不翻转，请求 DNS 数据
    s = nextNetState(s, WITHOUT, undefined, t0 + 3000);
    expect(s.online).toBe(true);
    expect(s.wantDns).toBe(true);
    // 第 2 轮无信号 + DNS 失败：翻转 offline
    s = nextNetState(s, WITHOUT, undefined, t0 + 6000);
    expect(s.online).toBe(false);
    expect(s.flipped).toBe(true);
    expect(s.since).toBe(t0 + 6000);
  });

  it('阈值轮 DNS 探测成功（漫游窗口）：维持在线不翻转', () => {
    let s: NetState & { flipped: boolean; wantDns: boolean } = { ...initialNetState(t0), flipped: false, wantDns: false };
    s = nextNetState(s, WITHOUT, 50, t0 + 3000);
    expect(s.online).toBe(true);
    s = nextNetState(s, WITHOUT, 50, t0 + 6000);
    expect(s.online).toBe(true);
    expect(s.flipped).toBe(false);
    expect(s.wantDns).toBe(true);
  });

  it('恢复：离线后网卡信号回来 → 立即翻转 online 并重置 DNS 记账', () => {
    let s: NetState & { flipped: boolean; wantDns: boolean } = { ...initialNetState(t0), flipped: false, wantDns: false };
    s = nextNetState(s, WITHOUT, undefined, t0 + 3000);
    s = nextNetState(s, WITHOUT, undefined, t0 + 6000);
    expect(s.online).toBe(false);
    s = nextNetState(s, { ...WITH, names: ['Wi-Fi'] }, undefined, t0 + 9000);
    expect(s.online).toBe(true);
    expect(s.flipped).toBe(true);
    expect(s.dnsEwma).toBeUndefined(); // 记账重置
    expect(s.dnsDisabled).toBeUndefined();
  });

  it('DNS 慢即停用（裁决 3）：EWMA > 1000ms → dnsDisabled，判定退回网卡单源', () => {
    let s: NetState & { flipped: boolean; wantDns: boolean } = { ...initialNetState(t0), flipped: false, wantDns: false };
    // 两轮慢探测累积 EWMA 超阈
    s = nextNetState(s, WITHOUT, 1800, t0 + 3000);
    s = nextNetState(s, WITHOUT, 2000, t0 + 6000);
    expect(s.dnsDisabled).toBe(true);
    // 已停用：离线期不再请求探测
    const next = nextNetState(s, WITHOUT, undefined, t0 + 9000);
    expect(next.wantDns).toBe(false);
    // 但 offline 判定不再被 DNS 拦住（网卡单源直翻）
    expect(next.online).toBe(false);
  });

  it('DNS 停用后阈值轮直接按网卡翻转（不等探测）', () => {
    let s: NetState & { flipped: boolean; wantDns: boolean } = { online: true, since: t0, missStreak: 0, dnsDisabled: true, flipped: false, wantDns: false };
    s = nextNetState(s, WITHOUT, undefined, t0 + 3000);
    s = nextNetState(s, WITHOUT, undefined, t0 + 6000);
    expect(s.online).toBe(false);
  });
});

describe('isLocalBaseUrl', () => {
  it('本地/私网端点豁免清单', () => {
    expect(isLocalBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBaseUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLocalBaseUrl('http://[::1]:9000')).toBe(true);
    expect(isLocalBaseUrl('http://192.168.1.10:8080/v1')).toBe(true);
    expect(isLocalBaseUrl('http://10.0.0.5/v1')).toBe(true);
    expect(isLocalBaseUrl('http://172.20.0.1/v1')).toBe(true);
    expect(isLocalBaseUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(isLocalBaseUrl(undefined)).toBe(false);
    expect(isLocalBaseUrl('not a url')).toBe(false);
  });
});