<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import type { OverviewResponse } from "../../../contracts/contracts";
import type { HealthResponse } from "../../../contracts/review";
import { number, percent, duration, time } from "../api/client";
import { useFilters, useResource } from "../composables/useDashboard";
import DataState from "../components/ui/DataState.vue";
import AvailabilityNote from "../components/ui/AvailabilityNote.vue";
import PerformanceFacts from "../components/ui/PerformanceFacts.vue";
import OverviewCharts from "../components/overview/OverviewCharts.vue";

const route = useRoute();
const { query, groupId } = useFilters();
const { data, loading, error, retry } = useResource<OverviewResponse>(
  computed(() => `overview?${query.value}`),
);
const health = useResource<HealthResponse>(computed(() => "health"));
const connectivityLabel: Record<HealthResponse['connectivity'], string> = {
  connected: '接入已连接', disconnected: '接入已断开', stale: '心跳过期', unknown: '接入状态未知',
};
const missing = "未记录或不可用，不能视为 0。";
const display = (value: number | null | undefined, format = number) =>
  value == null ? "—" : format(value);
const search = computed(() => typeof route.query.q === "string" ? route.query.q.trim().toLowerCase() : "");
const groups = computed(() => (data.value?.groups ?? []).filter(g => g.groupId.toLowerCase().includes(search.value)));
const healthGroups = computed(() => (health.data.value?.groups ?? []).filter(g =>
  (!groupId.value || g.groupId === groupId.value) && g.groupId.toLowerCase().includes(search.value),
));
const metrics = computed(() => {
  const s = data.value?.summary;
  return s ? [
    { label: "请求", value: s.requests, format: number, hint: "当前群组与时间范围内全部模型请求" },
    { label: "输入", value: s.uncachedInputTokens, format: number, hint: "未缓存输入 token" },
    { label: "缓存", value: s.cachedInputTokens, format: number, hint: "缓存输入 token" },
    { label: "输出", value: s.outputTokens, format: number, hint: "输出包含推理，不重复相加" },
    { label: "耗时 P50", value: s.durationP50Ms, format: duration, hint: "模型请求耗时" },
    { label: "耗时 P95", value: s.durationP95Ms, format: duration, hint: "模型请求耗时" },
  ] : [];
});
</script>

<template>
  <section :aria-busy="loading">
    <header class="page-heading"><h1>总览</h1></header>
    <DataState :loading="loading" :error="error" @retry="retry">
      <template v-if="data">
        <AvailabilityNote :value="data.availability" />
        <div class="metric-strip" aria-label="总览汇总">
          <div v-for="metric in metrics" :key="metric.label" :title="metric.value == null ? missing : metric.hint">
            <span class="muted">{{ metric.label }}</span>
            <strong>{{ display(metric.value, metric.format) }}</strong>
          </div>
        </div>
        <PerformanceFacts :performance="data.summary.performance" :cache="data.summary" />
        <OverviewCharts />
        <section class="panel">
          <div class="section-title">
            <h2>群组汇总</h2>
            <span class="muted">{{ time(data.range.since) }} — {{ time(data.range.until) }}</span>
          </div>
          <div class="section-title">
            <span class="muted">执行中 {{ number(data.summary.running) }} · 中断 {{ number(data.summary.interrupted) }} · 成功 {{ number(data.summary.successes) }} · 失败 {{ number(data.summary.errors) }} · 超时 {{ number(data.summary.timeouts) }} · 取消 {{ number(data.summary.cancelled) }} · 结果不明 {{ number(data.summary.unknown) }}</span>
            <RouterLink :to="{ path: '/requests', query: route.query }">请求明细 →</RouterLink>
          </div>
          <p v-if="route.query.outcome || search" class="muted">汇总按时间与群组统计全部结果；搜索仅筛选下方群组。</p>
          <div class="table-wrap">
            <table class="compact-table">
              <thead><tr><th>群组</th><th>请求</th><th>成功</th><th>失败 / 超时</th><th title="未缓存输入 tokens">输入</th><th>缓存</th><th title="包含推理，不重复相加">输出</th><th title="仅使用总输入与缓存计数有效配对的样本；未知不视为零">缓存命中</th><th>P95</th></tr></thead>
              <tbody>
                <tr v-for="g in groups" :key="g.groupId">
                  <td><RouterLink :to="{ path: '/requests', query: { ...route.query, group: g.groupId } }">{{ g.groupId }}</RouterLink></td>
                  <td>{{ number(g.requests) }}</td><td>{{ number(g.successes) }}</td><td>{{ number(g.errors) }} / {{ number(g.timeouts) }}</td>
                  <td :title="g.uncachedInputTokens == null ? missing : undefined">{{ display(g.uncachedInputTokens) }}</td>
                  <td :title="g.cachedInputTokens == null ? missing : undefined">{{ display(g.cachedInputTokens) }}</td>
                  <td :title="g.outputTokens == null ? missing : undefined">{{ display(g.outputTokens) }}</td>
                  <td :title="g.cacheHitRate == null ? missing : undefined">{{ display(g.cacheHitRate, percent) }}</td>
                  <td :title="g.durationP95Ms == null ? missing : undefined">{{ display(g.durationP95Ms, duration) }}</td>
                </tr>
                <tr v-if="!groups.length"><td colspan="9" class="muted">当前筛选无群组记录</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </DataState>
    <section class="panel" :aria-busy="health.loading.value">
      <div class="section-title">
        <h2>最近运行事实</h2>
        <span v-if="health.data.value" class="muted">观测时间 {{ time(health.data.value.now) }}</span>
      </div>
      <DataState :loading="health.loading.value" :error="health.error.value" @retry="health.retry">
        <template v-if="health.data.value">
          <div class="section-title health-facts">
            <span class="badge">遥测{{ health.data.value.availability.telemetry ? '可读取' : '不可读取' }}</span>
            <span class="badge" :title="health.data.value.note">{{ connectivityLabel[health.data.value.connectivity] }}</span>
            <span class="muted">仅反映接入观测，不等于 QQ 账号真实在线；无近期活动不代表离线。</span>
          </div>
          <dl class="metadata">
            <div><dt>最近心跳</dt><dd>{{ display(health.data.value.lastHeartbeatAt, time) }}</dd></div>
            <div><dt>最近连接事件</dt><dd>{{ display(health.data.value.lastConnectionEventAt, time) }}</dd></div>
          </dl>
          <div class="table-wrap">
            <table class="compact-table">
              <thead><tr><th>群组</th><th>会话数据</th><th>最近观测消息</th><th>最近模型请求</th></tr></thead>
              <tbody>
                <tr v-for="g in healthGroups" :key="g.groupId">
                  <td>{{ g.groupId }}</td><td><span class="badge">{{ g.sessionAvailable ? '可读取' : '不可读取' }}</span></td>
                  <td :title="g.lastObservedMessageAt == null ? missing : undefined">{{ display(g.lastObservedMessageAt, time) }}</td>
                  <td :title="g.lastRequestAt == null ? missing : undefined">{{ display(g.lastRequestAt, time) }}</td>
                </tr>
                <tr v-if="!healthGroups.length"><td colspan="4" class="muted">当前筛选无运行记录</td></tr>
              </tbody>
            </table>
          </div>
        </template>
      </DataState>
    </section>
  </section>
</template>
