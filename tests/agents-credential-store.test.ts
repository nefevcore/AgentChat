// ============================================================
// src/agents/credential-store 单元测试 —— API Key 加密存取
//
// 通过 AGENTCHAT_CREDENTIALS_FILE 指向临时文件，隔离真实用户目录。
// 注意：PBKDF2(600k) 首次派生约数百 ms，模块内缓存密钥，全程只派生一次。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  credKey, getCredential, setCredential,
  getGlobalCredential, setGlobalCredential,
} from '../src/agents/credential-store';

let tmpFile = '';

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `agentchat-cred-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.AGENTCHAT_CREDENTIALS_FILE = tmpFile;
});

afterEach(() => {
  delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
});

describe('credential-store', () => {
  it('set/get 往返', () => {
    setCredential('agentA', 'deepseek', 'sk-test-123');
    expect(getCredential('agentA', 'deepseek')).toBe('sk-test-123');
  });

  it('落盘内容已加密（不含明文，v1: 前缀）', () => {
    setCredential('agentA', 'deepseek', 'sk-secret-xyz');
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    const stored = raw[credKey('agentA', 'deepseek')];
    expect(stored).toContain('v1:');
    expect(stored).not.toContain('sk-secret-xyz');
  });

  it('删除：置空值则移除键', () => {
    setCredential('agentA', 'openai', 'x');
    setCredential('agentA', 'openai', '');
    expect(getCredential('agentA', 'openai')).toBe('');
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(raw[credKey('agentA', 'openai')]).toBeUndefined();
  });

  it('全局凭据：__global__ 前缀', () => {
    expect(credKey('__global__', 'deepseek')).toBe('__GLOBAL___DEEPSEEK_API_KEY');
    setGlobalCredential('deepseek', 'sk-global');
    expect(getGlobalCredential('deepseek')).toBe('sk-global');
  });

  it('明文兼容：旧明文数据直接读取', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ [credKey('a', 'b')]: 'plain-old' }), 'utf-8');
    expect(getCredential('a', 'b')).toBe('plain-old');
  });

  it('每次读取走磁盘（无内存缓存）', () => {
    setCredential('agentA', 'deepseek', 'persisted');
    // 从文件外部删除该键 → 下次读取应返回空（证明读取不依赖内存缓存）
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    delete raw[credKey('agentA', 'deepseek')];
    fs.writeFileSync(tmpFile, JSON.stringify(raw), 'utf-8');
    expect(getCredential('agentA', 'deepseek')).toBe('');
  });
});
