<script setup lang="ts">
import MessageParts from './MessageParts.vue';
import type { Reply } from './tool-summary';

defineProps<{ reply: Reply }>();
</script>
<template>
  <span class="reply-quote" :title="`消息 ${reply.messageId}`"
    ><template v-if="reply.quote"
      ><span class="quote-who">回复 {{ reply.quote.who || '?' }}：</span
      ><MessageParts :parts="reply.quote.parts" /></template
    ><span v-else class="quote-who"
      >回复消息 {{ reply.messageId }}（本地已无记录）</span
    ></span
  >
</template>
<style scoped>
.reply-quote {
  display: block;
  margin-bottom: 2px;
  padding-left: var(--space-2);
  border-left: 2px solid #9bc9d4;
  font-size: var(--font-small);
  color: var(--muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.quote-who {
  margin-right: 2px;
}
</style>
