// ============================================================
// ui/src/isolated-runtime.ts —— iframe isolated 档入口 shim（cr-558）
//
// 本体住 ac-client-runtime/src/isolated-runtime.ts（主线同源，M27 S4/D21）；
// 本文件只是 ui-plugin-iframe.html 引用路径（/src/isolated-runtime.ts）的
// 落点——缺它 vite build 双入口直接失败（cr-558 前 dist 一直建不出来）。
// ============================================================
import 'ac-client-runtime/src/isolated-runtime';
