// ============================================================
// perspectives/index.ts —— 视角装配入口
//
// 所有视角在此注册进布局插槽。新增视角只需：
//   1. 新建一个 registerXxxPerspective() 模块
//   2. 在此 import 一行
// AppShell / 活动栏 / 弹窗层全部自动适配。
// ============================================================

import '@/perspectives/chat';
import '@/perspectives/workspace';
import '@/perspectives/settings';
