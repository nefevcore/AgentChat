// ============================================================
// edit / read 共享工具函数
// ============================================================

import * as crypto from 'crypto';

/** SHA256 前 8 位 hex，用于行定位。行末 \r 被剥离以保证跨平台一致。 */
export function hashLine(content: string): string {
  const normalized = content.replace(/\r$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}
