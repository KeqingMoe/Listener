<script setup lang="ts">
import { computed } from "vue";
import type { ToolsResponse } from "../../../shared/contracts";
import { useResource, useFilters } from "../composables/useDashboard";
import { number, duration } from "../api/client";
import DataState from "../components/ui/DataState.vue";
import AvailabilityNote from "../components/ui/AvailabilityNote.vue";
const { query } = useFilters();
const { data, loading, error, retry } = useResource<ToolsResponse>(
  computed(() => `tools?${query.value}`),
);
const items = computed(() =>
  [...(data.value?.items ?? [])].sort((a, b) => b.calls - a.calls),
);
const total = computed(() =>
  items.value.reduce((sum, row) => sum + row.calls, 0),
);
</script>
<template>
  <section :aria-busy="loading">
    <div class="page-heading">
      <div class="eyebrow">能力使用情况</div>
      <h1>工具统计</h1>
      <p>统计模型提出的工具调用及执行状态，不等同于底层外部请求次数。</p>
    </div>
    <DataState :loading="loading" :error="error" @retry="retry"
      ><template v-if="data"
        ><AvailabilityNote :value="data.availability" />
        <div class="metric-grid compact">
          <article class="card metric">
            <h2>工具调用总数</h2>
            <strong>{{ number(total) }}</strong>
          </article>
          <article class="card metric">
            <h2>使用过的工具</h2>
            <strong>{{ number(items.length) }}</strong>
          </article>
        </div>
        <section class="card">
          <div class="section-heading">
            <h2>工具调用明细</h2>
            <span class="muted">按调用次数排序</span>
          </div>
          <DataState :loading="false" error="" :empty="items.length === 0"
            ><div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>调用</th>
                    <th>已完成</th>
                    <th>已处理</th>
                    <th>失败</th>
                    <th>已拒绝</th>
                    <th>已延后</th>
                    <th>已取消</th>
                    <th>结果不明</th>
                    <th>已跳过</th>
                    <th>待执行</th>
                    <th>执行中</th>
                    <th>耗时 P50</th>
                    <th>耗时 P95</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="tool in items" :key="tool.name">
                    <td>
                      <code>{{ tool.name }}</code>
                    </td>
                    <td>{{ number(tool.calls) }}</td>
                    <td>{{ number(tool.finished) }}</td>
                    <td>{{ number(tool.handled) }}</td>
                    <td>{{ number(tool.errors) }}</td>
                    <td>{{ number(tool.rejected) }}</td>
                    <td>{{ number(tool.deferred) }}</td>
                    <td>{{ number(tool.cancelled) }}</td>
                    <td>{{ number(tool.unknown) }}</td>
                    <td>{{ number(tool.skipped) }}</td>
                    <td>{{ number(tool.pending) }}</td>
                    <td>{{ number(tool.started) }}</td>
                    <td>{{ duration(tool.durationP50Ms) }}</td>
                    <td>{{ duration(tool.durationP95Ms) }}</td>
                  </tr>
                </tbody>
              </table>
            </div></DataState
          >
        </section>
        <p class="muted footnote">
          “已完成”表示执行账本完成，不等于操作成功；各结果分类可能属于已完成记录，不能将所有列相加。失败仅统计 failed，不包含拒绝、延后、取消或结果不明。已处理也不保证外部操作成功；已提交不等于 QQ 已送达。结果不明不代表操作未发生。
        </p></template
      ></DataState
    >
  </section>
</template>
