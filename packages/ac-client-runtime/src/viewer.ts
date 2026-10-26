// ============================================================
// ac-client-runtime/src/viewer.ts —— viewer 端点 id 单一出处
//（M29 P1-1：自 conversation/client/viewer.ts + agents/client/index.ts +
// rosterApi.ts 三副本收敛——M28 P1-4「本地常量防包环」的历史债由
// R7 相位守卫 + 白名单机制接管，身份基线回收到 runtime 基建包）
//
// M19 信封拓扑：user 只是端点之一；ref 形态对齐最大消费面
// （conversation 的 VIEWER_ID.value 旧形）。
// ============================================================
import { ref } from 'vue';

/** viewer 端点 id（恒 'user'；ref 形态维持既有消费面 .value 读取） */
export const VIEWER_ID = ref('user');
