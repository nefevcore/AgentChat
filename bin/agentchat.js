#!/usr/bin/env node
// AgentChat CLI —— 唯一启动入口
// 运行打包后的 dist/agentchat.mjs（已内联全部后端与依赖）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'agentchat.mjs');

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
