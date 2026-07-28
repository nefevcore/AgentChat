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
import { Tool } from '@core/types';
import { meta } from './meta';
import { getGlobalConfig, resolveSafePath } from '@core/config';
import {
  type ReplaceEdit,
  type HashEdit,
  stripBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  applyEditsToNormalizedContent,
  applyHashBasedEdits,
  generateIncrementalDiff,
  generateDiffString,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';

// ============================================================
// 路径安全（使用共享工具，支持路径白名单）
// ============================================================

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
  hashEdits: HashEdit[];
}

/**
 * 将旧格式 { filePath, oldString, newString } 或新格式 { filePath, edits[] }
 * 转换为统一格式。同时分离 hash 编辑和 oldText 编辑。
 */
function normalizeEditArguments(input: Record<string, any>): NormalizedEditArgs {
  const args = input as LegacyEditArgs;

  const allEdits: any[] = Array.isArray(args.edits)
    ? [...args.edits]
    : [];

  // 检测旧格式：顶层 oldString / newString
  if (typeof args.oldString === 'string' || typeof args.newString === 'string') {
    if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
      throw new Error(
        '使用旧格式时 oldString 和 newString 必须同时提供且均为字符串。'
      );
    }
    allEdits.push({ oldText: args.oldString, newText: args.newString });
  }

  // 分离 hash 编辑和 oldText 编辑
  const hashEdits: HashEdit[] = [];
  const oldTextEdits: ReplaceEdit[] = [];

  for (const e of allEdits) {
    // lineHash 可能被 LLM 误传为数字，统一转为字符串
    const hashStr = e.lineHash != null ? String(e.lineHash) : '';
    const hasLineHash = hashStr.length > 0;
    const hasOldText = typeof e.oldText === 'string' && e.oldText.length > 0;

    if (hasLineHash) {
      // 兼容：同时有 lineHash 和 oldText 时，优先 lineHash，忽略 oldText
      hashEdits.push({ lineHash: hashStr, newText: e.newText ?? '' });
    } else if (hasOldText) {
      oldTextEdits.push({ oldText: e.oldText!, newText: e.newText ?? '' });
    } else {
      throw new Error(
        '每个编辑条目必须提供 lineHash 或 oldText 中的一个。'
      );
    }
  }

  if (hashEdits.length === 0 && oldTextEdits.length === 0) {
    throw new Error('至少需要提供一个编辑操作（edits[] 或 oldString/newString）。');
  }

  if (!args.filePath || typeof args.filePath !== 'string') {
    throw new Error('必须提供 filePath 参数。');
  }

  return { filePath: args.filePath, edits: oldTextEdits, hashEdits };
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
  hashEdits: HashEdit[],
  ops: EditOperations = defaultEditOperations,
): Promise<{
  diff: string;
  firstChangedLine: number | undefined;
  fuzzyMatches: number;
}> {
  const safePath = resolveSafePath(filePath);

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

    // 6. 对 hash 编辑的 newText 也归一化
    const normalizedHashEdits = hashEdits.map((e) => ({
      lineHash: e.lineHash,
      newText: normalizeToLF(e.newText),
    }));

    // 7. 对 oldText 编辑归一化
    const normalizedEdits = edits.map((e) => ({
      oldText: normalizeToLF(e.oldText),
      newText: normalizeToLF(e.newText),
    }));

    // 8a. 先执行哈希编辑（O(1) 定位）
    let { baseContent, newContent, editPositions } = normalizedHashEdits.length > 0
      ? applyHashBasedEdits(normalized, normalizedHashEdits, filePath)
      : { baseContent: normalized, newContent: normalized, editPositions: [] as import('./edit-diff').EditPosition[] };

    // 8b. 再在上一步结果上执行 oldText 编辑
    if (normalizedEdits.length > 0) {
      const { baseContent: bc2, newContent: nc2, editPositions: ep2 } = applyEditsToNormalizedContent(
        newContent,
        normalizedEdits,
        filePath,
      );
      baseContent = normalized; // 保持最终 baseContent 为原始文件
      newContent = nc2;
      editPositions = [...editPositions, ...ep2];
    }

    // 9. 生成 diff
    // 混合编辑时，oldText 的 editPositions 相对的是 hash 编辑后的中间文本，
    // 不能直接用增量 diff（baseContent 是原始文本），退回到全量 LCS diff。
    const isMixed = normalizedHashEdits.length > 0 && normalizedEdits.length > 0;
    const { diff, firstChangedLine } = isMixed
      ? generateDiffString(baseContent, newContent)
      : generateIncrementalDiff(baseContent, newContent, editPositions);

    // 10. 恢复原始行尾
    const finalContent = restoreLineEndings(newContent, lineEnding);

    // 11. 写回文件
    await ops.writeFile(safePath, finalContent);

    // 统计模糊匹配次数（仅 oldText 编辑）
    let fuzzyMatches = 0;
    for (const edit of normalizedEdits) {
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
  ...meta,

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
            description: '替换列表，每项含 lineHash+newText 或 oldText+newText。lineHash 方式更快更精准（需搭配 read(lineHash=true) 使用），务必优先使用。',
            items: {
              type: 'object',
              properties: {
                lineHash: {
                  type: 'string',
                  description: '待替换行的 SHA256 前 8 位 hex（配合 read(lineHash=true) 使用）。与 oldText 二选一，务必优先使用。支持字符串或数字。',
                },
                newText: {
                  type: 'string',
                  description: '替换后的新文本。',
                },
                oldText: {
                  type: 'string',
                  description: '要被替换的原文本，必须唯一。仅当无法使用 lineHash 时回退使用。',
                },
              },
              required: ['newText'],
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
      const { filePath, edits, hashEdits } = normalizeEditArguments(args);

      const totalEdits = edits.length + hashEdits.length;
      stream?.onChunk?.(`正在编辑: ${filePath} (${totalEdits} 处替换${hashEdits.length > 0 ? `，其中 ${hashEdits.length} 处哈希定位` : ''})...\n`);

      // 1-10. 执行完整流水线
      const { diff, firstChangedLine, fuzzyMatches } = await executeEditPipeline(
        filePath,
        edits,
        hashEdits,
      );

      // 事后验证：内容未变更则计数为 0
      const appliedCount = diff === '（无变更）' ? 0 : totalEdits;

      stream?.onChunk?.(
        `编辑完成，${appliedCount} 处替换` +
        (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') +
        `\n`
      );

      return JSON.stringify({
        status: 'success',
        data: {
          path: filePath,
          file: path.basename(filePath),
          edits_applied: appliedCount,
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
