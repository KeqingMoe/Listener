<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { useRequestTrends } from '../../composables/useRequestTrends';
import {
  chartMetrics,
  chartRanges,
  resolveChartRange,
  coordinateNumber,
  coordinateTime,
  outcomes,
  resolveMetric,
  scatterSummary,
} from './chartMetrics';
import { chartOptions, plot } from './chartOptions';

use([CanvasRenderer, BarChart, ScatterChart, GridComponent, TooltipComponent]);
const route = useRoute();
const router = useRouter();
const { data, loading, error, retry } = useRequestTrends();
const metric = computed(() => resolveMetric(route.query.chartMetric));
const displayRange = computed(() => resolveChartRange(route.query.chartRange));

function selectRange(event: Event) {
  const value = resolveChartRange((event.target as HTMLSelectElement).value);
  void router.replace({
    query: { ...route.query, chartRange: value === 'all' ? undefined : value },
  });
}

function selectMetric(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  void router.replace({
    query: { ...route.query, chartMetric: resolveMetric(value).key },
  });
}

const root = ref<HTMLElement>();
const scatterChart = ref<InstanceType<typeof VChart>>();
const colors = ref({ text: '#263449', muted: '#68788a', border: '#d8e0e8' });
const barOption = computed(() =>
  data.value ? chartOptions(data.value, metric.value, colors.value, 'bar') : {},
);
const scatterOption = computed(() =>
  data.value
    ? chartOptions(
        data.value,
        metric.value,
        colors.value,
        'scatter',
        displayRange.value,
      )
    : {},
);
const summary = computed(() =>
  scatterSummary(data.value?.points ?? [], metric.value, displayRange.value),
);
const total = computed(
  () => data.value?.buckets.reduce((sum, bucket) => sum + bucket.total, 0) ?? 0,
);
const statusSummary = computed(() =>
  outcomes.map((outcome) => ({
    ...outcome,
    count:
      data.value?.points.filter((point) => point.outcome === outcome.key)
        .length ?? 0,
  })),
);
const crosshair = ref({ visible: false, left: 0, top: 0, x: '', y: '' });
const hideCrosshair = () => {
  crosshair.value.visible = false;
};

// zrender事件坐标与ECharts坐标换算同处canvas的CSS像素空间，可直接换算。
// 刻意不做点查找、最近点吸附、tooltip或人为抖动。
function moveCrosshair(event: { offsetX: number; offsetY: number }) {
  const instance = scatterChart.value?.chart;
  if (!instance) {
    return;
  }
  const pixels = [event.offsetX, event.offsetY];
  if (!instance.containPixel({ gridIndex: 0 }, pixels)) {
    hideCrosshair();
    return;
  }
  const values = instance.convertFromPixel(
    { gridIndex: 0 },
    pixels,
  ) as number[];
  const x = values[0],
    y = values[1];
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    hideCrosshair();
    return;
  }
  crosshair.value = {
    visible: true,
    left: event.offsetX,
    top: event.offsetY,
    x: coordinateTime(x),
    y: `${coordinateNumber(y)} ${metric.value.unit}`,
  };
}

watch(
  () => scatterChart.value?.chart,
  (instance, _, cleanup) => {
    if (!instance) {
      return;
    }
    const zr = instance.getZr();
    zr.on('mousemove', moveCrosshair);
    zr.on('globalout', hideCrosshair);
    cleanup(() => {
      zr.off('mousemove', moveCrosshair);
      zr.off('globalout', hideCrosshair);
    });
  },
  { flush: 'post' },
);
watch([metric, data, displayRange], hideCrosshair);
let themeObserver: MutationObserver | undefined;
let resizeObserver: ResizeObserver | undefined;
let media: MediaQueryList | undefined;

function readColors() {
  if (!root.value) {
    return;
  }
  const css = getComputedStyle(root.value);
  colors.value = {
    text: css.getPropertyValue('--text').trim() || '#263449',
    muted: css.getPropertyValue('--muted').trim() || '#68788a',
    border: css.getPropertyValue('--border').trim() || '#d8e0e8',
  };
}

