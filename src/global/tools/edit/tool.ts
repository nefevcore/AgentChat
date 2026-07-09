// ============================================================
// edit 工具 —— 精确字符串替换编辑
//
// 设计原则（参考 pi 的 edit 设计）：
//   1. 精确替换而非全文重写 —— LLM 必须准确引用原文
//   2. BOM 剥离 + 行尾归一化 + 恢复 —— 跨平台透明
//   3. 模糊匹配兜底 —— 消除 smart quotes、特殊空格等微小差异
//   4. 多 edit 批量替换 —— 一次调用修改多处
//   5. 唯一性 + 重叠检测 —— 防止意外修改
//   6. 反向替换 —— 保持偏移量不变
//   7. Diff 输出 —— 让 LLM 看到变更
//   8. 文件写入队列 —— 并发安全
//   9. Legacy API 兼容 —— oldString/newString → edits[]
// ============================================================

import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';
import {
  type ReplaceEdit,
  stripBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  applyEditsToNormalizedContent,
  generateDiffString,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';

// ============================================================
// 路径安全
// ============================================================

function safeResolve(filePath: string): string {
  const sandbox = path.resolve(getGlobalConfig().workspaceDir);
  const resolved = path.resolve(sandbox, filePath);

  if (!resolved.startsWith(sandbox + path.sep) && resolved !== sandbox) {
    throw new Error(
      `路径穿越被拒绝："${filePath}" 解析到了工作区 "${sandbox}" 之外`
    );
  }
  return resolved;
}

// ============================================================
// 可插拔 I/O 接口（便于测试和远程编辑场景）
// ============================================================

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (p) => fs.readFile(p),
  writeFile: (p, content) => fs.writeFile(p, content, 'utf-8'),
  access: (p) => fs.access(p, constants.R_OK | constants.W_OK),
};

// ============================================================
// Legacy API 兼容：oldString/newString → edits[]
// ============================================================

interface LegacyEditArgs {
  filePath?: string;
  oldString?: string;
  newString?: string;
  edits?: ReplaceEdit[];
  [key: string]: unknown;
}

interface NormalizedEditArgs {
  filePath: string;
  edits: ReplaceEdit[];
}

/**
 * 将旧格式 { filePath, oldString, newString } 转换为
 * 新格式 { filePath, edits: [{ oldText, newText }] }。
 * 也支持混合格式（同时传 edits[] 和顶层 oldString/newString 时合并）。
 */
function normalizeEditArguments(input: Record<string, any>): NormalizedEditArgs {
  const args = input as LegacyEditArgs;

  const edits: ReplaceEdit[] = Array.isArray(args.edits)
    ? [...args.edits]
    : [];

  // 检测旧格式：顶层 oldString / newString
  if (typeof args.oldString === 'string' || typeof args.newString === 'string') {
    if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
      throw new Error(
        '使用旧格式时 oldString 和 newString 必须同时提供且均为字符串。'
      );
    }
    edits.push({ oldText: args.oldString, newText: args.newString });
  }

  if (edits.length === 0) {
    throw new Error('至少需要提供一个编辑操作（edits[] 或 oldString/newString）。');
  }

  if (!args.filePath || typeof args.filePath !== 'string') {
    throw new Error('必须提供 filePath 参数。');
  }

  return { filePath: args.filePath, edits };
}

// ============================================================
// 主执行流水线
// ============================================================

/**
 * edit 工具的完整执行流水线：
 *   1. resolveToCwd     —— 路径解析
 *   2. readFile         —— 读取原始内容
 *   3. stripBom         —— 去除 BOM
 *   4. detectLineEnding —— 检测行尾风格
 *   5. normalizeToLF    —— 统一为 LF
 *   6. applyEditsToNormalizedContent —— 执行精确替换
 *   7. generateDiffString —— 生成 diff 输出
 *   8. restoreLineEndings —— 恢复原始行尾
 *   9. writeFile        —— 写回文件
 */
async function executeEditPipeline(
  filePath: string,
  edits: ReplaceEdit[],
  ops: EditOperations = defaultEditOperations,
): Promise<{
  diff: string;
  firstChangedLine: number | undefined;
  fuzzyMatches: number;
}> {
  const safePath = safeResolve(filePath);

  return withFileMutationQueue(safePath, async () => {
    // 1. 检查文件存在且可读写
    await ops.access(safePath);

    // 2. 读取原始内容
    const buffer = await ops.readFile(safePath);
    let content = buffer.toString('utf-8');

    // 3. 剥离 BOM
    content = stripBom(content);

    // 4. 检测行尾风格
    const lineEnding = detectLineEnding(content);

    // 5. 归一化为 LF
    const normalized = normalizeToLF(content);

    // 6. 对每个 edit 的 oldText/newText 也归一化为 LF
    const normalizedEdits = edits.map((e) => ({
      oldText: normalizeToLF(e.oldText),
      newText: normalizeToLF(e.newText),
    }));

    // 7. 执行精确替换
    const { baseContent, newContent } = applyEditsToNormalizedContent(
      normalized,
      normalizedEdits,
      filePath,
    );

    // 8. 生成 diff
    const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);

    // 9. 恢复原始行尾
    const finalContent = restoreLineEndings(newContent, lineEnding);

    // 10. 写回文件
    await ops.writeFile(safePath, finalContent);

    // 统计模糊匹配次数
    let fuzzyMatches = 0;
    for (const edit of normalizedEdits) {
      // 在 baseContent 中如果不包含精确匹配的 edit.oldText，则说明使用了模糊匹配
      if (!baseContent.includes(edit.oldText)) {
        fuzzyMatches++;
      }
    }

    return { diff, firstChangedLine, fuzzyMatches };
  });
}

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  displayName: '编辑',
  description: '精确替换文件中的文本。',

  extractLabel: (args) => {
    const filePath = args.filePath || '';
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const count = edits.length > 0
      ? edits.length
      : (args.oldString ? 1 : 0);
    const summary = count > 0 ? `${count} 处替换` : '编辑';
    return filePath ? `${filePath} (${summary})` : summary;
  },

  definition: {
    type: 'function',
    function: {
      name: 'edit',
      description: '精确替换文件中的文本。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径。',
          },
          edits: {
            type: 'array',
            description: '替换列表，每项含 oldText 和 newText。',
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description: '要被替换的原文本，必须唯一。',
                },
                newText: {
                  type: 'string',
                  description: '替换后的新文本。',
                },
              },
              required: ['oldText', 'newText'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ['filePath', 'edits'],
      },
    },
  },

  async execute(args: Record<string, any>, stream): Promise<string> {
    try {
      // 0. 参数归一化（Legacy API 兼容）
      const { filePath, edits } = normalizeEditArguments(args);

      stream?.onChunk?.(`正在编辑: ${filePath} (${edits.length} 处替换)...\n`);

      // 1-10. 执行完整流水线
      const { diff, firstChangedLine, fuzzyMatches } = await executeEditPipeline(
        filePath,
        edits,
      );

      stream?.onChunk?.(
        `编辑完成，${edits.length} 处替换` +
        (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') +
        `\n`
      );

      return JSON.stringify({
        status: 'success',
        data: {
          path: filePath,
          edits_applied: edits.length,
          fuzzy_matches: fuzzyMatches,
          first_changed_line: firstChangedLine,
          diff,
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: {
          path: args.filePath || '',
          message: err.message,
        },
      });
    }
  },
};
