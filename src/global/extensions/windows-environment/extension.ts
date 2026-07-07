// ====================================================================
// windows-environment 扩展 —— preHook 时注入 Windows 环境提示
//
//   在 systemPrompt 末尾追加环境信息，告知 LLM 当前运行在 Windows 上，
//   避免使用 Linux 专用命令（如 ls、cat、grep、sed 等），减少不必要的试错循环。
//
// ── 使用方式 ──
//   在 Agent 的 config.json 中配置：
//   { "pre_hooks": ["windows-environment", ...] }
// ====================================================================

import { AgentContext, Extension, PreProcessHook } from '../../../core/types';

/**
 * 生成 Windows 环境提示块
 */
function buildWindowsEnvBlock(): string {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const arch = process.arch;        // 'x64' | 'arm64'
  const shell = process.env.ComSpec ?? process.env.SHELL ?? 'powershell';

  let block = `[环境信息] 当前运行环境为 Windows`;

  // 补充架构信息
  if (arch) {
    block += ` (${arch})`;
  }

  block += `。\n`;

  // 核心提示：避免 Linux 命令
  block += `请使用 Windows 兼容的命令和工具：\n`;
  block += `  · Shell: PowerShell（推荐）或 CMD\n`;
  block += `  · 文件列表: dir 或 Get-ChildItem（不要用 ls）\n`;
  block += `  · 文件内容: type 或 Get-Content（不要用 cat）\n`;
  block += `  · 文本搜索: Select-String 或 findstr（不要用 grep）\n`;
  block += `  · 文本替换: (Get-Content ...) -replace 或 -join（不要用 sed）\n`;
  block += `  · 路径分隔符: \\（不要用 /）\n`;
  block += `  · 环境变量: $env:VAR_NAME（不要用 $VAR_NAME）\n`;
  block += `  · 命令链接: ;（不要用 &&）\n`;
  block += `  · 后台任务: Start-Job（不要用 & 或 nohup）`;

  return block;
}

// ====================================================================
// preHook —— 在 systemPrompt 尾部注入 Windows 环境信息
// ====================================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  // 仅在 Windows 平台注入环境提示，其他平台直接透传
  if (process.platform !== 'win32') {
    return ctx;
  }

  const envBlock = buildWindowsEnvBlock();

  const systemPrompt = `${ctx.systemPrompt}\n\n${envBlock}`;

  return {
    ...ctx,
    systemPrompt,
  };
};

// ====================================================================
// Extension 统一入口
// ====================================================================

export const extension: Extension = {
  meta: {
    name: 'windows-environment',
    description: '注入 Windows 环境提示，引导 LLM 使用 PowerShell/CMD 命令而非 Linux 命令。',
  },
  preHook,
};
