// ============================================================
// socket.ts —— ipc socket 命名规则（协议规格 B1/B2，M1.2 同批钉）
//
// 规范形态（posix）：<dataRoot>/ipc/<agentId>.sock —— 数据根内聚、
// agent 级唯一（与 activation.lock 同址域）。Windows 无文件域 socket，
// 等价映射为 named pipe：posix 规范路径整体 sanitize 进管道名（多数据
// 根天然不撞名）。输出恒 posix 分隔符——win 数据根入参用 win32 分隔符
// 时先归一（isAbsolute 双平台兼容判定）。
// ============================================================

import { isAbsolute, posix } from 'node:path';

/** posix 规范形态：<dataRoot>/ipc/<agentId>.sock；win32 映射 named pipe */
export function socketPathFor(dataRoot: string, agentId: string, platform: NodeJS.Platform = process.platform): string {
  assertEndpointComponent(agentId, 'agentId');
  if (!isAbsolute(dataRoot) && !/^[A-Za-z]:[\\/]/.test(dataRoot)) {
    throw new Error(`dataRoot 须为绝对路径: ${dataRoot}`);
  }
  const posixPath = posix.join(dataRoot.replaceAll('\\', '/'), 'ipc', `${agentId}.sock`);
  if (platform !== 'win32') return posixPath;
  // named pipe：非字母数字一律折叠为 '-'（管道名全域扁平，路径入名防撞）
  const sanitized = posixPath.replace(/[^a-zA-Z0-9]+/g, '-');
  return `\\\\.\\pipe\\agentchat-${sanitized}`;
}

/** 端点组件断言（fail-loud：防路径穿越——开放词汇不等于可含分隔符） */
export function assertEndpointComponent(value: string, what: string): void {
  if (value.length === 0) throw new Error(`${what} 不得为空`);
  if (/[/\\]/.test(value) || value === '.' || value === '..') {
    throw new Error(`${what} 含路径组件（${value}）——拒绝`);
  }
}
