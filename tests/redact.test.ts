// ============================================================
// src/plugins/builtin/hooks/redact.ts 单元测试 —— 输出脱敏器
//
// 验证：通用密钥模式掩码 / 配置赋值保留前缀 / 凭据库精确值 /
//       装配注入额外值 / 普通文本不误伤。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { makeSecretRedactor } from '../src/plugins/builtin/hooks/redact';
import { setCredential } from '../src/agents/credential-store';

let credFile = '';

beforeEach(() => {
  credFile = path.join(os.tmpdir(), `agentchat-cred-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.AGENTCHAT_CREDENTIALS_FILE = credFile;
});

afterEach(() => {
  delete process.env.AGENTCHAT_CREDENTIALS_FILE;
  if (fs.existsSync(credFile)) fs.rmSync(credFile, { force: true });
});

describe('makeSecretRedactor —— 输出脱敏', () => {
  it('通用模式：sk- 前缀密钥被掩码', () => {
    const redact = makeSecretRedactor();
    const out = redact('使用 key: sk-abcdefghijklmnopqrstuvwxyz123456 完成', 'bash');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('***');
  });

  it('配置赋值模式：api_key 值被掩码但保留前缀', () => {
    const redact = makeSecretRedactor();
    const out = redact('export api_key="sk-abcdefghijklmnopqrstuvwxyz123456"', 'bash');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('api_key="***"');
  });

  it('精确值：凭据库中的明文值被替换', () => {
    setCredential('agentA', 'deepseek', 'sk-very-secret-value-0001');
    const redact = makeSecretRedactor();
    const out = redact('读到凭据 sk-very-secret-value-0001 了', 'read');
    expect(out).not.toContain('sk-very-secret-value-0001');
    expect(out).toContain('***');
  });

  it('装配注入的额外值（extraSecrets）被替换', () => {
    const redact = makeSecretRedactor(() => ['cfg-secret-xyz']);
    const out = redact('配置里是 cfg-secret-xyz', 'read');
    expect(out).not.toContain('cfg-secret-xyz');
    expect(out).toContain('***');
  });

  it('普通文本不受影响', () => {
    const redact = makeSecretRedactor();
    expect(redact('你好，世界，普通内容', 'read')).toBe('你好，世界，普通内容');
  });
});
