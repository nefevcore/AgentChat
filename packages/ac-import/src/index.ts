// ============================================================
// ac-import —— cutover 恒等门导入脚本（M8.7；R-10 代码化）
//
// 旧格式知识圈禁地（R-10）：pairKey 构造 / 段行形态 / marker 形态 /
// 三文件布局 / baked 词——只活在 legacy.ts，新系统运行时零引用。
// cutover 切换后本包随旧主线归档封存（不做运行时依赖）。
// ============================================================

export const name = 'ac-import';

export * from './legacy.ts';
export * from './project.ts';
export * from './verify.ts';
export * from './writer.ts';
export * from './agents-tree.ts';
export * from './user-projection.ts';
