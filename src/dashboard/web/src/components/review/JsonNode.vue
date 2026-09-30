<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: unknown; depth?: number }>(), {
  depth: 0,
});
const structured = computed(
  () => props.value !== null && typeof props.value === 'object',
);
const entries = computed(() =>
  structured.value
    ? Object.entries(props.value as Record<string, unknown>)
    : [],
);
const scalar = computed(() => {
  try {
    return JSON.stringify(props.value) ?? String(props.value);
  } catch {
    return '[无法序列化]';
  }
});
</script>
<template>
  <details
    v-if="structured && depth < 12"
    :open="depth === 0"
    class="json-node"
  >
    <summary>
      {{ Array.isArray(value) ? '数组' : '对象' }} · {{ entries.length }}
    </summary>
    <div v-for="[key, item] in entries" :key="key" class="json-entry">
      <span class="json-key">{{ key }}:</span
      ><JsonNode :value="item" :depth="depth + 1" />
    </div>
  </details>
  <span v-else class="json-scalar">{{ scalar }}</span>
</template>
<style scoped>
.json-node {
  min-width: 0;
}
summary {
  cursor: pointer;
  color: var(--muted, #8493a9);
}
.json-entry {
  display: flex;
  align-items: baseline;
  gap: 0.65rem;
  margin: 0.35rem 0 0.35rem 1rem;
}
.json-key {
  color: var(--accent, #256a89);
  overflow-wrap: anywhere;
}
.json-scalar {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
