// ============================================================
// node-sqlite.d.ts —— node:sqlite 最小类型垫片（cr-973，2026-11-09）
//
// 仓库 @types/node 钉在 ^20（node:sqlite 于 22.5 才进类型包），而运行时
// Node ≥ 24.18 内建该模块——此处只声明本包用到的 DatabaseSync /
// StatementSync 最小面。上游类型包升级后本垫片可删（与真实声明同形）。
// ============================================================
declare module 'node:sqlite' {
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
