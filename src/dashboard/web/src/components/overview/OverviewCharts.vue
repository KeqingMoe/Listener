<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { useRequestTrends } from '../../composables/useRequestTrends';
import {
  chartDots,
  chartMetrics,
  chartRanges,
  chartScales,
  resolveChartDots,
  resolveChartRange,
  resolveChartScale,
  supportsLog,
  TREND_MIN_SAMPLES,
  TREND_WINDOW_BUCKETS,
  type ScatterView,
  coordinateNumber,
  coordinateTime,
  outcomes,
  resolveMetric,
  scatterSummary,
} from './chartMetrics';
import { chartOptions, plot } from './chartOptions';

use([
  CanvasRenderer,
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
]);
const route = useRoute();
const router = useRouter();
const { data, loading, error, retry } = useRequestTrends();
const metric = computed(() => resolveMetric(route.query.chartMetric));
const view = computed<ScatterView>(() => ({
  range: resolveChartRange(route.query.chartRange),
  scale: resolveChartScale(route.query.chartScale, metric.value),
  dots: resolveChartDots(route.query.chartDots),
}));
const displayRange = computed(() => view.value.range);
const windowLabel = computed(() => {
  const minutes = ((data.value?.bucketMs ?? 0) * TREND_WINDOW_BUCKETS) / 60000;
  return minutes >= 60
    ? `${coordinateNumber(minutes / 60)} 小时`
    : `${coordinateNumber(minutes)} 分钟`;
});

/** 视图选项保存在URL中；默认值不写入，保持链接简短。 */
function setView(
  key: 'chartRange' | 'chartScale' | 'chartDots',
  value: string,
) {
  const defaults = {
    chartRange: 'all',
    chartScale: 'linear',
    chartDots: 'fine',
  };
  void router.replace({
    query: {
      ...route.query,
      [key]: value === defaults[key] ? undefined : value,
    },
  });
}

/** 每个选项是一个按钮，点击依次切换到下一个可用值，避免多组按钮在窄屏换行。 */
function cycle<K extends string>(
  options: readonly { key: K; label: string }[],
  current: K,
  available: (key: K) => boolean = () => true,
) {
  const usable = options.filter((option) => available(option.key));
  const index = usable.findIndex((option) => option.key === current);
  const next = usable[(index + 1) % usable.length]!;
  return {
    current: options.find((option) => option.key === current)!.label,
    next: usable.length > 1 ? next.key : null,
  };
}

