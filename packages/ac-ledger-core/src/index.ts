// ============================================================
// index.ts —— ac-ledger-core 出口面（cr-1245 B1）
//
// 账本域协议纯库：文法（行协议 + 事件词汇归一化）→ 解释（DomainFacts/
// SessionFold）→ 投影谓词（shadow/摘要/步/回放）——解释权单源。
// fs 读面（readDomainFacts/readLedger）与 writer 服务面留 ac-ledger。
// ============================================================

export const name = 'ac-ledger-core';

export * from './records.ts';
export * from './events-core.ts';
export * from './fold-core.ts';
export * from './doctor.ts';
