<script setup lang="ts">
import type { Part } from './tool-summary';

defineProps<{ parts: readonly Part[] }>();
</script>
<template>
  <span class="parts"
    ><span v-if="!parts.length" class="muted">（无内容）</span
    ><span
      v-for="(part, index) in parts"
      :key="index"
      class="part"
      :class="part.kind"
      :title="part.title"
      >{{ part.text }}</span
    ></span
  >
</template>
<style scoped>
.parts {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 每个片段一块浅色底，相邻片段留出间隔；换行时每行都保留底色和圆角。 */
.part {
  padding: 0 4px;
  margin-right: 3px;
  border-radius: 4px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.text {
  background: rgb(38 52 73 / 5%);
}
.at {
  background: #d9eff4;
  color: #0b6e86;
}
.face {
  background: #fdf0d5;
  color: #8a5a00;
}
.media {
  background: #ebe7f6;
  color: #5b4b8a;
}
.other {
  background: #f1e3e4;
  color: #8f3a42;
}
</style>
