// ============================================================
// Release 入口（保留旧 dist/src/app/index.js 路径兼容）
//
// 当前主入口已迁移到 src/boot/boot/src/bootstrap.ts；
// 本文件仅作为编译/发布入口，import 后由 bootstrap.ts 的
// isMainModule() 在作为入口执行时触发启动流程。
// ============================================================

import '../boot/boot/src/bootstrap';
