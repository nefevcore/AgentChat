// ============================================================
// src/plugins/builtin-math/index.ts —— 数学插件 mod 入口
//
// 与 builtin 对等的独立 mod，方便开关（注册/不注册即可）。
// 简单插件：仅工具（共享数组），无钩子。
// ============================================================

import type { PluginDefinition } from '../types';
import { mathTools } from './tools';

const plugin: PluginDefinition = {
  meta: { name: 'builtin-math', label: '数学', description: '基础数学工具' },
  tools: mathTools,
};

export default plugin;
