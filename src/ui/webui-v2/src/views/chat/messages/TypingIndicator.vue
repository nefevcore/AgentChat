<!-- TypingIndicator.vue —— 打字指示 -->
<template>
  <span class="typing-indicator">
    <span class="dot" /><span class="dot" /><span class="dot" />
  </span>
</template>

<style scoped>
.typing-indicator { display: inline-flex; gap: 3px; align-items: center; }
.dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--color-text-tertiary, #a8abb2);
  animation: typing-bounce 1.2s infinite ease-in-out;
}
.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}
</style>
