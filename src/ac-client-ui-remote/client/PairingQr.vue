<!-- ============================================================ -->
<!-- PairingQr.vue —— 配对二维码区（cr-43 ④：真 QR 码）
<!--     qrcode（npm）canvas 渲染；扫码方 = 安卓 App 自带扫码（ScanActivity）
<!--     或系统相机 + agentchat://pair 深链。URI 复制保留为降级通道。
<!--     样式对齐 tokens.css（--line/--text-*/--r-*）。 -->
<!-- ============================================================ -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button } from '@agentchat/webui-kit';
import QRCode from 'qrcode';

const props = defineProps<{ uri: string }>();
const copied = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);

onMounted(async () => {
  const el = canvasRef.value;
  if (!el) return;
  await QRCode.toCanvas(el, props.uri, {
    width: 220,
    margin: 2, // 静区（模块数）——扫屏幕码对小静区敏感，2 模块保扫率
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
});

async function copyUri() {
  try {
    await navigator.clipboard.writeText(props.uri);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch { /* 剪贴板不可用 */ }
}
</script>

<template>
  <div class="qr-area">
    <div class="qr-frame">
      <canvas ref="canvasRef" width="220" height="220"></canvas>
    </div>
    <div class="uri-box">
      <code class="uri">{{ uri }}</code>
      <Button variant="soft" size="sm" @click="copyUri">{{ copied ? '已复制' : '复制 URI' }}</Button>
    </div>
  </div>
</template>

<style scoped>
.qr-area { display: flex; flex-direction: column; gap: var(--space-2); align-items: center; padding: var(--space-2) 0; }
/* 白底黑点是二维码的物理形态（扫码目标），不随主题反转 */
.qr-frame { background: #fff; border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-2); box-shadow: var(--shadow-pop); }
.qr-frame canvas { display: block; }
.uri-box { display: flex; gap: var(--space-2); align-items: center; width: 100%; }
.uri { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 10px; word-break: break-all; color: var(--text-3); max-height: 2.8em; overflow: hidden; line-height: 1.4; }
</style>