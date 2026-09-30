<script setup lang="ts">
import { computed } from 'vue';
import CopyText from './CopyText.vue';

const props = defineProps<{ value: string }>();
const short = computed(() =>
  props.value.length > 22
    ? `${props.value.slice(0, 12)}…${props.value.slice(-6)}`
    : props.value,
);
</script>
<template>
  <span class="copy-id"
    ><code :title="value">{{ short }}</code
    ><CopyText :text="value" :aria-label="`复制完整标识 ${value}`" compact
  /></span>
</template>
<style scoped>
.copy-id {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
  max-width: 100%;
  min-width: 0;
}
code {
  overflow-wrap: anywhere;
}
</style>
