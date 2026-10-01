<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { ToolSummary, ToolsResponse } from '../../../contracts/contracts';
import { useResource, useFilters } from '../composables/useDashboard';
import { number, duration } from '../api/client';
import DataState from '../components/ui/DataState.vue';
import AvailabilityNote from '../components/ui/AvailabilityNote.vue';

const route = useRoute();
const { query, identity } = useFilters();
const { data, loading, error, retry } = useResource<ToolsResponse>(
  computed(() => `tools?${query.value}`),
  identity,
);
const missing = '未记录或不可用，不能视为 0。';
const search = computed(() =>
  typeof route.query.q === 'string' ? route.query.q.trim().toLowerCase() : '',
);
/** 少见的结果合并为一列，悬停可见非零项明细。 */
const OTHER_OUTCOMES = [
  ['rejected', '拒绝'],
  ['deferred', '延后'],
  ['cancelled', '取消'],
  ['unknown', '不明（不代表操作未发生）'],
  ['skipped', '跳过'],
  ['pending', '待执行'],
  ['started', '执行中'],
] as const satisfies readonly (readonly [keyof ToolSummary, string])[];
const other = (tool: ToolSummary) =>
  OTHER_OUTCOMES.reduce((n, [key]) => n + tool[key], 0);
const otherDetail = (tool: ToolSummary) =>
  OTHER_OUTCOMES.filter(([key]) => tool[key] > 0)
    .map(([key, label]) => `${label} ${number(tool[key])}`)
    .join('，') || undefined;
const items = computed(() =>
  [...(data.value?.items ?? [])]
    .filter((row) => row.name.toLowerCase().includes(search.value))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
);
const total = computed(() =>
  items.value.reduce((sum, row) => sum + row.calls, 0),
);
const failed = computed(() =>
  items.value.reduce((sum, row) => sum + row.errors, 0),
);
const unknown = computed(() =>
  items.value.reduce((sum, row) => sum + row.unknown, 0),
);
</script>

<template>
  <section :aria-busy="loading">
    <header class="page-heading"><h1>工具统计</h1></header>
    <DataState :loading="loading" :error="error" :stale="!!data" @retry="retry">
      <template v-if="data">
        <AvailabilityNote :value="data.availability" />
        <div class="metric-strip">
          <div>
            <span class="muted">调用</span><strong>{{ number(total) }}</strong>
          </div>
          <div>
            <span class="muted">工具</span
            ><strong>{{ number(items.length) }}</strong>
          </div>
          <div>
            <span class="muted">失败</span><strong>{{ number(failed) }}</strong>
          </div>
          <div>
            <span class="muted">结果不明</span
            ><strong>{{ number(unknown) }}</strong>
          </div>
        </div>
        <section class="panel">
          <div class="section-title">
            <h2>按工具汇总</h2>
            <RouterLink :to="{ path: '/wakes', query: route.query }"
              >逐次调用复盘 →</RouterLink
            >
          </div>
          <p v-if="route.query.outcome || search" class="muted">
            搜索匹配工具名；此汇总接口统计全部结果，不按结果筛选。
          </p>
          <div class="table-wrap">
            <table class="compact-table">
              <thead>
                <tr>
                  <th>工具</th>
                  <th>调用</th>
                  <th title="已处理不保证外部操作成功">已处理</th>
                  <th title="仅 failed，不包含拒绝、延后、取消或结果不明">
                    失败
                  </th>
                  <th
                    title="拒绝、延后、取消、不明、跳过、待执行、执行中；悬停数字看明细"
                  >
                    其他
                  </th>
                  <th>P50</th>
                  <th>P95</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="tool in items" :key="tool.name">
                  <td>
                    <code>{{ tool.name }}</code>
                  </td>
                  <td>{{ number(tool.calls) }}</td>
                  <td>{{ number(tool.handled) }}</td>
                  <td :class="{ error: tool.errors > 0 }">
                    {{ number(tool.errors) }}
                  </td>
                  <td :title="otherDetail(tool)">
                    {{ other(tool) ? number(other(tool)) : '—' }}
                  </td>
                  <td :title="tool.durationP50Ms == null ? missing : undefined">
                    {{
                      tool.durationP50Ms == null
                        ? '—'
                        : duration(tool.durationP50Ms)
                    }}
                  </td>
                  <td :title="tool.durationP95Ms == null ? missing : undefined">
                    {{
                      tool.durationP95Ms == null
                        ? '—'
                        : duration(tool.durationP95Ms)
                    }}
                  </td>
                </tr>
                <tr v-if="!items.length">
                  <td colspan="7" class="muted">当前筛选无工具调用</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="section-title muted">
            <span>参数 / 返回值请进入逐次复盘。</span>
            <RouterLink :to="{ path: '/requests', query: route.query }"
              >请求复盘 →</RouterLink
            >
          </div>
        </section>
      </template>
    </DataState>
  </section>
</template>
