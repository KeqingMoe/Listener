<script setup lang="ts">
import { computed, ref } from 'vue';
import JsonNode from './JsonNode.vue';
import CopyText from './CopyText.vue';
const props = defineProps<{ value: unknown; label?: string }>();
const query = ref(''), mode = ref<'tree' | 'text'>('tree');
const text = computed(() => {
  if (typeof props.value === 'string') return props.value;
  try { return JSON.stringify(props.value, null, 2) ?? ''; } catch { return '[内容无法序列化]'; }
});
const structured = computed(() => props.value !== null && typeof props.value === 'object');
const lines = computed(() => text.value.split('\n').map((text, index) => ({ text, index: index + 1 })).filter(line => !query.value || line.text.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
// Keep the reader's search while a resource patch updates its content.
// A real detail identity change clears data and remounts this viewer.
</script>
<template>
  <section class="content-viewer" :aria-label="label || '内容'">
    <div class="viewer-toolbar">
      <input v-model="query" type="search" :aria-label="`搜索${label || '内容'}`" placeholder="搜索内容…" />
      <button v-if="structured" type="button" @click="mode = mode === 'tree' ? 'text' : 'tree'">{{ mode === 'tree' ? '纯文本' : 'JSON 树' }}</button>
      <CopyText :text="text" label="复制全文" />
    </div>
    <div class="viewer-body" tabindex="0">
      <p v-if="value == null || text === ''" class="muted">未记录内容</p>
      <template v-else-if="query"><p class="muted">{{ lines.length }} 行匹配</p><div v-for="line in lines" :key="line.index" class="text-line"><span class="line-number">{{ line.index }}</span><pre>{{ line.text }}</pre></div></template>
      <JsonNode v-else-if="structured && mode === 'tree'" :value="value" />
      <pre v-else>{{ text }}</pre>
    </div>
  </section>
</template>
<style scoped>
.viewer-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
input { flex: 1; min-width: 8rem; }
/* The detail pane (or main page) owns vertical scrolling, never the prose. */
.viewer-body { font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
pre { min-width: 0; }
.text-line { display: flex; gap: var(--space-3); }
.line-number { color: var(--muted); min-width: 2.5rem; user-select: none; text-align: right; }
</style>
