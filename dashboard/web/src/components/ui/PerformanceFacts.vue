<script setup lang="ts">
import type { CacheMetrics, PerformanceMetrics } from '../../../../shared/metrics';
import { duration, number, percent } from '../../api/client';
defineProps<{ performance?: PerformanceMetrics; cache: CacheMetrics }>();
</script>
<template>
  <dl class="performance-facts" aria-label="性能指标">
    <div title="仅使用总输入与缓存计数有效配对的样本：缓存量之和 / 同批总输入之和；未知不视为零，总输入为零时比率未知。"><dt>缓存命中率</dt><dd>{{ percent(cache.cacheHitRate) }}</dd></div>
    <div :title="`成功且有输出用量的 ${number(performance?.coverage.tpsRequests)} 次请求：输出 ${number(performance?.tpsOutputTokens)} token / HTTP 耗时 ${duration(performance?.tpsDurationMs)}。含等待，非解码速度。`"><dt>模型 TPS ⓘ</dt><dd>{{ performance?.modelTps == null ? '—' : performance.modelTps.toFixed(1) }}</dd></div>
    <template v-if="performance?.attribution !== 'request'">
      <div :title="`已知结束 HTTP 耗时累计（含失败），${number(performance?.coverage.modelDurationRequests)} / ${number(performance?.coverage.endedRequests)} 次已结束请求。不是 TPS 分母，不与墙钟相加。`"><dt>模型累计</dt><dd>{{ duration(performance?.modelDurationMs) }}</dd></div>
      <div :title="`工具执行账本耗时累计，${number(performance?.coverage.toolDurationTools)} / ${number(performance?.coverage.tools)} 次；可重叠，不等于纯 NapCat 耗时。`"><dt>工具累计</dt><dd>{{ duration(performance?.toolDurationMs) }}</dd></div>
    </template>
    <template v-if="performance?.attribution === 'wake'">
      <div title="完整唤醒起止之间的实际墙钟耗时"><dt>整轮墙钟</dt><dd>{{ duration(performance.wallDurationMs) }}</dd></div>
      <div title="唤醒范围内已证明模型 HTTP 区间的并集，不重复累计重叠"><dt>模型墙钟</dt><dd>{{ duration(performance.modelWallDurationMs) }}</dd></div>
      <div title="整轮墙钟减模型墙钟；包含工具、调度、存储等开销，不能归因为纯 NapCat 或数据库时间"><dt>非模型开销 ⓘ</dt><dd>{{ duration(performance.otherDurationMs) }}</dd></div>
      <div title="服务端完整归因的整轮输出 / 整轮墙钟；与模型 TPS 的分母不同"><dt>整轮 TPS</dt><dd>{{ performance.roundTps == null ? '—' : performance.roundTps.toFixed(1) }}</dd></div>
    </template>
  </dl>
</template>
<style scoped>
.performance-facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-2); padding: var(--space-1) 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.performance-facts > div { display: flex; align-items: baseline; gap: var(--space-2); }
dt { color: var(--muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
