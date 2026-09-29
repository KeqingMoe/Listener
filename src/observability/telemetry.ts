import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { normalizeModelRequestDiagnostics } from './model-diagnostics.js';
import { REQUEST_ERRORS, normalizeUsage, type ModelRequestRecord, type ModelRequestStart, type ModelRequestInspection } from './model-usage.js';
import { sanitizeInspection } from './request-inspection.js';
import { installRequestChangeLog } from './request-change-log.js';

export interface TelemetryContext {
  groupId?: string | null;
  turnId?: string | null;
  wakeId?: string | null;
  phase?: string | null;
}

export interface TelemetryRecord extends ModelRequestRecord, TelemetryContext {}
export interface TelemetrySummary {
  requests: number; successes: number; errors: number; truncatedRequests: number;
  cacheKnownInputTokens: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens: number; reasoningTokens: number;
  missingInputUsage: number; missingCacheUsage: number;
  cacheHitRate: number | null;
}
const validTime=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER?v:null;
const int=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const text=(v:unknown,max=128):string|null=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v:null;
const RETENTION_MS=7*24*60*60*1000;
// Logical retained payload capacity, not the allocated SQLite file size.
const CAPACITY_BYTES=256*1024*1024;
// The shared sanitizer owns per-field bounds (1 MiB JSON, 64 KiB other fields).
const inspectionFields=['requestJson','responseJson','reasoningText','errorText','responseId','previousResponseId','providerRequestId','requestMode'] as const;
const inspectionBytes=`128+${['request_id','group_id','turn_id','wake_id','phase','transport','model','status','request_json','response_json','reasoning_text','error_text','response_id','previous_response_id','provider_request_id','request_mode'].map(key=>`COALESCE(length(CAST(${key} AS BLOB)),0)`).join('+')}`;
interface InspectionState { references:number; recovered:boolean; bytes:number|null; cleanedAt:number; cleanupPending?:boolean; }
// Share writer/recovery state across simultaneous stores for the same database inode.
const inspectionStores=new Map<string,InspectionState>();
export class TelemetryStore {
  private readonly db:DatabaseSync;
  private readonly secrets:readonly string[];
  private readonly inspectionKey:string;
  private readonly inspectionState:InspectionState;
  private closed=false;
  constructor(path='data/telemetry.sqlite',options:{secrets?:readonly string[]}={}) {
    this.secrets=[...(options.secrets??[])];
    if(typeof path!=='string'||!path.trim()||path.includes('\0')||path===':memory:')throw new Error('Invalid telemetry path');
    const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try {const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1)throw new Error('Invalid telemetry path');this.inspectionKey=`${s.dev}:${s.ino}`;fchmodSync(fd,0o600);} finally {closeSync(fd);}
    this.db=new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS model_requests (
        request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        duration_ms REAL NOT NULL, transport TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, error_code TEXT, http_status INTEGER,
        ttft_ms REAL, decode_duration_ms REAL,
         input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cached_input_tokens INTEGER, reasoning_tokens INTEGER,
        group_id TEXT, turn_id TEXT, phase TEXT, diagnostics TEXT
      );`);
      // Take the write lock before checking, so concurrent openers cannot both ALTER.
      const columns=this.db.prepare('PRAGMA table_info(model_requests)').all();
      if(!columns.some(column=>typeof column.name==='string'&&column.name.toLowerCase()==='diagnostics')) {
        this.db.exec('ALTER TABLE model_requests ADD COLUMN diagnostics TEXT;');
      }
      const newDecodeColumn=!columns.some(column=>column.name==='decode_duration_ms');
      for(const name of ['ttft_ms','decode_duration_ms']) if(!columns.some(column=>typeof column.name==='string'&&column.name.toLowerCase()===name)) this.db.exec(`ALTER TABLE model_requests ADD COLUMN ${name} REAL;`);
      // Changing TPS semantics invalidates cached trend points even without row writes.
      // The epoch rotation commits atomically with the nullable column migration.
      if(newDecodeColumn && this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='request_change_meta'").get()) {
        this.db.prepare('UPDATE request_change_meta SET epoch=? WHERE singleton=1').run(randomUUID());
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS model_requests_started ON model_requests(started_at);
        CREATE INDEX IF NOT EXISTS model_requests_group_started ON model_requests(group_id,started_at);
        COMMIT;`);
    } catch(error) {
      try {this.db.exec('ROLLBACK;');} catch { /* The transaction may not have started. */ }
      this.db.close();
      throw error;
    }
    this.inspectionState=inspectionStores.get(this.inspectionKey)??{references:0,recovered:false,bytes:null,cleanedAt:0};
    this.inspectionState.references++;
    inspectionStores.set(this.inspectionKey,this.inspectionState);
    // Inspection failures are deliberately private and never disable usage telemetry.
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS model_request_inspections (
        request_id TEXT PRIMARY KEY, group_id TEXT, turn_id TEXT, wake_id TEXT, phase TEXT,
        started_at INTEGER, ended_at INTEGER, transport TEXT, model TEXT, status TEXT,
        request_json TEXT, response_json TEXT, reasoning_text TEXT, error_text TEXT,
        response_id TEXT, previous_response_id TEXT, provider_request_id TEXT, request_mode TEXT,
        content_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS model_request_inspections_started ON model_request_inspections(started_at);
      CREATE INDEX IF NOT EXISTS model_request_inspections_group_response ON model_request_inspections(group_id,response_id);
      CREATE INDEX IF NOT EXISTS model_request_inspections_group_previous_response ON model_request_inspections(group_id,previous_response_id);
      CREATE INDEX IF NOT EXISTS model_request_inspections_group_turn ON model_request_inspections(group_id,turn_id);
      CREATE INDEX IF NOT EXISTS model_request_inspections_group_wake ON model_request_inspections(group_id,wake_id);`);
    } catch { /* No request contents or database errors escape inspection persistence. */ }
    // Install before beginRequest can recover running rows (and before any other writes).
    installRequestChangeLog(this.db);
  }
  beginRequest(value:ModelRequestStart & TelemetryContext):void {
    try {
      if(this.closed||!value||types.isProxy(value))return;
      const id=text(value.requestId),started=int(value.startedAt),model=text(value.model);
      if(!id||started===null||!model||!['chat','responses'].includes(value.transport))return;
      if(!this.inspectionState.recovered) {
        this.db.prepare(`UPDATE model_request_inspections SET status='interrupted',ended_at=MAX(started_at,?) WHERE status='running'`).run(Date.now());
        this.inspectionState.recovered=true;
        this.inspectionState.bytes=null;
      }
      this.persistInspection(value,'running',null,sanitizeInspection({requestJson:value.requestJson,requestMode:value.requestMode,previousResponseId:value.previousResponseId},this.secrets));
    } catch { /* Inspection capture is best effort, including hostile getters. */ }
  }
  private persistInspection(value:ModelRequestStart & TelemetryContext | TelemetryRecord,status:string,ended:number|null,inspection:ModelRequestInspection):void {
    const state=this.inspectionState;
    if(state.bytes===null)state.bytes=Number(this.db.prepare(`SELECT COALESCE(SUM(${inspectionBytes}),0) AS bytes FROM model_request_inspections`).get()!.bytes);
    const old=this.db.prepare(`SELECT status,${inspectionBytes} AS bytes FROM model_request_inspections WHERE request_id=?`).get(value.requestId);
    // Match model_requests' first-completion-wins semantics; duplicate starts do not reset data.
    if(old&&(status==='running'||old.status!=='running'))return;
    this.db.prepare(`INSERT INTO model_request_inspections
      (request_id,group_id,turn_id,wake_id,phase,started_at,ended_at,transport,model,status,request_json,response_json,reasoning_text,error_text,response_id,previous_response_id,provider_request_id,request_mode,content_truncated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET
        group_id=COALESCE(excluded.group_id,group_id),turn_id=COALESCE(excluded.turn_id,turn_id),
        wake_id=COALESCE(excluded.wake_id,wake_id),phase=COALESCE(excluded.phase,phase),
        ended_at=excluded.ended_at,status=excluded.status,
        request_json=COALESCE(excluded.request_json,request_json),response_json=excluded.response_json,
        reasoning_text=excluded.reasoning_text,error_text=excluded.error_text,response_id=excluded.response_id,
        previous_response_id=COALESCE(excluded.previous_response_id,previous_response_id),provider_request_id=excluded.provider_request_id,
        request_mode=COALESCE(excluded.request_mode,request_mode),content_truncated=MAX(content_truncated,excluded.content_truncated)`)
      .run(value.requestId,text(value.groupId,64),text(value.turnId),text(value.wakeId),text(value.phase,64),value.startedAt,ended,value.transport,value.model,status,
        ...inspectionFields.map(key=>inspection[key]??null),inspection.contentTruncated?1:0);
    const next=this.db.prepare(`SELECT ${inspectionBytes} AS bytes FROM model_request_inspections WHERE request_id=?`).get(value.requestId)!;
    state.bytes+=Number(next.bytes)-Number(old?.bytes??0);
    this.cleanupInspections();
  }
  private cleanupInspections():void {
    const state=this.inspectionState,now=Date.now();
    if(!state.cleanupPending&&now-state.cleanedAt<60_000&&(state.bytes??0)<=CAPACITY_BYTES)return;
    // Retention/capacity are incremental targets, not an unbounded synchronous
    // sweep: a backlog continues in bounded batches on subsequent writes.
    // One transaction avoids one fsync per removed row. Secure deletion work is
    // additionally limited by payload bytes and a cooperative time check.
    const over=(state.bytes??0)>CAPACITY_BYTES,started=performance.now();
    let nextBytes=state.bytes??0,removedBytes=0,processed=0;
    let transaction=false;
    try {
      this.db.exec('BEGIN IMMEDIATE;');transaction=true;
      const rows=this.db.prepare(`SELECT request_id,${inspectionBytes} AS bytes FROM model_request_inspections ${over?'':'WHERE started_at<?'} ORDER BY started_at LIMIT 64`).all(...(over?[]:[now-RETENTION_MS]));
      const remove=this.db.prepare('DELETE FROM model_request_inspections WHERE request_id=?');
      for(const row of rows) {
        if(over&&nextBytes<=CAPACITY_BYTES)break;
        if(processed>0&&(removedBytes+Number(row.bytes)>8*1024*1024||performance.now()-started>=20))break;
        remove.run(row.request_id as string);processed++;
        removedBytes+=Number(row.bytes);nextBytes=Math.max(0,nextBytes-Number(row.bytes));
      }
      this.db.exec('COMMIT;');transaction=false;
      // Publish accounting only after successful commit; rollback must leave it unknown.
      state.bytes=nextBytes;
      state.cleanupPending=processed<rows.length||rows.length===64;
      state.cleanedAt=now;
    } catch {
      if(transaction)try{this.db.exec('ROLLBACK;');}catch{/* No private database errors escape. */}
      state.bytes=null;state.cleanupPending=false;state.cleanedAt=now;
    }
  }
  record(value:TelemetryRecord):void {
    if(this.closed)throw new Error('Telemetry store closed');
    if(value===null||typeof value!=='object'||types.isProxy(value))throw new Error('Invalid telemetry record');
    const id=text(value.requestId,128), model=text(value.model,128), transport=value.transport, status=value.status;
    const started=int(value.startedAt), ended=int(value.endedAt), duration=value.durationMs;
    if(!id||!model||started===null||ended===null||typeof duration!=='number'||!Number.isFinite(duration)||duration<0||duration>Number.MAX_SAFE_INTEGER||ended<started||!['chat','responses'].includes(transport)||!['success','error'].includes(status))throw new Error('Invalid telemetry record');
    let ttft=validTime(value.ttftMs),decode=validTime(value.decodeDurationMs);
    if(ttft!==null&&ttft>duration)ttft=null;
    if(decode!==null&&(decode>duration||(ttft!==null&&ttft+decode>duration)))decode=null;
    const u=normalizeUsage(value.usage), error=value.errorCode??null, http=value.httpStatus===undefined?null:int(value.httpStatus);
    if(error!==null&&!REQUEST_ERRORS.includes(error))throw new Error('Invalid telemetry error');
    if(value.httpStatus!==undefined&&(http===null||http<100||http>599))throw new Error('Invalid telemetry status');
    const descriptor=Object.getOwnPropertyDescriptor(value,'diagnostics');
    const diagnostics=normalizeModelRequestDiagnostics(descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined);
    this.db.prepare(`INSERT OR IGNORE INTO model_requests(request_id,started_at,ended_at,duration_ms,transport,model,status,error_code,http_status,input_tokens,output_tokens,total_tokens,cached_input_tokens,reasoning_tokens,group_id,turn_id,phase,diagnostics,ttft_ms,decode_duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,started,ended,duration,transport,model,status,error,http,u.inputTokens??null,u.outputTokens??null,u.totalTokens??null,u.cachedInputTokens??null,u.reasoningTokens??null,text(value.groupId,64),text(value.turnId,128),text(value.phase,64),diagnostics?JSON.stringify(diagnostics):null,ttft,decode);
    try {
      this.persistInspection(value,status,ended,sanitizeInspection(value.inspection??{},this.secrets));
    } catch { /* Inspection failures must not change existing record semantics. */ }
  }
  summarize(options:{since:number;until:number;groupId?:string}):TelemetrySummary {
    if(this.closed)throw new Error('Telemetry store closed');
    if(int(options.since)===null||int(options.until)===null||options.since>options.until)throw new Error('Invalid telemetry range');
    const group=text(options.groupId,64);
    if(options.groupId!==undefined&&!group)throw new Error('Invalid telemetry group');
    const where=group?'started_at>=? AND started_at<=? AND group_id=?':'started_at>=? AND started_at<=?';
    const args=group?[options.since,options.until,group]:[options.since,options.until];
    const row=this.db.prepare(`SELECT COUNT(*) requests,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,SUM(CASE WHEN error_code='truncated_response' THEN 1 ELSE 0 END) truncatedRequests,SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) cacheKnownInputTokens,SUM(COALESCE(input_tokens,0)) inputTokens,SUM(COALESCE(output_tokens,0)) outputTokens,SUM(COALESCE(total_tokens,0)) totalTokens,SUM(COALESCE(cached_input_tokens,0)) cachedInputTokens,SUM(COALESCE(reasoning_tokens,0)) reasoningTokens,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) missingInputUsage,SUM(CASE WHEN cached_input_tokens IS NULL THEN 1 ELSE 0 END) missingCacheUsage FROM model_requests WHERE ${where}`).get(...args) as Record<string,unknown>;
    const input=int(row.inputTokens)??0, cached=int(row.cachedInputTokens)??0;
    return {requests:int(row.requests)??0,successes:int(row.successes)??0,errors:int(row.errors)??0,truncatedRequests:int(row.truncatedRequests)??0,cacheKnownInputTokens:int(row.cacheKnownInputTokens)??0,inputTokens:input,outputTokens:int(row.outputTokens)??0,totalTokens:int(row.totalTokens)??0,cachedInputTokens:cached,reasoningTokens:int(row.reasoningTokens)??0,missingInputUsage:int(row.missingInputUsage)??0,missingCacheUsage:int(row.missingCacheUsage)??0,cacheHitRate:typeof row.cacheKnownInputTokens==='number'&&row.cacheKnownInputTokens>0?cached/row.cacheKnownInputTokens:null};
  }
  close():void {if(!this.closed){this.closed=true;try{this.db.close();}finally{if(--this.inspectionState.references===0)inspectionStores.delete(this.inspectionKey);}}}
}
