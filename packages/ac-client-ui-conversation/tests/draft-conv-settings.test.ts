// ============================================================
// draft-conv-settings.test.ts —— cr-1093 发送时写（消息边界生效）
//
// cr-1084 的主诉（草稿期会话键不得写哨兵键）在本批以更强形态落定：
// 草稿位与续聊位都不再「选择即写」——控件只改表单，写只发生一次，
// 在发送边界（prepareSend → flushConvSettings 一次 patch 写真实会话键）。
//
// 源断言（ChatInput 重组件无整挂先例，按 draft-single src.toContain 同款
// 锁定接线；草稿物化语义在 ac-client-ui-singles/tests/draft-single.test.ts）：
//   · conv-settings/set 直写面全前端只剩 flushConvSettings 一处；
//   · 蒸发物不得回流（setConvSetting / convSettingStored / persistToolMode）；
//   · 发送链两入口（send / sendNow）都经 prepareSend；
//   · 控件只改表单（草稿暂存面 setConvOverride 不再被调用）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'client', 'ChatInput.vue'), 'utf-8');

describe('cr-1093 发送时写（ChatInput 写时机接线）', () => {
  it('conv-settings/set 直写面：flushConvSettings 一处 + immediate 泛写口一处（cr-1259 选择即写）', () => {
    const hits = src.match(/rpc\.call\('conv-settings\/set'/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it('发送边界机制三件在场：基线 / 脏值 patch / 一次落盘', () => {
    expect(src).toContain('const convBaseline = reactive<Record<string, string>>({});');
    expect(src).toContain('function dirtyConvPatch(): Record<string, string | null> | null {');
    expect(src).toContain('async function flushConvSettings(conversationId: string | null): Promise<void> {');
    expect(src).toContain('async function prepareSend(): Promise<boolean> {');
  });

  it('蒸发物不回流：统一写口/暂存读口/偏好继承写登记', () => {
    expect(src).not.toContain('setConvSetting(');
    expect(src).not.toContain('convSettingStored(');
    expect(src).not.toContain('persistToolMode(');
    expect(src).not.toContain('setConvOverride(');
  });

  it('发送链两入口都经 prepareSend（草稿物化 + 键一次落盘，失败不出门）', () => {
    const calls = src.match(/if \(!\(await prepareSend\(\)\)\) return;/g) ?? [];
    expect(calls).toHaveLength(2); // send / sendNow
  });

  it('草稿位判定仍在（草稿位跳过服务端回读——哨兵脏值不回显）', () => {
    expect(src).toContain('const onDraft = computed(');
    const guards = src.match(/if \(onDraft\.value\) \{/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2); // toolMode watch + browserTier watch
  });

  it('控件函数写时机：toolMode/browserTier 只改表单；extKey 按 def.immediate 分流（cr-1259）', () => {
    const bodyOf = (name: string): string => {
      const start = src.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      // 函数体到下一个顶层 `\n}` 为止（本文件的控件函数均无嵌套块超过该缩进）
      const end = src.indexOf('\n}', start);
      return src.slice(start, end);
    };
    for (const fn of ['selectToolMode', 'selectBrowserTier']) {
      const body = bodyOf(fn);
      expect(body).not.toContain('rpc.call(');
      expect(body).not.toContain('setConvSetting(');
    }
    // extKey：缺省仍只改表单——RPC 只在 def.immediate 分流后（选择即写键
    // cr-1259），且有 immediate 守卫 + 草稿位跳过
    const extBody = bodyOf('selectExtKey');
    expect(extBody).toContain('def?.immediate');
    expect(extBody).toContain('onDraft.value');
    // model：singles 分支仍写 session.json 域（防双源例外），1v1 分支表单化
    const modelBody = bodyOf('selectModel');
    expect(modelBody).toContain("updateSession(props.single.id, { model: value || null })");
    expect(modelBody).not.toContain('conv-settings/set');
  });
});