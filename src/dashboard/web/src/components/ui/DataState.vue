<script setup lang="ts">
defineProps<{ loading: boolean; error: string; empty?: boolean; stale?: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div v-if="loading" class="state" role="status">
    <span class="spinner" aria-hidden="true"></span>正在读取运行数据…
  </div>
  <div v-if="error" class="state error" role="alert">
    <p>{{ stale ? '数据已过期，更新失败：' : '' }}{{ error }}</p>
    <button class="button" @click="$emit('retry')">重新加载</button>
  </div>
  <div v-if="!loading && !error && empty" class="state">
    <strong>暂无记录</strong>
    <p>所选群与时间范围内没有可展示的数据。</p>
  </div>
  <slot v-if="!loading && (!error || stale) && !empty" />
</template>
