<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { WakesResponse } from "../../../shared/contracts";
import {
  useFilters,
  useResource,
  refreshVersion,
} from "../composables/useDashboard";
import { number, time, duration, status } from "../api/client";
import DataState from "../components/ui/DataState.vue";
import AvailabilityNote from "../components/ui/AvailabilityNote.vue";
const { query } = useFilters();
const cursors = ref<string[]>([]);
watch(
  [query, refreshVersion],
  () => {
    cursors.value = [];
  },
  { flush: "sync" },
);
const { data, loading, error, retry } = useResource<WakesResponse>(
  computed(
    () =>
      `wakes?${query.value}&limit=30${cursors.value.length ? "&cursor=" + encodeURIComponent(cursors.value.at(-1)!) : ""}`,
  ),
);
function next() {
  if (data.value?.nextCursor) cursors.value.push(data.value.nextCursor);
}
</script>
<template>
  <section :aria-busy="loading">
    <div class="page-heading">
      <div class="eyebrow">执行追踪</div>
      <h1>唤醒记录</h1>
      <p>
        从一次触发开始，查看已有模型请求与工具执行记录。未关联请求不在此列统计。
      </p>
    </div>
    <DataState :loading="loading" :error="error" @retry="retry"
      ><template v-if="data"
        ><AvailabilityNote :value="data.availability" />
        <div class="card">
          <DataState :loading="false" error="" :empty="data.items.length === 0"
            ><div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>开始时间</th>
                    <th>群组</th>
                    <th>结果</th>
                    <th>原因代码</th>
                    <th>已关联请求</th>
                    <th>工具调用</th>
                    <th>输入 / 输出</th>
                    <th>耗时</th>
                    <th><span class="sr-only">详情</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="wake in data.items"
                    :key="wake.groupId + ':' + wake.wakeId"
                  >
                    <td>{{ time(wake.startedAt) }}</td>
                    <td>{{ wake.groupId }}</td>
                    <td>
                      <span class="badge">{{ status(wake.outcome) }}</span>
                    </td>
                    <td>{{ wake.reasonCode ?? "未记录" }}</td>
                    <td>{{ number(wake.modelRequests) }}</td>
                    <td>{{ number(wake.toolCalls) }}</td>
                    <td>
                      {{ number(wake.inputTokens) }} /
                      {{ number(wake.outputTokens) }}
                    </td>
                    <td>{{ duration(wake.durationMs) }}</td>
                    <td>
                      <RouterLink
                        :to="{
                          path: `/wakes/${encodeURIComponent(wake.groupId)}/${encodeURIComponent(wake.wakeId)}`,
                          query: $route.query,
                        }"
                        :aria-label="`查看唤醒 ${wake.wakeId}`"
                        >查看 →</RouterLink
                      >
                    </td>
                  </tr>
                </tbody>
              </table>
            </div></DataState
          >
          <div class="pagination">
            <span>第 {{ cursors.length + 1 }} 页 · 每页最多30条</span>
            <div>
              <button
                class="button"
                :disabled="!cursors.length"
                @click="cursors.pop()"
              >
                上一页</button
              ><button
                class="button"
                :disabled="!data.nextCursor"
                @click="next"
              >
                下一页
              </button>
            </div>
          </div>
        </div></template
      ></DataState
    >
    <p class="muted footnote">
      历史触发原因未被完整记录，不进行猜测或回填。刷新或切换筛选后返回第一页。
    </p>
  </section>
</template>
