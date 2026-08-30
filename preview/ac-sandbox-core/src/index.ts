// ============================================================
// ac-sandbox-core —— 沙箱与安全纯库（零 cordis 依赖）
//
// src 安全资产参数化平移（地图 §3.4：解除 toolkit→agent-config 依赖倒挂）：
//   · paths       —— createSandboxResolver({workdir, allowedPaths, denyPatterns})
//   · bash-scan   —— heredoc 剥离 + 命令段启发式扫描（纵深防御）
//   · redact      —— 输出脱敏（精确值 + 通用密钥模式；落 transform-result）
// ac-security 行负责从 AgentConfig.settings['security'] 取参装配本库。
// ============================================================
export {
  createSandboxResolver,
  isDeniedPath,
  BUILTIN_DENY_PATTERNS,
} from './paths.ts';
export type { SandboxResolver, SandboxResolverOptions } from './paths.ts';
export { bashCommandViolation, stripHeredocPayloads } from './bash-scan.ts';
export type { BashScanOptions } from './bash-scan.ts';
export { makeSecretRedactor, redactSecretValue } from './redact.ts';
