<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { EVENT_CATEGORIES, type ReviewEventsResponse } from '../../../contracts/review';
import type { Range } from '../../../contracts/contracts';
import { time } from '../api/client';
import { refreshVersion, useFilters, useResource } from '../composables/useDashboard';
import DataState from '../components/ui/DataState.vue';
import ContentViewer from '../components/review/ContentViewer.vue';
import CopyId from '../components/review/CopyId.vue';
const route = useRoute(), router = useRouter();
const { query } = useFilters();
const categories: Record<string, string> = { app: '应用', onebot: '接入', message: '消息', trigger: '触发', turn: '轮次', model: '模型', tool: '工具', image: '图片', forward: '转发', memory: '记忆', moderation: '群管理', command: '命令', send: '发送', attention: '关注', session: '会话' };
const category = computed(() => typeof route.query.category === 'string' ? route.query.category : '');
const filters = computed(() => {
  const params = new URLSearchParams(query.value);
  if (category.value) params.set('category', category.value);
  if (typeof route.query.q === 'string' && route.query.q.trim()) params.set('q', route.query.q.trim());
  return params.toString();
});
const cursors = ref<string[]>([]);
const boundRange = ref<Range | null>(null);
watch([filters, refreshVersion], () => { cursors.value = []; boundRange.value = null; }, { flush: 'sync' });
const path = computed(() => {
  const params = new URLSearchParams(filters.value);
  params.set('limit', '30');
  if (cursors.value.length) {
    params.set('cursor', cursors.value[cursors.value.length - 1]!);
    if (boundRange.value) { params.set('since', String(boundRange.value.since)); params.set('until', String(boundRange.value.until)); }
  }
  return `events?${params}`;
});
const { data, loading, error, retry } = useResource<ReviewEventsResponse>(path);
function next() {
  if (!data.value?.nextCursor || loading.value) return;
  boundRange.value = data.value.range;
  cursors.value.push(data.value.nextCursor);
}
function setCategory(event: Event) {
  router.push({ query: { ...route.query, category: (event.target as HTMLSelectElement).value || undefined, cursor: undefined, selected: undefined, detailGroup: undefined } });
}
const eventCategory = (event: string) => { const key = event.split(/[.:_]/)[0] ?? event; return categories[key] ?? key; };
const levelLabel = (level: string) => ({ trace: '跟踪', debug: '调试', info: '信息', warn: '警告', error: '错误', fatal: '严重' } as Record<string, string>)[level] ?? level;
</script>
<template>
  <section :aria-busy="loading">
    <header class="page-heading"><h1>事件</h1><span class="muted">{{ data?.items.length ?? 0 }} 条 · 第 {{ cursors.length + 1 }} 页</span></header>
    <section class="panel">
      <div class="section-title">
        <label class="category-filter">事件分类 <select :value="category" aria-label="事件分类" @change="setCategory"><option value="">全部分类</option><option v-for="key in EVENT_CATEGORIES" :key="key" :value="key">{{ categories[key] }}</option></select></label>
      </div>
      <DataState :loading="loading" :error="error" @retry="retry">
        <p v-if="!data?.items.length" class="muted">此范围没有事件</p>
        <div v-else class="table-wrap"><table class="compact-table events-table">
          <thead><tr><th>时间</th><th>分类</th><th>事件 / 详情</th><th>群组</th><th>轮次</th></tr></thead>
          <tbody><tr v-for="item in data.items" :key="item.sequence">
            <td class="event-time"><span>{{time(item.time).split(' ')[0]}}</span> <span>{{time(item.time).split(' ').slice(1).join(' ')}}</span></td>
            <td><span class="badge">{{ eventCategory(item.event) }}</span><small v-if="item.level" class="muted">{{ levelLabel(item.level) }}</small></td>
            <td class="event-detail"><details><summary :title="item.event"><strong>{{ item.title }}</strong></summary><div class="expanded-content"><code class="muted">{{item.event}}</code><div v-if="item.messageId" class="message-id"><span class="muted">消息</span><CopyId :value="item.messageId" /></div><ContentViewer :value="item.detail" label="事件详情" /></div></details></td>
            <td><CopyId v-if="item.groupId" :value="item.groupId" /><span v-else class="muted">全局</span></td>
            <td><template v-if="item.turnId"><RouterLink :to="{ path: '/requests', query: { ...route.query, q: item.turnId, group: item.groupId || undefined, selected: undefined, detailGroup: undefined, category: undefined, cursor: undefined, outcome: undefined } }">查找请求</RouterLink><div><CopyId :value="item.turnId" /></div></template><span v-else class="muted">—</span></td>
          </tr></tbody>
        </table></div>
      </DataState>
      <footer class="pagination" title="每页最多30条"><span></span><div><button type="button" :disabled="loading || !cursors.length" @click="cursors.pop()">上一页</button><button type="button" :disabled="loading || !data?.nextCursor" @click="next">下一页</button></div></footer>
    </section>
  </section>
</template>
<style scoped>
.events-table td { vertical-align: top; }
.event-detail { min-width: 18rem; max-width: 42rem; white-space: normal; }
.expanded-content { margin-top: var(--space-2); min-width: 0; }
.message-id { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
@media (max-width: 600px) {
  .event-time span { display: block; }
  .events-table th, .events-table td { padding-inline: var(--space-2); }
  .event-detail { min-width: 160px; width: 190px; max-width: 190px; }
  .event-detail summary { white-space: normal; }
}
</style>
