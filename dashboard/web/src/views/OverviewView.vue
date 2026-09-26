<script setup lang="ts">
import { computed } from "vue";
import { use } from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import VChart from "vue-echarts";
import type {
  OverviewResponse,
  ToolsResponse,
} from "../../../shared/contracts";
import { number, percent, duration, time } from "../api/client";
import { useFilters, useResource } from "../composables/useDashboard";
import DataState from "../components/ui/DataState.vue";
import AvailabilityNote from "../components/ui/AvailabilityNote.vue";
use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  CanvasRenderer,
]);
const { query } = useFilters();
const { data, loading, error, retry } = useResource<OverviewResponse>(
  computed(() => `overview?${query.value}`),
);
const tools = useResource<ToolsResponse>(
  computed(() => `tools?${query.value}`),
);
const cards = computed(() => {
  const s = data.value?.summary;
  return s
    ? [
        ["模型请求", number(s.requests), "失败 " + number(s.errors) + " 次"],
        ["输入 tokens", number(s.inputTokens), "包含缓存输入"],
        ["输出 tokens", number(s.outputTokens), "推理 token 不重复相加"],
        ["缓存命中率", percent(s.cacheHitRate), "按已知输入 token 加权"],
        [
          "未缓存输入",
          number(s.uncachedInputTokens),
          "仅统计缓存字段已知的请求",
        ],
        [
          "缓存数据覆盖率",
          percent(s.cacheCoverage),
          `缓存已知 ${number(s.knownCacheRequests)} 次 · 输入已知 ${number(s.knownInputRequests)} 次`,
        ],
      ]
    : [];
});
const chart = computed(() => ({
  animation: false,
  aria: { enabled: true },
  color: ["#14b8a6", "#8b9fbb", "#6366f1"],
  tooltip: { trigger: "axis", renderMode: "richText" },
  legend: { bottom: 0 },
  grid: { left: 65, right: 20, top: 20, bottom: 64 },
  xAxis: {
    type: "category",
    data: data.value?.series.map((s) =>
      new Date(s.bucketStart).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  },
  yAxis: { type: "value" },
  series: [
    ["缓存输入", "cachedInputTokens"],
    ["未缓存输入", "uncachedInputTokens"],
    ["输出", "outputTokens"],
  ].map(([name, key]) => ({
    name,
    type: "bar",
    data: data.value?.series.map((s) => s[key as "inputTokens"]),
    stack: key === "outputTokens" ? "output" : "input",
    barMaxWidth: 24,
  })),
}));
const rank = computed(() =>
  [...(tools.data.value?.items ?? [])]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 6),
);
</script>
<template>
  <section :aria-busy="loading">
    <div class="page-heading">
      <div class="eyebrow">运行概况</div>
      <h1>总览</h1>
      <p>理解模型用量、缓存覆盖与各群运行情况。</p>
    </div>
    <DataState :loading="loading" :error="error" @retry="retry"
      ><template v-if="data"
        ><AvailabilityNote :value="data.availability" />
        <div class="metric-grid">
          <article
            v-for="[label, value, hint] in cards"
            :key="label"
            class="card metric"
          >
            <h2>{{ label }}</h2>
            <strong>{{ value }}</strong>
            <p>{{ hint }}</p>
          </article>
        </div>
        <div class="card">
          <div class="section-heading">
            <div>
              <h2>Token 用量趋势</h2>
              <p>缓存输入是总输入的子集；缺失数据不会补零。</p>
            </div>
            <span class="badge"
              >{{ time(data.range.since) }} — {{ time(data.range.until) }}</span
            >
          </div>
          <div v-if="data.summary.requests === 0" class="state">
            当前时间范围暂无模型请求。
          </div>
          <VChart
            v-else
            class="chart"
            :option="chart"
            autoresize
            aria-label="缓存输入、未缓存输入与输出token趋势"
          />
          <details v-if="data.series.length">
            <summary>查看趋势数据表</summary>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>缓存输入</th>
                    <th>未缓存输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in data.series" :key="row.bucketStart">
                    <td>{{ time(row.bucketStart) }}</td>
                    <td>{{ number(row.cachedInputTokens) }}</td>
                    <td>{{ number(row.uncachedInputTokens) }}</td>
                    <td>{{ number(row.outputTokens) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
        <div class="two-column">
          <section class="card">
            <div class="section-heading">
              <h2>请求耗时</h2>
              <span class="badge">模型请求</span>
            </div>
            <div class="latency">
              <div>
                <span>中位数 P50</span
                ><strong>{{ duration(data.summary.durationP50Ms) }}</strong>
              </div>
              <div>
                <span>P95</span
                ><strong>{{ duration(data.summary.durationP95Ms) }}</strong>
              </div>
            </div>
            <p class="muted">按已有耗时记录统计，不等于整次唤醒的总耗时。</p>
          </section>
          <section class="card" :aria-busy="tools.loading.value">
            <div class="section-heading">
              <h2>工具调用排行</h2>
              <RouterLink :to="{ path: '/tools', query: $route.query }"
                >全部工具 →</RouterLink
              >
            </div>
            <DataState
              :loading="tools.loading.value"
              :error="tools.error.value"
              :empty="rank.length === 0"
              @retry="tools.retry"
              ><ol class="ranking">
                <li v-for="item in rank" :key="item.name">
                  <code>{{ item.name }}</code
                  ><strong>{{ number(item.calls) }}</strong>
                </li>
              </ol></DataState
            >
          </section>
        </div>
        <section class="card">
          <div class="section-heading">
            <h2>群组用量对比</h2>
            <span class="muted">不跨未知字段推算费用</span>
          </div>
          <DataState :loading="false" error="" :empty="data.groups.length === 0"
            ><div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>群组</th>
                    <th>请求</th>
                    <th>输入 tokens</th>
                    <th>输出 tokens</th>
                    <th>缓存命中率</th>
                    <th>数据覆盖率</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="g in data.groups" :key="g.groupId">
                    <td>{{ g.groupId }}</td>
                    <td>{{ number(g.requests) }}</td>
                    <td>{{ number(g.inputTokens) }}</td>
                    <td>{{ number(g.outputTokens) }}</td>
                    <td>{{ percent(g.cacheHitRate) }}</td>
                    <td>{{ percent(g.cacheCoverage) }}</td>
                  </tr>
                </tbody>
              </table>
            </div></DataState
          >
        </section></template
      ></DataState
    >
  </section>
</template>
