<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import type { WakeDetailResponse } from "../../../shared/contracts";
import { useResource } from "../composables/useDashboard";
import { number, time, duration, status, diagnosticRows } from "../api/client";
import DataState from "../components/ui/DataState.vue";
import AvailabilityNote from "../components/ui/AvailabilityNote.vue";
const route = useRoute();
const { data, loading, error, retry } = useResource<WakeDetailResponse>(
  computed(
    () =>
      `wakes/${encodeURIComponent(String(route.params.wakeId))}?groupId=${encodeURIComponent(String(route.params.groupId))}`,
  ),
);
const timeline = computed(() => {
  const d = data.value;
  return d
    ? [
        ...d.requests.map((r) => ({
          key: "r" + r.requestId,
          at: r.startedAt,
          type: "模型请求",
          title: r.transport,
          rows: [
            ["请求标识", r.requestId],
            ["结果分类", status(r.outcome)],
            ["原始状态", r.status ?? "未知"],
            ["错误代码", r.errorCode ?? "未记录"],
            ["HTTP 状态", number(r.httpStatus)],
            ...diagnosticRows(r.diagnostics, "request"),
            ["耗时", duration(r.durationMs)],
            [
              "输入 / 输出",
              `${number(r.inputTokens)} / ${number(r.outputTokens)}`,
            ],
            ["缓存输入", number(r.cachedInputTokens)],
          ],
        })),
        ...d.tools.map((t) => ({
          key: "t" + t.ordinal,
          at: t.proposedAt,
          type: "工具调用",
          title: t.name,
          rows: [
            ["提出时间", time(t.proposedAt)],
            ["执行状态", status(t.state)],
            ["结果分类", status(t.outcome)],
            ["原始状态", t.status ?? "未知"],
            ["原因代码", t.reasonCode ?? "未记录"],
            ...(t.reasonCode && status(t.reasonCode) !== t.reasonCode ? [["原因说明", status(t.reasonCode)]] : []),
            ["开始时间", time(t.startedAt)],
            ["结束时间", time(t.finishedAt)],
            ["耗时", duration(t.durationMs)],
          ],
        })),
      ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
    : [];
});
</script>
<template>
  <section :aria-busy="loading">
    <RouterLink class="back-link" :to="{ path: '/wakes', query: $route.query }"
      >← 返回唤醒记录</RouterLink
    >
    <div class="page-heading">
      <div class="eyebrow">执行详情</div>
      <h1>一次唤醒的执行过程</h1>
      <p>仅展示可验证的运行元数据，不展示内部思考、工具参数或消息正文。</p>
    </div>
    <DataState :loading="loading" :error="error" @retry="retry"
      ><template v-if="data"
        ><AvailabilityNote :value="data.availability" />
        <section class="card">
          <div class="section-heading">
            <h2>唤醒信息</h2>
            <span class="badge">{{ status(data.wake.outcome) }}</span>
          </div>
          <dl class="metadata">
            <div>
              <dt>群组</dt>
              <dd>{{ data.wake.groupId }}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{{ time(data.wake.startedAt) }}</dd>
            </div>
            <div>
              <dt>总耗时</dt>
              <dd>{{ duration(data.wake.durationMs) }}</dd>
            </div>
            <div>
              <dt>原始结果</dt>
              <dd>{{ data.wake.outcome ?? "未知" }}</dd>
            </div>
            <div>
              <dt>结束原因</dt>
              <dd>{{ data.wake.reasonCode ? status(data.wake.reasonCode) : "未记录" }}<code v-if="data.wake.reasonCode && status(data.wake.reasonCode) !== data.wake.reasonCode"> · {{ data.wake.reasonCode }}</code></dd>
            </div>
            <div v-for="[key, value] in diagnosticRows(data.wake.diagnostics, 'wake')" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ value }}</dd>
            </div>
            <div>
              <dt>触发原因</dt>
              <dd>未知（未记录）</dd>
            </div>
            <div>
              <dt>唤醒标识</dt>
              <dd>
                <code>{{ data.wake.wakeId }}</code>
              </dd>
            </div>
            <div>
              <dt>会话标识</dt>
              <dd>
                <code>{{ data.wake.sessionId }}</code>
              </dd>
            </div>
          </dl>
        </section>
        <p class="muted footnote">
          已完成表示执行账本完成，不等于操作成功；已处理不保证外部操作成功。已提交不等于 QQ 已送达，结果不明不代表操作未发生。诊断仅展示白名单元数据，不展示错误正文、提示词、工具参数或聊天内容。
        </p>
        <p v-if="data.truncated" class="notice">
          此唤醒记录较长，时间线达到资源展示上限，当前结果并不完整。
        </p>
        <section class="card">
          <div class="section-heading">
            <h2>执行时间线</h2>
            <span class="muted"
              >{{ number(data.wake.modelRequests) }} 次已关联模型请求 ·
              {{ number(data.wake.toolCalls) }} 次工具调用</span
            >
          </div>
          <DataState :loading="false" error="" :empty="timeline.length === 0"
            ><ol class="timeline">
              <li v-for="item in timeline" :key="item.key">
                <span class="timeline-dot" aria-hidden="true"></span>
                <div class="timeline-head">
                  <span class="badge">{{ item.type }}</span
                  ><strong>{{ item.title }}</strong
                  ><time>{{ time(item.at) }}</time>
                </div>
                <dl class="event-metadata">
                  <div v-for="[key, value] in item.rows" :key="key">
                    <dt>{{ key }}</dt>
                    <dd>{{ value }}</dd>
                  </div>
                </dl>
              </li>
            </ol></DataState
          >
        </section></template
      ></DataState
    >
  </section>
</template>
