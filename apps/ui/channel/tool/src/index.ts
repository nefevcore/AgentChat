// ============================================================
// tool 通道模块（8.5b 第二批；ui-tree.md §2：conversation 子件）
//
// tool-card 通用渲染 + 回落兜底——无独立消费方，随 conversation 装载。
// re-export 主线 toolClientPlugin；物理迁出归 cutover。
// ============================================================
import { toolClientPlugin } from 'ac-client-ui-tool/client';

export default toolClientPlugin;
