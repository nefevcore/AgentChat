#!/usr/bin/env node
/**
 * ============================================================
 * update-config —— 将已有工作区配置迁移到当前默认值
 *
 * 用法：
 *   node scripts/update-config.js [workspaceDir] [--dry-run]
 *
 *   workspaceDir  工作区目录（默认 ./workspace/default，即当前工作区）
 *                 也可直接传 config.json 路径
 *   --dry-run     只打印将要执行的变更，不写文件
 *
 * 迁移规则（智能）：
 *   · 字段缺失 → 设置为新默认值
 *   · 字段等于旧默认值 → 更新为新默认值（确认是旧配置遗留）
 *   · 字段已是新默认值 → 跳过
 *   · 字段是其他自定义值 → 保留不动（不覆盖用户配置）
 *   · 已废弃字段 → 删除
 *
 * 覆盖范围：
 *   · <workspace>/config.json（全局）
 *     （Agent 级 config.json 不迁移：它们只存差异配置，命名空间配置继承全局默认值）
 *
 * 当前迁移项（v0.4.6 系列）：
 *   1. extension.agent_memory.memoryBudgetTokens: 600 → 10000
 *      （记忆注入预算：缓存 token 便宜，完整注入减少 Agent 频繁调工具）
 *   2. extension.agent_session.summaryPreviewLen: 1000 → 4000
 *      （摘要统一上限：上下文压缩 + 归档 SUMMARY.md 生成/注入）
 *   3. extension.agent_session.archiveTokenRatio: 0.5 → 0.7
 *      （归档触发比例：延迟归档，减少整理轮成本）
 *   4. extension.agent_session.archiveSummaryInjectLen → 移除
 *      （已合并到 summaryPreviewLen）
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---- 迁移定义 ----
// [命名空间键, 字段, 旧默认值, 新默认值]
const MIGRATIONS = [
  ['extension.agent_memory', 'memoryBudgetTokens', 600, 10000],
  ['extension.agent_session', 'summaryPreviewLen', 1000, 4000],
  ['extension.agent_session', 'archiveTokenRatio', 0.5, 0.7],
];

// 已废弃字段：[命名空间键, 字段]
const REMOVE_FIELDS = [
  ['extension.agent_session', 'archiveSummaryInjectLen'],
];

// ---- 工具 ----
function applyMigration(config, changes, dryRun) {
  for (const [ns, field, oldVal, newVal] of MIGRATIONS) {
    const nsObj = config[ns] ?? (config[ns] = {});
    const cur = nsObj[field];
    if (cur === undefined) {
      nsObj[field] = newVal;
      changes.push(`  ${ns}.${field}: (缺失) → ${newVal}`);
    } else if (cur === oldVal) {
      nsObj[field] = newVal;
      changes.push(`  ${ns}.${field}: ${oldVal} → ${newVal}`);
    } else if (cur === newVal) {
      // 已是新值，跳过
    } else {
      changes.push(`  ${ns}.${field}: ${cur}（自定义值，保留）`);
    }
  }

  for (const [ns, field] of REMOVE_FIELDS) {
    const nsObj = config[ns];
    if (nsObj && field in nsObj) {
      delete nsObj[field];
      changes.push(`  ${ns}.${field}: 已移除（合并到 summaryPreviewLen）`);
    }
  }

  // 清理空的命名空间对象
  for (const ns of [...new Set([...MIGRATIONS, ...REMOVE_FIELDS].map(([ns]) => ns))]) {
    if (config[ns] && Object.keys(config[ns]).length === 0) {
      delete config[ns];
    }
  }
}

function migrateFile(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath, 'utf-8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.log(`⚠️  ${filePath}: 解析失败（${e.message}），跳过`);
    return 0;
  }

  const changes = [];
  applyMigration(config, changes, dryRun);

  if (changes.length === 0) {
    console.log(`✅ ${filePath}: 无变更`);
    return 0;
  }

  console.log(`📝 ${filePath}:`);
  for (const c of changes) console.log(c);

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`   ✍️ 已写入`);
  }
  return changes.length;
}

// ---- 主流程 ----
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  let workspaceDir = args.find(a => !a.startsWith('--')) || path.resolve('workspace/default');

  // 允许直接传 config.json 路径
  let targetFiles = [];
  if (workspaceDir.endsWith('.json')) {
    targetFiles = [workspaceDir];
  } else {
    // 仅迁移全局 config.json（Agent 级配置继承全局命名空间默认值，无需迁移）
    const configPath = path.join(workspaceDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      console.error(`❌ 未找到配置: ${configPath}`);
      console.error('用法: node scripts/update-config.js [workspaceDir] [--dry-run]');
      process.exit(1);
    }
    targetFiles.push(configPath);
  }

  console.log(`🔄 配置迁移 ${dryRun ? '（DRY-RUN 预览，不写文件）' : ''}`);
  console.log(`   目标: ${targetFiles.length} 个 config.json（workspace: ${workspaceDir}）\n`);

  let totalChanges = 0;
  for (const f of targetFiles) {
    totalChanges += migrateFile(f, dryRun);
  }

  console.log(`\n${dryRun ? '🔍 预览' : '✅ 完成'}: 共 ${totalChanges} 处变更`);
  if (dryRun) {
    console.log('   确认无误后去掉 --dry-run 实际执行');
  }
}

main();
