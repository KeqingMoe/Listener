<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { ReviewTool } from '../../../../contracts/review';
import { duration, status, time } from '../../api/client';
import ContentViewer from './ContentViewer.vue';
import CopyId from './CopyId.vue';
import FoldBlock from './FoldBlock.vue';
import { highlightJs } from './js-highlight';
import { highlightJson } from './json-highlight';
import MessageParts from './MessageParts.vue';
import ReplyQuote from './ReplyQuote.vue';
import {
  argumentsLine,
  type LookupContext,
  resultProblem,
  structuredText,
  toolView,
} from './tool-summary';

const route = useRoute();
const props = defineProps<{
  tool: ReviewTool;
  groupId: string;
  /** 同一唤醒或请求范围内收集的名字与可引用消息。 */
  lookup?: LookupContext;
}>();
const view = computed(() =>
  toolView(
    props.tool.name,
    props.tool.arguments,
    props.tool.result,
    props.lookup,
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
const code = computed(() =>
  view.value?.kind === 'script' && view.value.code !== null
    ? highlightJs(view.value.code)
    : null,
);
const returned = computed(() => {
  const outcome = view.value?.kind === 'script' ? view.value.outcome : null;
  if (outcome?.kind !== 'value') {
    return null;
  }
  const json = structuredText(outcome.text);
  return {
    json: json !== null,
    tokens: json ? highlightJson(json) : null,
    text: outcome.text,
  };
});
const stack = ref(false);
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
      <ReplyQuote v-if="view.reply" :reply="view.reply" /><MessageParts
        :parts="view.parts"
      />
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
        ><span class="said"
          ><ReplyQuote v-if="line.reply" :reply="line.reply" /><MessageParts
            :parts="line.parts"
        /></span>
      </li>
      <li v-if="view.more" class="muted">另有 {{ view.more }} 条</li>
    </ul>
    <div v-else-if="view?.kind === 'script'" class="script">
      <p v-if="view.description || view.mode" class="summary-line">
        {{ view.description
        }}<span v-if="view.mode" class="badge script-mode">{{
          view.mode
        }}</span>
      </p>
      <FoldBlock v-if="code" :lines="12" label="代码" class="code"
        ><template v-for="(token, index) in code" :key="index"
          ><span :class="token.kind">{{ token.text }}</span></template
        ></FoldBlock
      >
      <template v-if="view.outcome">
        <template v-if="returned">
          <p class="script-label muted">
            返回值<span v-if="returned.json" class="badge">JSON</span>
          </p>
          <FoldBlock :lines="8" label="返回值" :class="{ json: returned.json }"
            ><template v-if="returned.tokens"
              ><template v-for="(token, index) in returned.tokens" :key="index"
                ><span :class="token.kind">{{ token.text }}</span></template
              ></template
            ><template v-else>{{ returned.text }}</template></FoldBlock
          >
        </template>
        <p v-else-if="view.outcome.kind === 'pending'" class="summary-line">
          已转为后台任务<code v-if="view.outcome.jobId">{{
            view.outcome.jobId
          }}</code>
        </p>
        <template v-else-if="view.outcome.kind === 'error'">
          <p class="summary-line error">{{ view.outcome.message }}</p>
          <button
            v-if="view.outcome.stack"
            type="button"
            class="raw-toggle stack-toggle"
            :aria-expanded="stack"
            @click="stack = !stack"
          >
            {{ stack ? '收起调用栈' : '调用栈' }}
          </button>
          <FoldBlock
            v-if="stack && view.outcome.stack"
            :lines="12"
            label="调用栈"
            >{{ view.outcome.stack }}</FoldBlock
          >
        </template>
        <p v-else class="summary-line muted">{{ status(view.outcome.text) }}</p>
      </template>
      <p v-if="view.calls.length" class="summary-line script-calls">
        沙箱内调用
        <span
          v-for="call in view.calls"
          :key="call.text"
          :class="{ error: call.abnormal }"
          >{{ call.text }}</span
        >
      </p>
      <template v-if="view.logs.length">
        <p class="script-label muted">日志</p>
        <FoldBlock :lines="8" label="日志">{{
          view.logs.join('\n')
        }}</FoldBlock>
      </template>
    </div>
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
.script-mode {
  margin-left: var(--space-2);
}
.script-label {
  margin: var(--space-2) 0 0;
  font-size: var(--font-small);
}
.script-label .badge {
  margin-left: var(--space-1);
}
.script-calls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  color: var(--muted);
}
.script-calls span {
  color: var(--text);
  font-family: ui-monospace, monospace;
}
.script-calls span.error {
  color: #b3343d;
}
.stack-toggle {
  margin: 0;
  padding: 0;
}
.summary-line code {
  margin-left: var(--space-2);
  font-size: var(--font-small);
}
/* 与 ContentViewer 的JSON配色一致。 */
.code :deep(.keyword) {
  color: #8a3ab9;
}
.code :deep(.string),
.json :deep(.string) {
  color: #3d6b21;
}
.code :deep(.number),
.code :deep(.literal),
.json :deep(.number),
.json :deep(.literal) {
  color: #a3531d;
}
.code :deep(.comment) {
  color: #8493a9;
  font-style: italic;
}
.json :deep(.key) {
  color: #0b6e86;
}
.json :deep(.punct) {
  color: #8493a9;
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