onMounted(() => {
  readColors();
  themeObserver = new MutationObserver(readColors);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', readColors);
  resizeObserver = new ResizeObserver(hideCrosshair);
  if (root.value) {
    resizeObserver.observe(root.value);
  }
});
onUnmounted(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  media?.removeEventListener('change', readColors);
});
</script>

<template>
  <section
    ref="root"
    class="overview-charts"
    aria-label="请求趋势图表"
    :aria-busy="loading"
  >
    <div
      v-if="loading && data"
      class="chart-refresh-feedback muted"
      role="status"
    >
      正在更新请求趋势…
    </div>
    <div v-if="loading && !data" class="panel data-state" role="status">
      正在加载请求趋势…
    </div>
    <div v-if="error" class="panel data-state" role="alert">
      <span class="error"
        >{{ data ? '图表数据已过期，更新失败：' : '请求趋势加载失败：'
        }}{{ error }}</span
      >
      <button type="button" @click="retry">重试图表</button>
    </div>
    <template v-if="data">
      <p
        v-if="!data.availability.telemetry"
        class="chart-note muted"
        role="status"
      >
        趋势遥测不可用；空图不代表没有请求。
      </p>
      <ul class="chart-legend" aria-label="请求状态图例与数量">
        <li v-for="status in statusSummary" :key="status.key">
          <span
            :style="{ backgroundColor: status.color }"
            aria-hidden="true"
          ></span
          >{{ status.label }} {{ status.count }}
        </li>
      </ul>
      <div class="chart-grid">
        <section class="panel chart-panel">
          <div class="section-title"><h2>请求数量趋势</h2></div>
          <p class="chart-summary muted" data-testid="request-trends-summary">
            总数 {{ total }} · {{ data.buckets.length }} 时间桶 · 每桶约
            {{ coordinateNumber(data.bucketMs / 1000) }} 秒
          </p>
          <div
            class="chart-box"
            role="img"
            aria-label="按时间桶的请求数量堆叠柱状图"
          >
            <VChart
              :option="barOption"
              autoresize
              :update-options="{ notMerge: true }"
            />
          </div>
          <p class="chart-note muted">
            按请求开始时间统计；首尾桶裁切到当前范围。<span
              v-if="data.availability.telemetry && !total"
              >当前范围内无请求。</span
            >
          </p>
        </section>
        <section class="panel chart-panel">
          <div class="section-title">
            <h2>每请求指标</h2>
            <label
              >纵轴
              <select
                aria-label="散点纵轴指标"
                :value="metric.key"
                @change="selectMetric"
              >
                <option
                  v-for="item in chartMetrics"
                  :key="item.key"
                  :value="item.key"
                >
                  {{ item.label }}
                </option>
              </select></label
            ><label
              >显示
              <select
                aria-label="散点显示范围"
                :value="displayRange"
                @change="selectRange"
              >
                <option
                  v-for="item in chartRanges"
                  :key="item.key"
                  :value="item.key"
                >
                  {{ item.label }}
                </option>
              </select></label
            >
          </div>
          <p class="chart-summary muted" data-testid="request-scatter-summary">
            总数 {{ summary.total }} · 可绘制 {{ summary.drawable }} · 缺失
            {{ summary.missing }} · 超出显示范围 {{ summary.hidden
            }}<span v-if="summary.upper !== null">
              · 上限 {{ coordinateNumber(summary.upper) }}
              {{ metric.unit }}</span
            >
          </p>
          <div
            class="chart-box chart-crosshair-host"
            role="img"
            aria-label="每请求原始散点图"
            @mouseleave="hideCrosshair"
          >
            <VChart
              ref="scatterChart"
              :option="scatterOption"
              autoresize
              :update-options="{ notMerge: true }"
            />
            <div
              v-if="crosshair.visible"
              class="chart-crosshair"
              data-testid="chart-crosshair"
              aria-hidden="true"
            >
              <i
                class="vertical"
                :style="{
                  left: `${crosshair.left}px`,
                  top: `${plot.top}px`,
                  bottom: `${plot.bottom}px`,
                }"
              ></i>
              <i
                class="horizontal"
                :style="{
                  top: `${crosshair.top}px`,
                  left: `${plot.left}px`,
                  right: `${plot.right}px`,
                }"
              ></i>
              <span
                class="coordinate x-coordinate"
                data-testid="crosshair-x"
                :style="{
                  left: `clamp(94px, ${crosshair.left}px, calc(100% - 94px))`,
                }"
                >{{ crosshair.x }}</span
              >
              <span
                class="coordinate y-coordinate"
                data-testid="crosshair-y"
                :style="{ top: `${crosshair.top}px` }"
                >{{ crosshair.y }}</span
              >
            </div>
          </div>
          <p class="chart-note muted">
            保留每个请求的真实开始时间，不聚合、不抽样、不移动点。缺失不作
            0；零值正常绘制。<span v-if="metric.key === 'ttft'"
              >TTFT 是首个有效输出前的等待时间，缺失不作 0。</span
            ><span v-if="metric.key === 'tps'"
              >TPS 仅统计首个有效输出之后的输出阶段，不含 TTFT。</span
            ><span v-if="summary.total && !summary.drawable"
              >当前指标无可绘制数据。</span
            ><span v-if="displayRange !== 'all'"
              >仅裁剪高于当前指标百分位上限的点，同值全部保留；不改变柱状图和汇总。<span
                v-if="!summary.limited"
                >有效点少于20条，暂不裁剪。</span
              ></span
            >十字线标签表示鼠标坐标，不代表最近请求。
          </p>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.overview-charts {
  position: relative;
  min-width: 0;
  margin-bottom: var(--space-4);
}
/* 后台刷新提示浮在右上角，不占文档流，避免图表在每次自动刷新时跳动。 */
.chart-refresh-feedback {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 1;
  padding: 2px var(--space-2);
  font-size: var(--font-small);
  border-radius: 4px;
  background: var(--surface);
  pointer-events: none;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}
