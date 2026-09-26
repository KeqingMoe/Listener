import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { REQUEST_ERRORS, normalizeUsage, type ModelRequestRecord } from './model-usage.js';

export interface TelemetryRecord extends ModelRequestRecord {
  groupId?: string | null;
  turnId?: string | null;
  phase?: string | null;
}
export interface TelemetrySummary {
  requests: number; successes: number; errors: number; truncatedRequests: number;
  cacheKnownInputTokens: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens: number; reasoningTokens: number;
  knownInputRequests: number; cachedInputRequests: number;
  missingInputUsage: number; missingCacheUsage: number;
  cacheCoverage: number; cacheHitRate: number | null;
}
const int=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const text=(v:unknown,max=128):string|null=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v:null;
export class TelemetryStore {
  private readonly db:DatabaseSync;
  private closed=false;
  constructor(path='data/telemetry.sqlite') {
    if(typeof path!=='string'||!path.trim()||path.includes('\0')||path===':memory:')throw new Error('Invalid telemetry path');
    const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try {const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1)throw new Error('Invalid telemetry path');fchmodSync(fd,0o600);} finally {closeSync(fd);}
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS model_requests (
        request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        duration_ms REAL NOT NULL, transport TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, error_code TEXT, http_status INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cached_input_tokens INTEGER, reasoning_tokens INTEGER,
        group_id TEXT, turn_id TEXT, phase TEXT
      );
      CREATE INDEX IF NOT EXISTS model_requests_started ON model_requests(started_at);
      CREATE INDEX IF NOT EXISTS model_requests_group_started ON model_requests(group_id,started_at);`);
  }
  record(value:TelemetryRecord):void {
    if(this.closed)throw new Error('Telemetry store closed');
    const id=text(value.requestId,128), model=text(value.model,128), transport=value.transport, status=value.status;
    const started=int(value.startedAt), ended=int(value.endedAt), duration=value.durationMs;
    if(!id||!model||started===null||ended===null||typeof duration!=='number'||!Number.isFinite(duration)||duration<0||duration>Number.MAX_SAFE_INTEGER||ended<started||!['chat','responses'].includes(transport)||!['success','error'].includes(status))throw new Error('Invalid telemetry record');
    const u=normalizeUsage(value.usage), error=value.errorCode??null, http=value.httpStatus===undefined?null:int(value.httpStatus);
    if(error!==null&&!REQUEST_ERRORS.includes(error))throw new Error('Invalid telemetry error');
    if(value.httpStatus!==undefined&&(http===null||http<100||http>599))throw new Error('Invalid telemetry status');
    this.db.prepare(`INSERT OR IGNORE INTO model_requests(request_id,started_at,ended_at,duration_ms,transport,model,status,error_code,http_status,input_tokens,output_tokens,total_tokens,cached_input_tokens,reasoning_tokens,group_id,turn_id,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,started,ended,duration,transport,model,status,error,http,u.inputTokens??null,u.outputTokens??null,u.totalTokens??null,u.cachedInputTokens??null,u.reasoningTokens??null,text(value.groupId,64),text(value.turnId,128),text(value.phase,64));
  }
  summarize(options:{since:number;until:number;groupId?:string}):TelemetrySummary {
    if(this.closed)throw new Error('Telemetry store closed');
    if(int(options.since)===null||int(options.until)===null||options.since>options.until)throw new Error('Invalid telemetry range');
    const group=text(options.groupId,64);
    if(options.groupId!==undefined&&!group)throw new Error('Invalid telemetry group');
    const where=group?'started_at>=? AND started_at<=? AND group_id=?':'started_at>=? AND started_at<=?';
    const args=group?[options.since,options.until,group]:[options.since,options.until];
    const row=this.db.prepare(`SELECT COUNT(*) requests,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,SUM(CASE WHEN error_code='truncated_response' THEN 1 ELSE 0 END) truncatedRequests,SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) cacheKnownInputTokens,SUM(COALESCE(input_tokens,0)) inputTokens,SUM(COALESCE(output_tokens,0)) outputTokens,SUM(COALESCE(total_tokens,0)) totalTokens,SUM(COALESCE(cached_input_tokens,0)) cachedInputTokens,SUM(COALESCE(reasoning_tokens,0)) reasoningTokens,SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) knownInputRequests,SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN 1 ELSE 0 END) cachedInputRequests,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) missingInputUsage,SUM(CASE WHEN cached_input_tokens IS NULL THEN 1 ELSE 0 END) missingCacheUsage FROM model_requests WHERE ${where}`).get(...args) as Record<string,unknown>;
    const input=int(row.inputTokens)??0, cached=int(row.cachedInputTokens)??0, known=int(row.knownInputRequests)??0;
    return {requests:int(row.requests)??0,successes:int(row.successes)??0,errors:int(row.errors)??0,truncatedRequests:int(row.truncatedRequests)??0,cacheKnownInputTokens:int(row.cacheKnownInputTokens)??0,inputTokens:input,outputTokens:int(row.outputTokens)??0,totalTokens:int(row.totalTokens)??0,cachedInputTokens:cached,reasoningTokens:int(row.reasoningTokens)??0,knownInputRequests:known,cachedInputRequests:int(row.cachedInputRequests)??0,missingInputUsage:int(row.missingInputUsage)??0,missingCacheUsage:int(row.missingCacheUsage)??0,cacheCoverage:known?((int(row.cachedInputRequests)??0)/known):0,cacheHitRate:typeof row.cacheKnownInputTokens==='number'&&row.cacheKnownInputTokens>0?cached/row.cacheKnownInputTokens:null};
  }
  close():void {if(!this.closed){this.closed=true;this.db.close();}}
}
