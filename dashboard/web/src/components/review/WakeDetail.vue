<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
import type { WakeReviewDetail } from '../../../../shared/review';
import { duration, number, status, time } from '../../api/client';
import { useResource } from '../../composables/useDashboard';
import DataState from '../ui/DataState.vue';
import PerformanceFacts from '../ui/PerformanceFacts.vue';
import ContentViewer from './ContentViewer.vue';
import CopyId from './CopyId.vue';
import ToolDetails from './ToolDetails.vue';
const props = defineProps<{ wakeId: string; groupId: string }>();
const { data, loading, error, retry } = useResource<WakeReviewDetail>(computed(() => `wakes/${encodeURIComponent(props.wakeId)}/review?groupId=${encodeURIComponent(props.groupId)}`));
const tab = ref('process');
const tabs = [{ id: 'process', label: '执行过程' }, { id: 'conversation', label: '对话' }, { id: 'requests', label: '模型请求' }, { id: 'events', label: '事件' }];
watch(() => [props.wakeId, props.groupId], () => { tab.value = 'process'; });
const count = (value: number | null) => value == null ? '—' : number(value);
const hasFailure = (outcome: string) => ['failed', 'error', 'timeout', 'cancelled'].includes(outcome);
const tps = (request: { tps: number | null }) => request.tps;
const roleLabel = (role: string) => ({ user: '用户', assistant: '助手', system: '系统', tool: '工具', developer: '开发者' } as Record<string, string>)[role] ?? role;
const eventLabel = (kind: string) => ({ wake_begin: '唤醒开始', wake_terminal: '唤醒终止', wake_finish: '唤醒结束', wake_recovered: '唤醒恢复', session_reset: '会话重置', input_checkpoint: '输入检查点', assistant_checkpoint: '助手检查点', tool_intent: '工具执行意图', tool_result: '工具结果', transport_checkpoint: '传输检查点', model_request: '模型请求', unknown: '未知事件' } as Record<string, string>)[kind] ?? kind;
const timeline = computed(() => data.value ? [
  ...data.value.requests.map((request, index) => ({ key: `r-${index}`, at: request.startedAt, request, tool: null })),
  ...data.value.tools.map((tool, index) => ({ key: `t-${index}`, at: tool.proposedAt ?? tool.startedAt, request: null, tool })),
].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.key.localeCompare(b.key)) : []);
</script>
<template>
  <section class="wake-detail" :aria-busy="loading"><DataState :loading="loading" :error="error" @retry="retry"><template v-if="data">
    <header class="detail-heading"><div><h2>唤醒详情</h2><CopyId :value="data.wake.wakeId" /></div><span class="badge">{{ data.wake.finishedAt == null ? '执行中' : status(data.wake.outcome) }}</span></header>
    <div class="request-tokens" title="未缓存输入 / 命中缓存 / 输出（含推理）；未记录显示 —"><span>输入 <b>{{ number(data.wake.uncachedInputTokens) }}</b></span><span>缓存 <b>{{ number(data.wake.cachedInputTokens) }}</b></span><span>输出 <b>{{ number(data.wake.outputTokens) }}</b></span></div>
    <PerformanceFacts :performance="data.wake.performance" :cache="data.wake" />
    <div class="request-context muted"><span>群 {{data.wake.groupId}}</span><time>{{time(data.wake.startedAt)}}</time><span>请求 {{number(data.wake.modelRequests)}} · 工具 {{number(data.wake.toolCalls)}}</span></div>
    <details class="identifiers"><summary>唤醒记录</summary><dl class="metadata">
      <div><dt>群组</dt><dd><CopyId :value="data.wake.groupId" /></dd></div>
      <div><dt>会话</dt><dd><CopyId :value="data.wake.sessionId" /></dd></div>
      <div><dt>开始时间</dt><dd>{{ time(data.wake.startedAt) }}</dd></div>
      <div v-if="data.wake.finishedAt != null"><dt>结束时间</dt><dd>{{ time(data.wake.finishedAt) }}</dd></div>
      <div><dt>总耗时</dt><dd>{{ duration(data.wake.durationMs) }}</dd></div>
      <div><dt>请求 / 工具</dt><dd>{{ number(data.wake.modelRequests) }} / {{ number(data.wake.toolCalls) }}</dd></div>
      <div v-if="data.wake.reasonCode"><dt>结束原因</dt><dd>{{ status(data.wake.reasonCode) }}</dd></div>
    </dl></details>
    <details v-if="data.trigger" class="trigger"><summary>触发信息</summary><ContentViewer :value="data.trigger" label="触发信息" /></details>
    <p v-if="data.contentTruncated" class="muted">内容已达到展示上限，以下记录可能不完整。</p>
    <div class="detail-tabs" role="tablist" aria-label="唤醒详情"><button v-for="item in tabs" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button></div>
    <section role="tabpanel" :aria-label="tabs.find(item => item.id === tab)?.label" class="tab-content">
      <template v-if="tab === 'process'">
        <p v-if="!timeline.length" class="muted">未记录执行过程</p>
        <ol class="process-list"><li v-for="item in timeline" :key="item.key"><time class="muted">{{ time(item.at) }}</time>
          <div v-if="item.request" class="process-request"><RouterLink :to="{ path: '/requests', query: { ...route.query, outcome: undefined, detailGroup: undefined, selected: item.request.requestId, group: item.request.groupId } }">{{ item.request.model || '模型请求' }}</RouterLink><span class="badge">{{ status(item.request.outcome) }}</span><span class="muted">{{ duration(item.request.durationMs) }} · 输出 {{ count(item.request.outputTokens) }}</span><CopyId :value="item.request.requestId" /><p v-if="hasFailure(item.request.outcome) && item.request.errorCode" class="error">{{ status(item.request.errorCode) }}</p></div>
          <ToolDetails v-else-if="item.tool" :tool="item.tool" :group-id="data.wake.groupId" />
        </li></ol>
      </template>
      <template v-else-if="tab === 'conversation'">
        <p v-if="!data.messages.length" class="muted">未记录对话内容</p>
        <article v-for="(message, index) in data.messages" :key="index" class="message panel"><header class="message-heading"><span class="badge">{{ roleLabel(message.role) }}</span><time v-if="message.createdAt != null" class="muted">{{ time(message.createdAt) }}</time><RouterLink v-if="message.requestId" :to="{ path: '/requests', query: { ...route.query, outcome: undefined, detailGroup: undefined, selected: message.requestId, group: data.wake.groupId } }">关联请求</RouterLink><CopyId v-if="message.toolCallId" :value="message.toolCallId" /></header><ContentViewer :value="message.content" :label="`${roleLabel(message.role)} 消息`" /></article>
      </template>
      <template v-else-if="tab === 'requests'">
        <p v-if="!data.requests.length" class="muted">未关联模型请求</p>
        <div v-else class="table-scroll"><table class="compact-table"><thead><tr><th>请求 / 模型</th><th>状态</th><th>耗时</th><th>未缓存输入</th><th>缓存输入</th><th>输出（含推理）</th><th>推理</th><th title="端到端输出速度，含等待，不是解码速度">TPS ⓘ</th></tr></thead><tbody><tr v-for="request in data.requests" :key="request.requestId"><td><RouterLink :to="{ path: '/requests', query: { ...route.query, outcome: undefined, detailGroup: undefined, selected: request.requestId, group: request.groupId } }">{{ request.model || request.transport }}</RouterLink><div><CopyId :value="request.requestId" /></div><small class="muted">{{ time(request.startedAt) }}</small></td><td><span class="badge">{{ status(request.outcome) }}</span><p v-if="hasFailure(request.outcome) && request.errorCode" class="error">{{ status(request.errorCode) }}</p></td><td>{{ duration(request.durationMs) }}</td><td>{{ count(request.inputTokens) }}</td><td>{{ count(request.cachedInputTokens) }}</td><td>{{ count(request.outputTokens) }}</td><td>{{ count(request.reasoningTokens) }}</td><td title="端到端输出速度，含等待，不是解码速度">{{ count(tps(request)) }}</td></tr></tbody></table></div>
      </template>
      <template v-else>
        <p v-if="!data.events.length" class="muted">未记录事件</p>
        <article v-for="(event, index) in data.events" :key="index" class="event"><header class="message-heading"><time v-if="event.time != null" class="muted">{{ time(event.time) }}</time><span class="badge">{{ eventLabel(event.kind) }}</span><strong>{{ eventLabel(event.title) }}</strong></header><details v-if="event.detail != null"><summary>事件详情</summary><ContentViewer :value="event.detail" label="事件详情" /></details></article>
      </template>
    </section>
  </template></DataState></section>
</template>
