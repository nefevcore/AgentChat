// ============================================================
// AgentChat WebUI 入口
// ============================================================

import './assets/main.css';
import './assets/markdown.css';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
// L0 设计令牌（星群 × 工坊 双主题）—— UI 库地基
import './ui/tokens.css';
// L0.5 公共行（A 语言扁平行——清单卡收敛底座，C8）
import './ui/row.css';
// L0.6 徽章语言（状态/标签/类型徽记三族一底——2026-10 统一裁决）
import './ui/badge.css';

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount('#app');
