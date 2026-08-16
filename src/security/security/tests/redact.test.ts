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
import { makeSecretRedactor, makeRedactEndHook } from '@agentchat/security';
import { setCredential } from '@agentchat/agents';

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

describe('makeRedactEndHook —— toolExecutionEnd 变换', () => {
  it('string 结果整体替换 content', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const hook = makeRedactEndHook();
    const transformed = await hook({
      toolName: 'read',
      args: {},
      result: `读到 ${secret}`,
    });
    expect(transformed).toEqual({ content: '读到 ***' });
  });

  it('{ content, details } 结果同时脱敏 content 与 details', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const hook = makeRedactEndHook(() => ['extra-secret-0001']);
    const transformed = await hook({
      toolName: 'read',
      args: {},
      result: {
        content: `正文 ${secret}`,
        details: { nested: ['extra-secret-0001', 'plain'] },
      },
    });
    expect(transformed).toEqual({
      content: '正文 ***',
      details: { nested: ['***', 'plain'] },
    });
  });

  it('空结果返回 undefined（不改变内容）', async () => {
    const hook = makeRedactEndHook();
    await expect(hook({ toolName: 'read', args: {}, result: '' })).resolves.toBeUndefined();
  });
});
