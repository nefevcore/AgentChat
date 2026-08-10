// ============================================================
// webui-v2 入口
// ============================================================

import './assets/main.css';
import './assets/markdown.css';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 注册所有视角（布局插槽装配）
import '@/perspectives';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount('#app');
