<script setup lang="ts">
import { computed, ref } from 'vue';
import CopyText from './CopyText.vue';
import { highlightJson } from './json-highlight';

const props = defineProps<{ value: unknown; label?: string }>();
const query = ref('');
/** 复制与搜索使用的原文：字符串原样，结构化值为标准缩进JSON。 */
const text = computed(() => {
  if (typeof props.value === 'string') {
    return props.value;
  }
  try {
    return JSON.stringify(props.value, null, 2) ?? '';
  } catch {
    return '[内容无法序列化]';
  }
});
const structured = computed(
  () => props.value !== null && typeof props.value === 'object',
);
/** 结构化值的高亮行；多行字符串展开为真实换行，便于阅读。 */
const highlighted = computed(() =>
  structured.value ? highlightJson(props.value) : [],
);
const lines = computed(() =>
  text.value
    .split('\n')
    .map((text, index) => ({ text, index: index + 1 }))
    .filter(
      (line) =>
        !query.value ||
        line.text.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()),
    ),
);
// 资源patch更新内容时保留搜索词；详情对象真正切换时会清空数据并重新挂载本组件。
</script>
<template>
  <section class="content-viewer" :aria-label="label || '内容'">
    <div class="viewer-toolbar">
      <input
        v-model="query"
        type="search"
        :aria-label="`搜索${label || '内容'}`"
        placeholder="搜索内容…"
      />
      <CopyText :text="text" label="复制全文" />
    </div>
    <div class="viewer-body" tabindex="0">
      <p v-if="value == null || text === ''" class="muted">未记录内容</p>
      <template v-else-if="query"
        ><p class="muted">{{ lines.length }} 行匹配</p>
        <div v-for="line in lines" :key="line.index" class="text-line">
          <span class="line-number">{{ line.index }}</span>
          <pre>{{ line.text }}</pre>
        </div></template
      >
      <pre
        v-else-if="structured"
        class="json"
      ><template v-for="(token, index) in highlighted" :key="index"><span :class="token.kind">{{ token.text }}</span></template></pre>
      <pre v-else>{{ text }}</pre>
    </div>
  </section>
</template>
<style scoped>
.viewer-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
input {
  flex: 1;
  min-width: 8rem;
}
/* 纵向滚动由详情面板或主页面负责，正文本身不滚动。 */
.viewer-body {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
}
pre {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.json .key {
  color: #0b6e86;
}
.json .string {
  color: #3d6b21;
}
.json .text {
  color: #263449;
}
.json .number,
.json .literal {
  color: #a3531d;
}
.json .punct {
  color: #8493a9;
}
.text-line {
  display: flex;
  gap: var(--space-3);
}
.line-number {
  color: var(--muted);
  min-width: 2.5rem;
  user-select: none;
  text-align: right;
}
</style>
