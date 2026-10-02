<script setup lang="ts">
import type { WebLink } from './web-tool-view';

defineProps<{ link: WebLink; text?: string }>();
</script>
<template>
  <a
    v-if="link.href"
    :href="link.href"
    target="_blank"
    rel="noopener noreferrer"
    referrerpolicy="no-referrer"
    >{{ text || link.url }}</a
  >
  <span v-else>{{ text || link.url || 'URL 未记录' }}</span>
</template>
<style scoped>
a,
span {
  overflow-wrap: anywhere;
}
</style>
