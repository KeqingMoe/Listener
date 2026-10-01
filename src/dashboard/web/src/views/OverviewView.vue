<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { OverviewResponse } from '../../../contracts/contracts';
import type { HealthResponse } from '../../../contracts/review';
import { number, percent, duration, time } from '../api/client';
import { useFilters, useResource } from '../composables/useDashboard';
import DataState from '../components/ui/DataState.vue';
import AvailabilityNote from '../components/ui/AvailabilityNote.vue';
import OverviewCharts from '../components/overview/OverviewCharts.vue';

defineOptions({ name: 'OverviewView' });
const route = useRoute();
const active = computed(() => route.path === '/');
const { query, groupId, identity } = useFilters();
const { data, loading, error, retry } = useResource<OverviewResponse>(
  computed(() => `overview?${query.value}`),
  identity,
  active,
);
const healthPath = computed(() => 'health');
const health = useResource<HealthResponse>(healthPath, healthPath, active);
const connectivityLabel: Record<HealthResponse['connectivity'], string> = {
  connected: '接入已连接',
  disconnected: '接入已断开',
  stale: '心跳过期',
  unknown: '接入状态未知',
};
const missing = '未记录或不可用，不能视为 0。';
const display = (value: number | null | undefined, format = number) =>
  value == null ? '—' : format(value);
const search = computed(() =>
  typeof route.query.q === 'string' ? route.query.q.trim().toLowerCase() : '',
);
const groups = computed(() =>
  (data.value?.groups ?? []).filter((g) =>
    g.groupId.toLowerCase().includes(search.value),
  ),
);
const healthGroups = computed(() =>
  (health.data.value?.groups ?? []).filter(
    (g) =>
      (!groupId.value || g.groupId === groupId.value) &&
      g.groupId.toLowerCase().includes(search.value),
  ),
);
const tps = (value: number | null | undefined) =>
  value == null ? '—' : `${value.toFixed(1)} tok/s`;
const ttftHint =
  '已结束且 TTFT 有效、不超过请求耗时的样本算术平均值，包含失败请求；缺失不作 0。';
const tpsHint =
  '仅成功且计时、输出有效配对的请求：输出 token（含推理）之和 / 首个有效输出至流完成耗时之和；不含 TTFT，缺失或零耗时不参与。客户端观测速率受网络缓冲影响。';
const metrics = computed(() => {
  const s = data.value?.summary;
  if (!s) {
    return [];
  }
  const p = s.performance;
  return [
    {
      label: '请求',
      value: s.requests,
      format: number,
      hint: '当前群组与时间范围内全部模型请求',
    },
    {
      label: '输入',
      value: s.uncachedInputTokens,
      format: number,
      hint: '未缓存输入 token',
    },
    {
      label: '缓存',
      value: s.cachedInputTokens,
      format: number,
      hint: '缓存输入 token',
    },
    {
      label: '输出',
      value: s.outputTokens,
      format: number,
      hint: '输出包含推理，不重复相加',
    },
    {
      label: '耗时 P50',
      value: s.durationP50Ms,
      format: duration,
      hint: '模型请求耗时',
    },
    {
      label: '耗时 P95',
      value: s.durationP95Ms,
      format: duration,
      hint: '模型请求耗时',
    },
    {
      label: '缓存命中',
      value: s.cacheHitRate,
      format: percent,
      hint: '仅使用总输入与缓存计数有效配对的样本：缓存量之和 / 同批总输入之和；未知不视为零，总输入为零时比率未知。',
    },
    {
      label: 'TTFT',
      value: p.ttftMs,
      format: duration,
      hint: `${ttftHint} 已记录 ${number(p.coverage.ttftRequests)} 次。`,
    },
    { label: 'TPS', value: p.tps, format: tps, hint: tpsHint },
    {
      label: '模型累计',
      value: p.modelDurationMs,
      format: duration,
      hint: '已记录的模型 HTTP 耗时累计',
    },
    {
      label: '工具累计',
      value: p.toolDurationMs,
      format: duration,
      hint: '工具执行账本耗时累计',
    },
  ];
});
</script>

