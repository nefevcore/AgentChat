// ============================================================
// ac-remote-link/src/device-registry.ts —— 设备注册表（known_devices.json）
//
// 每设备一条：{ id, name, pubkey, scopes, pairedAt, lastSeenAt? }。
// 吊销 = 删除条目（下次 KK 握手直接失败——上游方案 §4.2）。
// 原子写纪律同 identity。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from './identity.ts';

/** 远程设备权限档（上游方案 §4.4；read/chat 默认，files/admin 显式开启） */
export type RemoteScope = 'read' | 'chat' | 'files' | 'admin';

export const REMOTE_SCOPES: readonly RemoteScope[] = ['read', 'chat', 'files', 'admin'];

export interface RemoteDevice {
  /** 稳定设备 id（配对时分配，如 dev-<rand>） */
  id: string;
  /** 显示名（手机端配对时上报，如 "pixel-8"） */
  name: string;
  /** 设备静态公钥（X25519，base64url 存储） */
  pubkey: string;
  scopes: RemoteScope[];
  pairedAt: number;
  lastSeenAt?: number;
}

interface RegistryFile {
  version: 1;
  devices: RemoteDevice[];
}

export class DeviceRegistry {
  private file: string;
  private devices: Map<string, RemoteDevice> = new Map();

  constructor(remoteDir: string) {
    fs.mkdirSync(remoteDir, { recursive: true });
    this.file = path.join(remoteDir, 'known_devices.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: number; devices?: RemoteDevice[] };
      if (raw.version !== 1 || !Array.isArray(raw.devices)) throw new Error(`unsupported version ${raw.version}`);
      for (const d of raw.devices) this.devices.set(d.id, d);
    } catch (err) {
      // 撕裂/手编坏：转存 .corrupt 后从空档开始（credentials 同款纪律——
      // 绝不静默覆盖可能是唯一副本的文件）
      const corrupt = this.file + '.corrupt';
      try { fs.renameSync(this.file, corrupt); } catch { /* 尽力而为 */ }
      // eslint-disable-next-line no-console
      console.warn(`[remote-link] known_devices.json 解析失败，已转存 ${corrupt}，从空档开始：${err instanceof Error ? err.message : err}`);
    }
  }

  private persist(): void {
    const payload: RegistryFile = { version: 1, devices: [...this.devices.values()] };
    atomicWrite(this.file, JSON.stringify(payload, null, 2));
  }

  list(): RemoteDevice[] {
    return [...this.devices.values()].map((d) => ({ ...d }));
  }

  get(id: string): RemoteDevice | undefined {
    const d = this.devices.get(id);
    return d ? { ...d } : undefined;
  }

  /** 按公钥查设备（握手身份识别用） */
  getByPubkey(pubkeyB64u: string): RemoteDevice | undefined {
    const d = [...this.devices.values()].find((x) => x.pubkey === pubkeyB64u);
    return d ? { ...d } : undefined;
  }

  /** 新设备注册（配对成功时调用） */
  add(device: RemoteDevice): void {
    if (this.devices.has(device.id)) throw new Error(`device ${device.id} already registered`);
    this.devices.set(device.id, { ...device });
    this.persist();
  }

  /** 吊销 = 删除条目（下次握手直接失败） */
  revoke(id: string): RemoteDevice | undefined {
    const d = this.devices.get(id);
    if (!d) return undefined;
    this.devices.delete(id);
    this.persist();
    return { ...d };
  }

  /** 更新最后活跃（在线状态/设备页排序用；懒落盘——每次连接成功时调） */
  touch(id: string): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.lastSeenAt = Date.now();
    this.persist();
  }
}