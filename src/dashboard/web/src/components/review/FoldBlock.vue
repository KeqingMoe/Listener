<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/** 等宽文本块：超过 lines 行时折叠并渐隐，可手动展开。按实际渲染高度判断，包含自动换行。 */
const props = defineProps<{ lines: number; label: string }>();
const body = ref<HTMLElement | null>(null);
const open = ref(false);
const overflow = ref(false);
let observer: ResizeObserver | null = null;

function measure() {
  const el = body.value;
  if (el && !open.value) {
    overflow.value = el.scrollHeight > el.clientHeight + 1;
  }
}

onMounted(() => {
  measure();
  if (body.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(body.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div class="fold" :class="{ folded: overflow && !open }">
    <pre
      ref="body"
      :aria-label="props.label"
      :style="open ? undefined : { maxHeight: `${props.lines * 1.6}em` }"
    ><slot /></pre>
    <button
      v-if="overflow || open"
      type="button"
      class="fold-toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      {{ open ? '收起' : '展开全部' }}
    </button>
  </div>
</template>
<style scoped>
.fold {
  position: relative;
  margin-top: var(--space-1);
  border-radius: 6px;
  background: var(--surface-subtle);
}
pre {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: hidden;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.folded pre {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 3em), transparent);
}
.fold-toggle {
  display: block;
  min-height: 0;
  padding: 0 var(--space-3) var(--space-1);
  border: 0;
  background: none;
  font-size: var(--font-small);
  color: var(--accent);
}
.fold-toggle:hover {
  background: none;
  text-decoration: underline;
}
</style>