<template>
  <section :aria-busy="loading">
    <header class="page-heading"><h1>总览</h1></header>
    <OverviewCharts>
      <template #side>
        <section class="panel metric-panel">
          <DataState
            :loading="loading"
            :error="error"
            :stale="!!data"
            @retry="retry"
          >
            <template v-if="data">
              <AvailabilityNote :value="data.availability" />
              <div class="metric-strip" aria-label="总览汇总">
                <div
                  v-for="metric in metrics"
                  :key="metric.label"
                  :title="metric.value == null ? missing : metric.hint"
                >
                  <span class="muted">{{ metric.label }}</span>
                  <strong>{{ display(metric.value, metric.format) }}</strong>
                </div>
              </div>
            </template>
          </DataState>
        </section>
      </template>
    </OverviewCharts>
    <template v-if="data && !loading && !error">
      <section class="panel">
        <div class="section-title">
          <h2>群组汇总</h2>
          <span class="muted"
            >{{ time(data.range.since) }} — {{ time(data.range.until) }}</span
          >
        </div>
        <div class="section-title">
          <span class="muted"
            >执行中 {{ number(data.summary.running) }} · 中断
            {{ number(data.summary.interrupted) }} · 成功
            {{ number(data.summary.successes) }} · 失败
            {{ number(data.summary.errors) }} · 超时
            {{ number(data.summary.timeouts) }} · 取消
            {{ number(data.summary.cancelled) }} · 结果不明
            {{ number(data.summary.unknown) }}</span
          >
          <RouterLink :to="{ path: '/requests', query: route.query }"
            >请求明细 →</RouterLink
          >
        </div>
        <p v-if="route.query.outcome || search" class="muted">
          汇总按时间与群组统计全部结果；搜索仅筛选下方群组。
        </p>
        <div class="table-wrap">
          <table class="compact-table">
            <thead>
              <tr>
                <th>群组</th>
                <th>请求</th>
                <th>成功</th>
                <th>失败 / 超时</th>
                <th title="未缓存输入 tokens">输入</th>
                <th>缓存</th>
                <th title="包含推理，不重复相加">输出</th>
                <th title="仅使用总输入与缓存计数有效配对的样本；未知不视为零">
                  缓存命中
                </th>
                <th :title="ttftHint">TTFT</th>
                <th :title="tpsHint">TPS</th>
                <th>P95</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in groups" :key="g.groupId">
                <td>
                  <RouterLink
                    :to="{
                      path: '/requests',
                      query: { ...route.query, group: g.groupId },
                    }"
                    >{{ g.groupId }}</RouterLink
                  >
                </td>
                <td>{{ number(g.requests) }}</td>
                <td>{{ number(g.successes) }}</td>
                <td>{{ number(g.errors) }} / {{ number(g.timeouts) }}</td>
                <td
                  :title="g.uncachedInputTokens == null ? missing : undefined"
                >
                  {{ display(g.uncachedInputTokens) }}
                </td>
                <td :title="g.cachedInputTokens == null ? missing : undefined">
                  {{ display(g.cachedInputTokens) }}
                </td>
                <td :title="g.outputTokens == null ? missing : undefined">
                  {{ display(g.outputTokens) }}
                </td>
                <td :title="g.cacheHitRate == null ? missing : undefined">
                  {{ display(g.cacheHitRate, percent) }}
                </td>
                <td :title="g.performance.ttftMs == null ? missing : ttftHint">
                  {{ display(g.performance.ttftMs, duration) }}
                </td>
                <td :title="g.performance.tps == null ? missing : tpsHint">
                  {{ display(g.performance.tps, tps) }}
                </td>
                <td :title="g.durationP95Ms == null ? missing : undefined">
                  {{ display(g.durationP95Ms, duration) }}
                </td>
              </tr>
              <tr v-if="!groups.length">
                <td colspan="11" class="muted">当前筛选无群组记录</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="section-title">
          <h2>模型汇总</h2>
          <span class="muted"
            >按配置中的模型名统计；未记录模型名的旧请求显示 —</span
          >
        </div>
        <div class="table-wrap">
          <table class="compact-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>请求</th>
                <th>成功</th>
                <th>失败 / 超时</th>
                <th title="未缓存输入 tokens">输入</th>
                <th>缓存</th>
                <th title="包含推理，不重复相加">输出</th>
                <th title="仅使用总输入与缓存计数有效配对的样本；未知不视为零">
                  缓存命中
                </th>
                <th :title="ttftHint">TTFT</th>
                <th :title="tpsHint">TPS</th>
                <th>P95</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.models" :key="m.modelName ?? ''">
                <td>
                  <RouterLink
                    v-if="m.modelName"
                    :to="{
                      path: '/requests',
                      query: { ...route.query, model: m.modelName },
                    }"
                    >{{ m.modelName }}</RouterLink
                  ><span
                    v-else
                    class="muted"
                    title="早期版本的请求记录没有保存模型名"
                    >未记录模型</span
                  >
                </td>
                <td>{{ number(m.requests) }}</td>
                <td>{{ number(m.successes) }}</td>
                <td>{{ number(m.errors) }} / {{ number(m.timeouts) }}</td>
                <td
                  :title="m.uncachedInputTokens == null ? missing : undefined"
                >
                  {{ display(m.uncachedInputTokens) }}
                </td>
                <td :title="m.cachedInputTokens == null ? missing : undefined">
                  {{ display(m.cachedInputTokens) }}
                </td>
                <td :title="m.outputTokens == null ? missing : undefined">
                  {{ display(m.outputTokens) }}
                </td>
                <td :title="m.cacheHitRate == null ? missing : undefined">
                  {{ display(m.cacheHitRate, percent) }}
                </td>
                <td :title="m.performance.ttftMs == null ? missing : ttftHint">
                  {{ display(m.performance.ttftMs, duration) }}
                </td>
                <td :title="m.performance.tps == null ? missing : tpsHint">
                  {{ display(m.performance.tps, tps) }}
                </td>
                <td :title="m.durationP95Ms == null ? missing : undefined">
                  {{ display(m.durationP95Ms, duration) }}
                </td>
              </tr>
              <tr v-if="!data.models.length">
                <td colspan="11" class="muted">当前筛选无模型请求</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <section class="panel" :aria-busy="health.loading.value">
      <div class="section-title">
        <h2>最近运行事实</h2>
        <span v-if="health.data.value" class="muted"
          >观测时间 {{ time(health.data.value.now) }}</span
        >
      </div>
      <DataState
        :loading="health.loading.value"
        :error="health.error.value"
        :stale="!!health.data.value"
        @retry="health.retry"
      >
        <template v-if="health.data.value">
          <div class="section-title health-facts">
            <span class="badge"
              >遥测{{
                health.data.value.availability.telemetry ? '可读取' : '不可读取'
              }}</span
            >
            <span class="badge" :title="health.data.value.note">{{
              connectivityLabel[health.data.value.connectivity]
            }}</span>
            <span class="muted"
              >仅反映接入观测，不等于 QQ
              账号真实在线；无近期活动不代表离线。</span
            >
          </div>
          <dl class="metadata">
            <div>
              <dt>最近心跳</dt>
              <dd>{{ display(health.data.value.lastHeartbeatAt, time) }}</dd>
            </div>
            <div>
              <dt>最近连接事件</dt>
              <dd>
                {{ display(health.data.value.lastConnectionEventAt, time) }}
              </dd>
            </div>
          </dl>
          <div class="table-wrap">
            <table class="compact-table">
              <thead>
                <tr>
                  <th>群组</th>
                  <th>会话数据</th>
                  <th>最近观测消息</th>
                  <th>最近模型请求</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in healthGroups" :key="g.groupId">
                  <td>{{ g.groupId }}</td>
                  <td>
                    <span class="badge">{{
                      g.sessionAvailable ? '可读取' : '不可读取'
                    }}</span>
                  </td>
                  <td
                    :title="
                      g.lastObservedMessageAt == null ? missing : undefined
                    "
                  >
                    {{ display(g.lastObservedMessageAt, time) }}
                  </td>
                  <td :title="g.lastRequestAt == null ? missing : undefined">
                    {{ display(g.lastRequestAt, time) }}
                  </td>
                </tr>
                <tr v-if="!healthGroups.length">
                  <td colspan="4" class="muted">当前筛选无运行记录</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </DataState>
    </section>
  </section>
</template>
<style scoped>
.metric-panel {
  margin-bottom: 0;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
}
.metric-strip {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  /* 多出的高度平均分给各行，指标卡与右侧图表同高时不留大块空白。 */
  align-content: space-evenly;
  gap: var(--space-2) var(--space-4);
}
.metric-strip > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) 0;
}
.metric-strip strong {
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
</style>
