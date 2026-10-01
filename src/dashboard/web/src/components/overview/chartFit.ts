import type { RequestTrendPoint } from '../../../../contracts/request-trends';
import { metricValue, type ChartMetric } from './chartMetrics';

/** 固定小邻域，不能随着点数扩成全局窗口。 */
export const FIT_WINDOW = 9;
export const FIT_MIN_SAMPLES = 5;
export const FIT_DROP_RATIO = 0.1;
export const FIT_DROP_TOKENS = 2048;
export const FIT_GAP_MS = 30 * 60 * 1000;
export const FIT_GAP_INTERVALS = 5;

type Datum = [number, number | null];

type Sample = {
  at: number;
  total: number | null;
  value: number | null;
};

type KnownSample = Sample & { total: number; value: number };

export function supportsFit(metric: ChartMetric): boolean {
  return metric.key === 'totalInput' || metric.key === 'cachedInput';
}

/** 不接受旧版无key点、损坏的JSON、非二元组或空标识符；绝不回退到公共群。 */
function groupOf(point: RequestTrendPoint): string | null {
  if (!('key' in point) || typeof point.key !== 'string') {
    return null;
  }
  try {
    const key: unknown = JSON.parse(point.key);
    return Array.isArray(key) &&
      key.length === 2 &&
      key.every((part: unknown) => typeof part === 'string' && part.length > 0)
      ? (key[0] as string)
      : null;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]!
    : values[middle - 1]! / 2 + values[middle]! / 2;
}

/**
 * Theil–Sen局部直线：最多36个两点斜率的中位数，再取截距中位数。
 * 对孤立低命中点稳健，同时对真实时间上的线性上升/下降保真（不是移动中位数平台）。
 * 平移/缩放时间避免epoch量级影响；重复时间不贡献斜率，全重复退化为局部中位数。
 * 不强制单调；将数值外推的负tokens裁至0，缓存值另按当前点总输入作上界。
 */
function localFit(
  samples: readonly KnownSample[],
  index: number,
): number | null {
  const start = Math.max(
    0,
    Math.min(index - Math.floor(FIT_WINDOW / 2), samples.length - FIT_WINDOW),
  );
  const window = samples.slice(start, start + FIT_WINDOW);
  const at = samples[index]!.at;
  const radius = Math.max(
    1,
    ...window.map((sample) => Math.abs(sample.at - at)),
  );
  const xs = window.map((sample) => (sample.at - at) / radius);
  const slopes: number[] = [];
  for (let i = 0; i < window.length; i++) {
    for (let j = i + 1; j < window.length; j++) {
      const dx = xs[j]! - xs[i]!;
      if (dx !== 0) {
        const slope = (window[j]!.value - window[i]!.value) / dx;
        if (Number.isFinite(slope)) {
          slopes.push(slope);
        }
      }
    }
  }
  const slope = slopes.length ? median(slopes) : 0;
  const fitted = median(
    window.map((sample, i) => sample.value - slope * xs[i]!),
  );
  return Number.isFinite(fitted) ? Math.max(0, fitted) : null;
}

/**
 * 仅总输入/缓存输入的按群分段拟合，输出每个真实时间戳，不创建插值时间点。
 * 总输入相邻下降同时>=10%且>=2048 tokens是分段启发式，并非确切的上下文压缩检测。
 * 缓存短暂低命中本身不会断段。正相邻间隔的群内中位数用于识别长gap：
 * 同时>=30分钟且>=5倍中位间隔；重复时间不参与间隔基线。
 * 缺失/非法总输入或目标指标也断段，避免跨未知数据拟合；不足5点段原位输出null。
 * 少于两个非null拟合位置的群不返回。
 * 段间在新段首个真实时间戳额外插入null，渲染方必须保持connectNulls=false。
 * 不修改points；排序O(n log n)，固定9点窗口拟合O(n)，空间O(n)。
 */
export function fitLines(
  points: readonly RequestTrendPoint[],
  metric: ChartMetric,
): Array<{ groupId: string; data: Array<[number, number | null]> }> {
  if (!supportsFit(metric)) {
    return [];
  }
  const groups = new Map<string, Sample[]>();
  for (const point of points) {
    const groupId = groupOf(point);
    if (groupId === null || !Number.isFinite(point.startedAt)) {
      continue;
    }
    const total = point.totalInputTokens;
    const sample: Sample = {
      at: point.startedAt,
      total:
        total != null && Number.isFinite(total) && total >= 0 ? total : null,
      value: metricValue(point, metric),
    };
    const group = groups.get(groupId);
    if (group) {
      group.push(sample);
    } else {
      groups.set(groupId, [sample]);
    }
  }
  return [...groups].flatMap(([groupId, samples]) => {
    samples.sort((a, b) => a.at - b.at);
    const intervals: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const interval = samples[i]!.at - samples[i - 1]!.at;
      if (interval > 0) {
        intervals.push(interval);
      }
    }
    const gap = Math.max(
      FIT_GAP_MS,
      FIT_GAP_INTERVALS * (intervals.length ? median(intervals) : Infinity),
    );
    const data: Datum[] = [];
    let segment: KnownSample[] = [];
    const flush = () => {
      for (let i = 0; i < segment.length; i++) {
        const fitted =
          segment.length >= FIT_MIN_SAMPLES ? localFit(segment, i) : null;
        data.push([
          segment[i]!.at,
          fitted !== null && metric.key === 'cachedInput'
            ? Math.min(fitted, segment[i]!.total)
            : fitted,
        ]);
      }
      segment = [];
    };
    for (const sample of samples) {
      if (sample.total === null || sample.value === null) {
        flush();
        data.push([sample.at, null]);
        continue;
      }
      const previous = segment.at(-1);
      if (
        previous &&
        (sample.at - previous.at >= gap ||
          (previous.total - sample.total >= FIT_DROP_TOKENS &&
            previous.total - sample.total >= previous.total * FIT_DROP_RATIO))
      ) {
        flush();
        data.push([sample.at, null]);
      }
      segment.push({ ...sample, total: sample.total, value: sample.value });
    }
    flush();
    return data.filter(([, value]) => value !== null).length >= 2
      ? [{ groupId, data }]
      : [];
  });
}
