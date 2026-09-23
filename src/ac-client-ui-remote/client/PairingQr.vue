<!-- ============================================================ -->
<!-- PairingQr.vue —— 配对二维码区（P1：URI 可复制 + 点阵视觉占位）
<!--     真正的扫码方是 M3 安卓 App；浏览器侧交付降级通道。
<!--     样式对齐 tokens.css（--line/--text-*/--r-*）。 -->
<!-- ============================================================ -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { Button } from '@agentchat/webui-kit';

const props = defineProps<{ uri: string }>();
const copied = ref(false);

// URI → 稳定散列点阵（视觉占位——非可扫二维码；M3 换真 QR 库）
const cells = computed(() => {
  const grid: boolean[][] = [];
  let h = 2166136261;
  for (let i = 0; i < props.uri.length; i++) {
    h ^= props.uri.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let y = 0; y < 21; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < 21; x++) {
      const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      if (corner) {
        const cx = x > 13 ? 17 : 3;
        const cy = y > 13 ? 17 : 3;
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);
        row.push(dx <= 1 && dy <= 1 ? true : (dx === 2 || dx === 3) && (dy === 2 || dy === 3));
      } else {
        h = Math.imul(h ^ (x * 31 + y * 97), 2654435761);
        row.push(((h >>> 13) & 3) === 0);
      }
    }
    grid.push(row);
  }
  return grid;
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
      <div class="qr-grid">
        <div v-for="(row, y) in cells" :key="y" class="qr-row">
          <div v-for="(c, x) in row" :key="x" class="cell" :class="{ on: c }"></div>
        </div>
      </div>
    </div>
    <div class="uri-box">
      <code class="uri">{{ uri }}</code>
      <Button variant="soft" size="sm" @click="copyUri">{{ copied ? '已复制' : '复制 URI' }}</Button>
    </div>
  </div>
</template>

<style scoped>
.qr-area { display: flex; flex-direction: column; gap: var(--space-2); align-items: center; padding: var(--space-2) 0; }
/* 白底点阵是二维码的物理形态（扫码目标），不随主题反转 */
.qr-frame { background: #fff; border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-2); box-shadow: var(--shadow-pop); }
.qr-grid { display: flex; flex-direction: column; }
.qr-row { display: flex; }
.cell { width: 6px; height: 6px; }
.cell.on { background: #111; }
.uri-box { display: flex; gap: var(--space-2); align-items: center; width: 100%; }
.uri { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 10px; word-break: break-all; color: var(--text-3); max-height: 2.8em; overflow: hidden; line-height: 1.4; }
</style>