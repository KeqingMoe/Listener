/** 仅基于元数据的性能度量。累计耗时绝不能与墙钟耗时相加。 */
export interface PerformanceMetrics {
  attribution: 'aggregate' | 'wake' | 'request';
  wallDurationMs: number | null;
  /** 已知已结束HTTP请求的耗时之和，包含失败请求；缺失情况由coverage描述。 */
  modelDurationMs: number | null;
  modelWallDurationMs: number | null;
  /** 工具ledger中finished_at-started_at之和，不是墙钟时间的组成部分。 */
  toolDurationMs: number | null;
  toolWallDurationMs: number | null;
  /** wake墙钟时间减去模型请求区间并集，并非纯粹的工具、NapCat或数据库延迟。 */
  otherDurationMs: number | null;
  tps: number | null;
  ttftMs: number | null;
  decodeDurationMs: number | null;
  decodeOutputTokens: number | null;
  whyIncomplete:
    | 'not_wake'
    | 'source_unavailable'
    | 'active_or_missing_timestamps'
    | 'scope_crosses_wake'
    | null;
  complete: boolean;
  coverage: {
    requests: number;
    endedRequests: number;
    modelDurationRequests: number;
    modelIntervalRequests: number;
    tpsRequests: number;
    ttftRequests: number;
    tools: number;
    toolDurationTools: number;
  };
}

export interface CacheMetrics {
  cacheHitRate: number | null;
}

export interface MetricRequest {
  started_at?: unknown;
  ended_at?: unknown;
  duration_ms?: unknown;
  /** DTO使用展示用的回退时间戳时，以false标记区间实际未知。 */
  interval_known?: boolean;
  status?: unknown;
  output_tokens?: unknown;
  ttft_ms?: unknown;
  decode_duration_ms?: unknown;
}

export interface MetricTool {
  started_at?: unknown;
  finished_at?: unknown;
}

export const metricNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function intervalDuration(start: unknown, end: unknown): number | null {
  const a = metricNumber(start),
    b = metricNumber(end);
  return a !== null && b !== null && b >= a ? b - a : null;
}

export function requestDuration(r: MetricRequest): number | null {
  if (metricNumber(r.ended_at) === null || r.status === 'running') {
    return null;
  }
  if (
    metricNumber(r.started_at) !== null &&
    Number(r.ended_at) < Number(r.started_at)
  ) {
    return null;
  }
  // 展示用回退值（如startedAt=0）不能证明HTTP区间存在；显式测得的duration在缺少区间元数据时仍可用。
  return (
    metricNumber(r.duration_ms) ??
    (r.interval_known === false
      ? null
      : intervalDuration(r.started_at, r.ended_at))
  );
}

/** 区间并集总长度，重叠或嵌套的部分只计一次。 */
export function intervalUnion(intervals: Array<[number, number]>): number {
  let total = 0,
    end = -Infinity;
  for (const [a, b] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

export function performanceMetrics(
  requests: MetricRequest[],
  options: {
    attribution?: PerformanceMetrics['attribution'];
    tools?: MetricTool[];
    startedAt?: number;
    finishedAt?: number | null;
    sourceComplete?: boolean;
  } = {},
): PerformanceMetrics {
  const attribution = options.attribution ?? 'aggregate';
  const durations = requests
    .map(requestDuration)
    .filter((v): v is number => v !== null);
  const ended = requests.filter(
    (r) => metricNumber(r.ended_at) !== null && r.status !== 'running',
  );
  const intervals = requests
    .filter(
      (r) =>
        r.interval_known !== false &&
        intervalDuration(r.started_at, r.ended_at) !== null &&
        r.status !== 'running',
    )
    .map((r) => [Number(r.started_at), Number(r.ended_at)] as [number, number]);
  // 输出token只与有效的decode样本（完成时刻减首个输出时刻）配对计算TPS，不使用旧的计时字段。
  const reliable = requests.filter(
    (r) =>
      r.status === 'success' &&
      metricNumber(r.output_tokens) !== null &&
      requestDuration(r) !== null &&
      metricNumber(r.ttft_ms) !== null &&
      metricNumber(r.decode_duration_ms) !== null &&
      Number(r.decode_duration_ms) > 0 &&
      Number(r.ttft_ms) + Number(r.decode_duration_ms) <= requestDuration(r)!,
  );
  const ttftSamples = requests.filter(
    (r) =>
      metricNumber(r.ttft_ms) !== null &&
      requestDuration(r) !== null &&
      Number(r.ttft_ms) <= requestDuration(r)!,
  );
  const denominator = reliable.reduce(
    (n, r) => n + Number(r.decode_duration_ms),
    0,
  );
  const output = reliable.reduce((n, r) => n + Number(r.output_tokens), 0);
  const tools = options.tools;
  const toolIntervals = (tools ?? [])
    .filter((t) => intervalDuration(t.started_at, t.finished_at) !== null)
    .map(
      (t) => [Number(t.started_at), Number(t.finished_at)] as [number, number],
    );
  const wall =
    attribution === 'request'
      ? requests.length === 1
        ? requestDuration(requests[0]!)
        : null
      : attribution === 'wake'
        ? intervalDuration(options.startedAt, options.finishedAt)
        : null;
  const contained =
    wall !== null &&
    intervals.every(
      ([a, b]) => a >= options.startedAt! && b <= options.finishedAt!,
    );
  const complete =
    attribution === 'wake' &&
    options.sourceComplete === true &&
    wall !== null &&
    intervals.length === requests.length &&
    durations.length === requests.length &&
    contained;
  const modelWall = complete
    ? intervalUnion(intervals)
    : attribution === 'request'
      ? wall
      : null;
  return {
    attribution,
    wallDurationMs: wall,
    modelDurationMs: durations.length
      ? durations.reduce((a, b) => a + b, 0)
      : requests.length === 0 && options.sourceComplete === true
        ? 0
        : null,
    modelWallDurationMs: modelWall,
    toolDurationMs: tools
      ? toolIntervals.length
        ? toolIntervals.reduce((n, [a, b]) => n + b - a, 0)
        : tools.length === 0
          ? 0
          : null
      : null,
    toolWallDurationMs:
      complete &&
      tools !== undefined &&
      toolIntervals.length === tools.length &&
      toolIntervals.every(
        ([a, b]) => a >= options.startedAt! && b <= options.finishedAt!,
      )
        ? intervalUnion(toolIntervals)
        : null,
    otherDurationMs: complete ? wall! - modelWall! : null,
    tps: denominator > 0 ? output / (denominator / 1000) : null,
    ttftMs: ttftSamples.length
      ? ttftSamples.reduce((n, r) => n + Number(r.ttft_ms), 0) /
        ttftSamples.length
      : null,
    decodeDurationMs: reliable.length ? denominator : null,
    decodeOutputTokens: reliable.length ? output : null,
    whyIncomplete: complete
      ? null
      : attribution !== 'wake'
        ? 'not_wake'
        : options.sourceComplete !== true
          ? 'source_unavailable'
          : wall === null ||
              intervals.length !== requests.length ||
              durations.length !== requests.length
            ? 'active_or_missing_timestamps'
            : 'scope_crosses_wake',
    complete,
    coverage: {
      requests: requests.length,
      endedRequests: ended.length,
      modelDurationRequests: durations.length,
      modelIntervalRequests: intervals.length,
      tpsRequests: reliable.length,
      ttftRequests: ttftSamples.length,
      tools: tools?.length ?? 0,
      toolDurationTools: toolIntervals.length,
    },
  };
}
