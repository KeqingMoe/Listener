<script setup lang="ts">
// e150e89 ToolDetails.vue 的原始列表；仅移除外层分支条件并调整缩进。
import type { ToolView } from '../../../src/dashboard/web/src/components/review/tool-summary';
import MessageParts from '../../../src/dashboard/web/src/components/review/MessageParts.vue';
import ReplyQuote from '../../../src/dashboard/web/src/components/review/ReplyQuote.vue';

defineProps<{ view: Extract<ToolView, { kind: 'messages' }> }>();
</script>
<template>
  <ul class="chat-lines">
    <li v-if="!view.lines.length" class="muted">没有消息</li>
    <li
      v-for="(line, index) in view.lines"
      :key="index"
      :class="{ bot: line.bot, recalled: line.recalled }"
    >
      <span class="who" :title="line.userId"
        >{{ line.who || '?'
        }}<small v-if="line.userId && line.who !== line.userId">
          ({{ line.userId }})</small
        ></span
      ><span class="said"
        ><ReplyQuote v-if="line.reply" :reply="line.reply" /><MessageParts
          :parts="line.parts"
      /></span>
    </li>
    <li v-if="view.more" class="muted">另有 {{ view.more }} 条</li>
  </ul>
</template>
<style scoped>
.chat-lines {
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: var(--space-1) var(--space-2);
  border-left: 2px solid var(--border);
  font-size: 12px;
}
.chat-lines li {
  display: flex;
  gap: var(--space-2);
  padding: 2px 0;
}
.who small {
  font-size: var(--font-small);
  opacity: 0.75;
}
.who {
  flex: 0 0 auto;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.said {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bot .who {
  color: var(--accent);
}
.recalled .said {
  text-decoration: line-through;
  color: var(--muted);
}
</style>
