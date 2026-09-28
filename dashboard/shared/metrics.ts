/** Metadata-only measurements. Cumulative times must never be added to wall times. */
export interface PerformanceMetrics {
  attribution: 'aggregate' | 'wake' | 'request';
  wallDurationMs: number | null;
  /** Sum of known ended HTTP durations, including failures; coverage describes omissions. */
  modelDurationMs: number | null;
  modelWallDurationMs: number | null;
  /** Sum of ledger finished_at-started_at, not a wall-clock component. */
  toolDurationMs: number | null;
  toolWallDurationMs: number | null;
  /** Wake wall minus model interval union: NOT pure tool, NapCat or database latency. */
  otherDurationMs: number | null;
  modelTps: number | null;
  tpsDurationMs: number | null;
  tpsOutputTokens: number | null;
  whyIncomplete: 'not_wake' | 'source_unavailable' | 'active_or_missing_timestamps' | 'scope_crosses_wake' | null;
  roundTps: number | null;
  complete: boolean;
  coverage: { requests: number; endedRequests: number; modelDurationRequests: number; modelIntervalRequests: number; tpsRequests: number; tools: number; toolDurationTools: number };
}
export interface CacheMetrics {
  cacheHitRate: number | null;
}
export interface MetricRequest {
  started_at?: unknown; ended_at?: unknown; duration_ms?: unknown;
  /** Preserve missing interval evidence when a legacy DTO uses a display fallback timestamp. */
  interval_known?: boolean;
  status?: unknown; output_tokens?: unknown;
}
export interface MetricTool { started_at?: unknown; finished_at?: unknown }
export const metricNumber = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function intervalDuration(start: unknown, end: unknown): number | null {
  const a=metricNumber(start), b=metricNumber(end); return a!==null && b!==null && b>=a ? b-a : null;
}
export function requestDuration(r: MetricRequest): number | null {
  if(metricNumber(r.ended_at)===null || r.status==='running') return null;
  if(metricNumber(r.started_at)!==null && Number(r.ended_at)<Number(r.started_at)) return null;
  // A display fallback (e.g. startedAt=0) is not evidence of an HTTP interval.
  // Explicit measured durations remain usable even when interval metadata is missing.
  return metricNumber(r.duration_ms) ?? (r.interval_known===false ? null : intervalDuration(r.started_at,r.ended_at));
}
export function intervalUnion(intervals: Array<[number,number]>): number {
  let total=0, end=-Infinity;
  for(const [a,b] of [...intervals].sort((a,b)=>a[0]-b[0])) { total+=Math.max(0,b-Math.max(a,end)); end=Math.max(end,b); }
  return total;
}
export function performanceMetrics(requests: MetricRequest[], options: {
  attribution?: PerformanceMetrics['attribution']; tools?: MetricTool[];
  startedAt?: number; finishedAt?: number | null; sourceComplete?: boolean;
} = {}): PerformanceMetrics {
  const attribution=options.attribution??'aggregate';
  const durations=requests.map(requestDuration).filter((v):v is number=>v!==null);
  const ended=requests.filter(r=>metricNumber(r.ended_at)!==null && r.status!=='running');
  const intervals=requests.filter(r=>r.interval_known!==false && intervalDuration(r.started_at,r.ended_at)!==null && r.status!=='running').map(r=>[Number(r.started_at),Number(r.ended_at)] as [number,number]);
  // Zero-duration samples are included in both sums, not silently dropped from output.
  const reliable=requests.filter(r=>r.status==='success' && metricNumber(r.output_tokens)!==null && requestDuration(r)!==null);
  const denominator=reliable.reduce((n,r)=>n+requestDuration(r)!,0);
  const output=reliable.reduce((n,r)=>n+Number(r.output_tokens),0);
  const tools=options.tools;
  const toolIntervals=(tools??[]).filter(t=>intervalDuration(t.started_at,t.finished_at)!==null).map(t=>[Number(t.started_at),Number(t.finished_at)] as [number,number]);
  const wall=attribution==='request' ? (requests.length===1?requestDuration(requests[0]!):null) : attribution==='wake'?intervalDuration(options.startedAt,options.finishedAt):null;
  const contained=wall!==null && intervals.every(([a,b])=>a>=options.startedAt! && b<=options.finishedAt!);
  const complete=attribution==='wake' && options.sourceComplete===true && wall!==null && intervals.length===requests.length && durations.length===requests.length && contained;
  const modelWall=complete?intervalUnion(intervals):attribution==='request'?wall:null;
  return {attribution,wallDurationMs:wall,modelDurationMs:durations.length?durations.reduce((a,b)=>a+b,0):requests.length===0 && options.sourceComplete===true?0:null,
    modelWallDurationMs:modelWall,toolDurationMs:tools?(toolIntervals.length?toolIntervals.reduce((n,[a,b])=>n+b-a,0):tools.length===0?0:null):null,
    toolWallDurationMs:complete && tools!==undefined && toolIntervals.length===tools.length && toolIntervals.every(([a,b])=>a>=options.startedAt!&&b<=options.finishedAt!)?intervalUnion(toolIntervals):null,
    otherDurationMs:complete?wall!-modelWall!:null,modelTps:denominator>0?output/(denominator/1000):null,
    roundTps:complete && wall!>0 && requests.every(r=>metricNumber(r.output_tokens)!==null)?requests.reduce((n,r)=>n+Number(r.output_tokens),0)/(wall!/1000):null,
    tpsDurationMs:reliable.length?denominator:null,tpsOutputTokens:reliable.length?output:null,
    whyIncomplete:complete?null:attribution!=='wake'?'not_wake':options.sourceComplete!==true?'source_unavailable':wall===null||intervals.length!==requests.length||durations.length!==requests.length?'active_or_missing_timestamps':'scope_crosses_wake',
    complete,coverage:{requests:requests.length,endedRequests:ended.length,modelDurationRequests:durations.length,modelIntervalRequests:intervals.length,tpsRequests:reliable.length,tools:tools?.length??0,toolDurationTools:toolIntervals.length}};
}