.chart-panel {
  margin-bottom: 0;
  min-width: 0;
}
.chart-panel > .section-title {
  min-height: 57px;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.chart-panel label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.chart-panel select {
  min-width: 0;
  max-width: 190px;
}
.chart-box {
  height: 300px;
  width: 100%;
  min-width: 0;
}
.chart-box :deep(.echarts) {
  width: 100%;
  height: 100%;
}
.chart-panel > .chart-summary {
  padding: 0 var(--space-4) var(--space-2);
  min-height: 28px;
  overflow-wrap: anywhere;
}
.chart-panel > .chart-note {
  padding: var(--space-2) var(--space-4) var(--space-3);
  font-size: var(--font-small);
  overflow-wrap: anywhere;
}
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: 0;
  margin: 0 0 var(--space-2);
  list-style: none;
  font-size: 12px;
  color: var(--muted);
}
.chart-legend li {
  display: flex;
  gap: var(--space-1);
  align-items: center;
}
.chart-legend li > span {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.chart-crosshair-host {
  position: relative;
  overflow: hidden;
}
.chart-crosshair {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.chart-crosshair i {
  position: absolute;
  display: block;
  background: var(--accent);
  opacity: 0.65;
}
.vertical {
  width: 1px;
}
.horizontal {
  height: 1px;
}
.coordinate {
  position: absolute;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 4px;
  font-size: 10px;
  white-space: nowrap;
  max-width: calc(100% - 8px);
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.x-coordinate {
  bottom: 10px;
  transform: translateX(-50%);
}
.y-coordinate {
  left: 2px;
  transform: translateY(-50%);
  max-width: 160px;
}
@media (max-width: 1000px) {
  .chart-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 420px) {
  .chart-panel > .section-title {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