const controls = computed(() => [
  {
    key: 'chartScale' as const,
    label: '散点纵轴刻度',
    name: '刻度',
    title: supportsLog(metric.value) ? undefined : '百分比指标不提供对数刻度',
    ...cycle(chartScales, view.value.scale, (key) =>
      key === 'linear' ? true : supportsLog(metric.value),
    ),
  },
  {
    key: 'chartRange' as const,
    label: '散点显示范围',
    name: '范围',
    title: '保留中间95%或99%，两端等量裁剪，边界同值保留',
    ...cycle(chartRanges, view.value.range),
  },
  {
    key: 'chartDots' as const,
    label: '散点样式',
    name: '点',
    title: '细点适合密集数据，粗点适合稀疏数据',
    ...cycle(chartDots, view.value.dots),
  },
]);

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
        view.value,
      )
    : {},
);
const summary = computed(() =>
  scatterSummary(
    data.value?.points ?? [],
    metric.value,
    view.value.range,
    view.value.scale,
  ),
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
watch([metric, data, view], hideCrosshair);
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
    <div v-if="error" class="panel data-state" role="alert">
      <span class="error"
        >{{ data ? '图表数据已过期，更新失败：' : '请求趋势加载失败：'
        }}{{ error }}</span
      >
      <button type="button" @click="retry">重试图表</button>
    </div>
    <!-- 汇总指标由页面通过插槽传入，不随图表数据加载而出现或移动。 -->
    <div class="chart-top">
      <div class="chart-top-side"><slot name="side" /></div>
      <div v-if="loading && !data" class="panel data-state" role="status">
        正在加载请求趋势…
      </div>
      <section v-if="data" class="panel chart-panel trend-panel">
        <div class="section-title"><h2>请求数量趋势</h2></div>
        <p class="chart-summary muted" data-testid="request-trends-summary">
          总数 {{ total }} · {{ data.buckets.length }} 时间桶 · 每桶约
          {{ coordinateNumber(data.bucketMs / 1000) }} 秒
        </p>
        <p
          v-if="!data.availability.telemetry"
          class="chart-summary muted"
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
        <div
          class="chart-box trend-box"
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
    </div>
    <template v-if="data">
      <section class="panel chart-panel scatter-panel">
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
          >
          <div class="chart-controls">
            <button
              v-for="control in controls"
              :key="control.key"
              type="button"
              class="cycle"
              :aria-label="`${control.label}：${control.current}，点击切换`"
              :title="control.title"
              :disabled="control.next === null"
              @click="control.next && setView(control.key, control.next)"
            >
              <span class="muted">{{ control.name }}</span>
              {{ control.current }}
            </button>
          </div>
        </div>
        <p class="chart-summary muted" data-testid="request-scatter-summary">
          总数 {{ summary.total }} · 可绘制 {{ summary.drawable }} · 缺失
          {{ summary.missing }} · 低于下限 {{ summary.below }} · 高于上限
          {{ summary.above
          }}<span v-if="summary.unplottable">
            · 对数轴无法显示的零值 {{ summary.unplottable }}</span
          ><span v-if="summary.lower !== null">
            · 下限 {{ coordinateNumber(summary.lower) }} {{ metric.unit }}</span
          ><span v-if="summary.upper !== null">
            · 上限 {{ coordinateNumber(summary.upper) }} {{ metric.unit }}</span
          >
        </p>
        <div
          class="chart-box scatter-box chart-crosshair-host"
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
            >两端各裁去
            {{
              displayRange === 'p95' ? '2.5%' : '0.5%'
            }}，按样本数向下取整，边界同值全部保留；不改变柱状图和汇总。<span
              v-if="!summary.limited"
              >有效点少于20条，暂不裁剪。</span
            ></span
          >实线为中位数、虚线为 P95，按约
          {{ windowLabel }} 的滑动窗口统计（样本少于
          {{ TREND_MIN_SAMPLES.median }} /
          {{ TREND_MIN_SAMPLES.p95 }} 条时断开），包含被裁剪的点；P95
          线与纵轴裁剪的百分位上限不是同一个值。十字线标签表示鼠标坐标，不代表最近请求。
        </p>
      </section>
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
/* 上方：左侧汇总指标，右侧请求量趋势；散点图单独占满一行。 */
.chart-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: stretch;
  margin-bottom: var(--space-4);
}
.chart-top-side {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* 左侧指标卡与右侧趋势图等高：两边都拉伸到同一行高，图表填满面板剩余空间。 */
.chart-top-side > :deep(.metric-panel) {
  flex: 1;
}
.trend-panel {
  display: flex;
  flex-direction: column;
}
.trend-panel > .trend-box {
  flex: 1;
  min-height: 180px;
  height: auto;
}
.chart-controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.cycle {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  font-variant-numeric: tabular-nums;
}
.cycle:disabled {
  cursor: not-allowed;
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
.scatter-box {
  height: 440px;
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
  gap: var(--space-1) var(--space-3);
  padding: 0 var(--space-4);
  margin: 0 0 var(--space-1);
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
  .chart-top {
    grid-template-columns: minmax(0, 1fr);
  }
  .scatter-box {
    height: 340px;
  }
}
@media (max-width: 420px) {
  .chart-controls {
    gap: var(--space-1);
  }
  .chart-panel > .section-title {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
