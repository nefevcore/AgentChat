// ============================================================
// ac-sandbox-core —— 沙箱与安全纯库（零 cordis 依赖）
//
// src 安全资产参数化平移（地图 §3.4：解除 toolkit→agent-config 依赖倒挂）：
//   · paths       —— createSandboxResolver({workdir, allowedPaths, denyPatterns}) +
//                    双黑名单装配工厂（createDenyListsFactory，cr-363 三姊妹并源）
//   · bash-scan   —— heredoc 剥离 + 命令段启发式扫描（纵深防御） + 防自杀检测
//   · redact      —— 输出脱敏（精确值 + 通用密钥模式；落 transform-result）
//   · notice      —— 唆使提权防御提示词（access-tier §八 软缓解）
// ac-security 行负责从 AgentConfig.settings['security'] 取参装配本库。
// ============================================================
export {
  createSandboxResolver,
  createAgentSandboxCache,
  createRootsContainment,
  isPathUnder,
  agentSpaceRoots,
  isDeniedPath,
  BUILTIN_DENY_PATTERNS,
  CONTROL_PLANE_FILES,
  PERSISTENCE_TREES,
  DEFAULT_READ_DENY,
  accessDenyPatterns,
  readDenyPatterns,
  denyExtrasOf,
  createDenyListsFactory,
} from './paths.ts';
export type { SandboxResolver, SandboxResolverOptions, SandboxWorkdirSource, DenyRowOptions, DenyListsSource } from './paths.ts';
export { bashCommandViolation, hostKillViolation, stripHeredocPayloads } from './bash-scan.ts';
export type { BashScanOptions } from './bash-scan.ts';
export { makeSecretRedactor, redactSecretValue } from './redact.ts';
export { securityNoticeText, wrapWithSecurityNotice } from './notice.ts';
