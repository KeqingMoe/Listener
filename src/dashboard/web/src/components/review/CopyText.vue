<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { copyText } from './clipboard';

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    ariaLabel?: string;
    compact?: boolean;
  }>(),
  { label: '复制' },
);
const message = ref('');
const pending = ref(false);
const manualText = ref<string | null>(null);
const manualInput = ref<HTMLTextAreaElement | null>(null);
const copyButton = ref<HTMLButtonElement | null>(null);
let generation = 0;
watch(
  () => props.text,
  () => {
    generation++;
    pending.value = false;
    message.value = '';
    manualText.value = null;
  },
);
onBeforeUnmount(() => {
  generation++;
});

function selectText() {
  manualInput.value?.focus({ preventScroll: true });
  manualInput.value?.select();
}

function closeManual() {
  manualText.value = null;
  copyButton.value?.focus({ preventScroll: true });
}

async function copy() {
  const request = ++generation;
  const fullText = props.text;
  pending.value = true;
  message.value = '';
  manualText.value = null;
  let success = false;
  try {
    success = await copyText(fullText);
  } catch {
    /* Always offer real manual selection on failure. */
  }
  if (request !== generation) {
    return;
  }
  pending.value = false;
  if (success) {
    message.value = '已复制';
  } else {
    message.value = '自动复制失败，请手动复制下方完整文本';
    manualText.value = fullText;
    await nextTick();
    if (request === generation) {
      selectText();
    }
  }
}
</script>
<template>
  <span class="copy-text" :class="{ compact }">
    <button
      ref="copyButton"
      type="button"
      :aria-label="ariaLabel || label"
      :title="ariaLabel || label"
      :disabled="pending"
      @click="copy"
    >
      {{ pending ? '复制中…' : label }}
    </button>
    <span class="muted" role="status">{{ message }}</span>
    <span
      v-if="manualText !== null"
      class="manual-copy"
      role="group"
      aria-label="手动复制完整文本"
    >
      <span>完整文本已选中。按 Ctrl+C / ⌘C，或长按文本选择复制。</span>
      <textarea
        ref="manualInput"
        :value="manualText"
        readonly
        rows="6"
        wrap="off"
        aria-label="待手动复制的完整文本"
        spellcheck="false"
        @keydown.esc.prevent.stop="closeManual"
      />
      <span class="manual-actions"
        ><button type="button" @click="selectText">全选文本</button
        ><button type="button" @click="closeManual">关闭</button></span
      >
    </span>
  </span>
</template>
<style scoped>
.copy-text {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
  max-width: 100%;
}
.compact > button {
  font-size: var(--font-small);
  padding: var(--space-1);
}
.manual-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex-basis: 100%;
  width: 32rem;
  max-width: 100%;
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-sizing: border-box;
}
.manual-copy textarea {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  resize: vertical;
  font-family: ui-monospace, monospace;
  font-size: 16px;
  line-height: 1.5;
  user-select: text;
}
.manual-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
