<script setup lang="ts">
import type { Availability } from "../../../../shared/contracts";
defineProps<{ value: Availability }>();
</script>
<template>
  <p
    v-if="!value.telemetry || value.sessions.some((s) => !s.available)"
    class="notice"
    role="status"
  >
    部分数据源暂不可用：<span v-if="!value.telemetry">模型用量库；</span
    ><span
      v-for="g in value.sessions.filter((s) => !s.available)"
      :key="g.groupId"
      >群 {{ g.groupId }} 会话库；</span
    >当前结果可能不完整，未知不代表零。
  </p>
</template>
