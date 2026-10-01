<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type {
  JavascriptJobLink,
  JavascriptJobLinksResponse,
} from '../../../../contracts/javascript-jobs';
import { status, time } from '../../api/client';
import { useFilters, useResource } from '../../composables/useDashboard';
import DataState from '../ui/DataState.vue';
import CopyId from './CopyId.vue';
import { jobLinkLimitations } from './job-link-limitations';

const props = defineProps<{
  groupId: string;
  jobId: string;
  anchorOrdinal?: number;
}>();
const route = useRoute();
const open = ref(false);
watch(
  () => JSON.stringify([props.groupId, props.jobId, props.anchorOrdinal]),
  () => {
    open.value = false;
  },
  { flush: 'sync' },
);
const anchor = computed(() =>
  props.anchorOrdinal != null &&
  Number.isSafeInteger(props.anchorOrdinal) &&
  props.anchorOrdinal > 0
    ? props.anchorOrdinal
    : null,
);
const filters = useFilters();
const path = computed(() => {
  const query = new URLSearchParams(filters.query.value);
  query.set('groupId', props.groupId);
  if (anchor.value !== null) {
    query.set('anchorOrdinal', String(anchor.value));
  }
  return `javascript-jobs/${encodeURIComponent(props.jobId)}/links?${query}`;
});
const { data, loading, refreshing, error, retry } =
  useResource<JavascriptJobLinksResponse>(path, path, open);
const limitations = computed(() =>
  jobLinkLimitations(data.value?.limitations, data.value?.truncated ?? false),
);
const kinds: Record<JavascriptJobLink['kind'], string> = {
  execution: '脚本调用',
  query: '查询调用',
  cancellation: '取消调用',
  notification_received: '结果已进入通知收件箱',
  notification_projected: '结果已写入模型上下文',
};

const jobStatus = (value: string) =>
  value === 'queued' ? '排队中' : status(value);

function resultLabel(item: JavascriptJobLink): string {
  if (
    item.kind === 'notification_received' ||
    item.kind === 'notification_projected'
  ) {
    return item.taskStatus
      ? `记录中的任务状态：${jobStatus(item.taskStatus)}`
      : '未取得可识别的任务状态';
  }
  if (item.state === 'unknown') {
    return '调用结果未知';
  }
  if (item.state === 'pending') {
    return '尚未执行';
  }
  if (item.state === 'started') {
    return '调用进行中，尚未确认完成';
  }
  if (item.state === 'skipped') {
    return '调用已跳过';
  }
  if (item.status === 'pending' && item.kind === 'execution') {
    return '已返回后台句柄，不代表任务已完成';
  }
  if (item.status === 'unknown') {
    return '调用结果未知';
  }
  if (item.status === 'error') {
    return '调用返回错误';
  }
  if (item.taskStatus) {
    return `返回记录中的任务状态：${jobStatus(item.taskStatus)}`;
  }
  if (item.status === 'ok') {
    return '调用返回成功，未记录任务终态';
  }
  return item.status
    ? `调用返回状态：${status(item.status)}`
    : '调用结果未记录';
}

function target(path: string, selected: string) {
  return {
    path,
    query: {
      ...route.query,
      group: props.groupId,
      detailGroup: undefined,
      selected,
      outcome: undefined,
      q: undefined,
      model: undefined,
    },
  };
}
</script>
<template>
  <section
    class="javascript-job-links"
    :aria-label="`任务 ${jobId} 的关联记录`"
  >
    <div class="job-links-heading">
      <CopyId :value="jobId" />
      <button type="button" :aria-expanded="open" @click="open = !open">
        {{ open ? '收起关联记录' : '查看关联记录' }}
      </button>
    </div>
    <div v-if="open" class="job-links-body">
      <p class="muted">
        <span v-if="anchor !== null"
          >当前调用单独按账本核对，不受时间筛选限制；</span
        >其他关联按页面时间范围检索，不代表任务实时状态。通知进入模型上下文不代表模型已读取或已向群发送消息。
      </p>
      <p class="muted">
        检索有界：每类优先检查最近 2000 条相关日志、最近 500
        条通知收件记录；日志命中时另核对对应收件记录。
      </p>
      <button type="button" :disabled="loading || refreshing" @click="retry">
        重新检索此范围
      </button>
      <DataState
        :loading="loading"
        :error="error"
        :stale="!!data"
        @retry="retry"
      >
        <template v-if="data">
          <p class="muted">
            {{ time(data.range.since) }} — {{ time(data.range.until) }}
          </p>
          <p v-if="data.unavailable" class="job-links-warning">
            关联数据源或检索索引不可用，无法确认完整关联。
          </p>
          <p v-for="note in limitations" :key="note" class="job-links-warning">
            {{ note }}
          </p>
          <p v-if="!data.items.length" class="muted">
            此范围内未找到可用关联记录。可以调整顶部时间范围；这不代表任务不存在或结果尚未通知。
          </p>
          <ol v-else class="job-link-items">
            <li v-for="item in data.items" :key="item.key">
              <div class="job-link-title">
                <strong>{{ kinds[item.kind] }}</strong
                ><span v-if="item.anchor" class="badge"
                  >当前调用（直接核对）</span
                ><time class="muted">{{ time(item.time) }}</time>
              </div>
              <p>{{ resultLabel(item) }}</p>
              <div class="job-link-navigation">
                <span v-if="item.ordinal != null" class="muted"
                  >调用 #{{ item.ordinal }}</span
                >
                <RouterLink
                  v-if="item.requestId"
                  :to="target('/requests', item.requestId)"
                  >查看模型请求</RouterLink
                >
                <RouterLink
                  v-if="item.wakeId"
                  :to="target('/wakes', item.wakeId)"
                  >查看唤醒</RouterLink
                >
                <span v-if="!item.requestId && !item.wakeId" class="muted">{{
                  item.kind === 'notification_received'
                    ? '收件阶段没有专属模型请求；写入上下文的记录可关联唤醒。'
                    : '没有可用的请求或唤醒跳转证据'
                }}</span>
              </div>
            </li>
          </ol>
        </template>
      </DataState>
    </div>
  </section>
</template>
<style scoped>
.javascript-job-links {
  margin-top: var(--space-2);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.job-links-heading,
.job-link-title,
.job-link-navigation {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}
.job-links-heading :deep(.copy-id) {
  max-width: 100%;
}
button {
  font-size: 12px;
  min-height: 0;
  padding: var(--space-1) var(--space-2);
}
.job-links-body {
  border-left: 2px solid var(--border);
  margin-top: var(--space-1);
  padding-left: var(--space-2);
}
p {
  margin: var(--space-1) 0;
}
.job-links-warning {
  color: #946018;
}
.job-link-items {
  padding-left: 1.5em;
}
.job-link-items li + li {
  margin-top: var(--space-2);
}
</style>
