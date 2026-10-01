<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { ReviewTool } from '../../../../contracts/review';
import { duration, status, time } from '../../api/client';
import ContentViewer from './ContentViewer.vue';
import CopyId from './CopyId.vue';
import MessageParts from './MessageParts.vue';
import {
  argumentsLine,
  type Names,
  resultProblem,
  toolView,
} from './tool-summary';

const route = useRoute();
const props = defineProps<{
  tool: ReviewTool;
  groupId: string;
  /** 同一唤醒或请求范围内收集的QQ号到显示名。 */
  names?: Names;
}>();
const view = computed(() =>
  toolView(
    props.tool.name,
    props.tool.arguments,
    props.tool.result,
    props.names,
  ),
);
const problem = computed(() => resultProblem(props.tool.result));
const argsLine = computed(() => argumentsLine(props.tool.arguments));
const failed = computed(() =>
  ['failed', 'error', 'rejected', 'unknown', 'cancelled'].includes(
    props.tool.outcome,
  ),
);
const raw = ref(false);
</script>
<template>
  <article class="tool-detail" :class="{ failed }">
    <header class="tool-heading">
      <strong>{{ tool.name }}</strong
      ><span class="badge">{{ status(tool.outcome) }}</span
      ><span class="muted">{{ duration(tool.durationMs) }}</span>
      <button
        type="button"
        class="raw-toggle"
        :aria-expanded="raw"
        @click="raw = !raw"
      >
        {{ raw ? '收起原始数据' : '原始数据' }}
      </button>
    </header>
    <p v-if="problem || tool.reasonCode" class="error">
      {{ problem || status(tool.reasonCode) }}
    </p>
    <div v-if="view?.kind === 'send'" class="bubble">
      <span v-if="view.replyTo" class="muted reply"
        >回复 {{ view.replyTo }}</span
      ><MessageParts :parts="view.parts" />
    </div>
    <ul v-else-if="view?.kind === 'messages'" class="chat-lines">
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
        ><MessageParts class="said" :parts="line.parts" />
      </li>
      <li v-if="view.more" class="muted">另有 {{ view.more }} 条</li>
    </ul>
    <p v-else-if="view?.kind === 'line'" class="summary-line">
      {{ view.text }}
    </p>
    <p v-else-if="argsLine" class="summary-line muted">{{ argsLine }}</p>
    <div v-if="raw" class="raw">
      <ContentViewer :value="tool.arguments" label="工具参数" />
      <ContentViewer :value="tool.result" label="工具结果" />
      <div class="tool-facts">
        <span
          >{{ status(tool.state)
          }}<template v-if="tool.status && tool.status !== tool.state">
            · {{ status(tool.status) }}</template
          ></span
        ><span>#{{ tool.ordinal }}</span
        ><span v-if="tool.proposedAt != null"
          >提出 {{ time(tool.proposedAt) }}</span
        ><span v-if="tool.startedAt != null"
          >开始 {{ time(tool.startedAt) }}</span
        ><span v-if="tool.finishedAt != null"
          >结束 {{ time(tool.finishedAt) }}</span
        ><CopyId v-if="tool.callId" :value="tool.callId" /><RouterLink
          v-if="tool.requestId"
          :to="{
            path: '/requests',
            query: {
              ...route.query,
              outcome:
                route.path === '/requests' ? route.query.outcome : undefined,
              detailGroup: undefined,
              selected: tool.requestId,
              group: groupId,
            },
          }"
          >查看请求</RouterLink
        >
      </div>
    </div>
  </article>
</template>
<style scoped>
.tool-detail {
  padding: var(--space-1) 0 var(--space-2);
}
.tool-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
}
.raw-toggle {
  margin-left: auto;
  min-height: 0;
  padding: 0 var(--space-2);
  font-size: var(--font-small);
  color: var(--muted);
  background: none;
  border: none;
}
.raw-toggle:hover,
.raw-toggle[aria-expanded='true'] {
  color: var(--accent);
}
.error {
  margin: var(--space-1) 0;
}
.bubble {
  margin-top: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: 10px;
  background: #e3f3f6;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 36rem;
}
.reply {
  display: block;
  font-size: var(--font-small);
}
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
.summary-line {
  margin: var(--space-1) 0 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.raw {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2);
  border-radius: 6px;
  background: var(--surface-subtle);
}
.tool-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  font-size: var(--font-small);
  color: var(--muted);
}
</style>
