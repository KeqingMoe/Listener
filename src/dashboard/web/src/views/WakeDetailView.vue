<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import WakeDetail from '../components/review/WakeDetail.vue';
const route = useRoute();
const wakeId = computed(() => String(route.params.wakeId ?? ''));
const groupId = computed(() => String(route.params.groupId ?? ''));
</script>
<template>
  <section class="panel">
    <RouterLink class="back-link" :to="{ path: '/wakes', query: { ...route.query, detailGroup: undefined, selected: wakeId, group: groupId } }">← 返回唤醒记录</RouterLink>
    <WakeDetail :wake-id="wakeId" :group-id="groupId" />
  </section>
</template>
