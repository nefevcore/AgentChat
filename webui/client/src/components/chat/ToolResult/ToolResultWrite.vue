<script setup lang="ts">
import { ref } from 'vue';
import FilePreviewModal from '@/components/chat/FilePreviewModal.vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const filePath = String(props.data.path || '');
const fileName = filePath.split(/[/\\]/).pop() || filePath;
const showModal = ref(false);
</script>

<template>
  <span class="write-link" @click.stop="showModal = true" :title="filePath">
    {{ fileName }}
  </span>
  <FilePreviewModal :visible="showModal" :file-path="filePath" @close="showModal = false" />
</template>

<style scoped>
.write-link {
  font-size: 13px;
  color: var(--color-accent, #4a90d9);
  cursor: pointer;
  font-family: 'SF Mono', 'Consolas', monospace;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.write-link:hover { opacity: 0.8; }
</style>
