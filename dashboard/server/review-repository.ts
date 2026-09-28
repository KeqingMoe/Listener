import { DatabaseSync } from 'node:sqlite';
import { performanceMetrics, intervalDuration, requestDuration } from '../shared/metrics.js';
import { lstatSync } from 'node:fs';
import { sanitizeInspectionValue } from '../../src/request-inspection.js';
import { SESSION_PHYSICAL_TURN } from '../../src/session-inspection-indexes.js';
import { normalizeModelRequestDiagnostics } from '../../src/model-diagnostics.js';
import { Repository, ResourceLimit, summarize } from './repository.js';
import { requestOutcome, toolOutcome, toolReason } from '../shared/outcomes.js';
import { eventTitle } from '../shared/event-labels.js';
import type { Range, WakeItem } from '../shared/contracts.js';
import type { ReviewRequest, ReviewTool, RequestReviewDetail, WakeReviewDetail, HealthResponse, ReviewEvent } from '../shared/review.js';
type Row = Record<string, any>;
type Scope = { requestIds?: string[]; turnIds?: string[]; wakeIds?: string[] };
type ContentBudget = { remaining: number; truncated: boolean };
const newBudget = (): ContentBudget => ({remaining:8*1024*1024,truncated:false});
/** Iterate instead of materializing hundreds of potentially large rows. */
function collectContent(iterator: Iterable<Row>, count: number, budget: ContentBudget): Row[] {
  const rows:Row[]=[];
  for(const row of iterator){const bytes=Buffer.byteLength(JSON.stringify(row));if(rows.length>=count||bytes>budget.remaining){budget.truncated=true;break;}budget.remaining-=bytes;rows.push(row);}
  return rows;
}
const n = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const s = (v: unknown): string | null => typeof v === 'string' && v.length ? v : null;
const parse = (v: unknown): any => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return v; } };
const columns = (db: DatabaseSync, table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => String(r.name)));
const cap = (rows: Row[]) => { if (rows.length > 10000) throw new ResourceLimit(); return rows; };
// Exact, reviewed lifecycle/connection diagnostics emitted by the local logger.
// Null-group tool/message events are never promoted into global visibility.
const GLOBAL_REVIEW_EVENTS = [
  'app.start','app.stopping','app.stopped','app.startup_failed','app.shutdown_failed',
  'app.faces_ready','app.reactions_ready','app.diagnostics_unavailable','app.registry_failed',
  'app.group_discovery_failed','app.group_cleanup_failed','app.custom_faces_close_failed',
  'onebot.connecting','onebot.ready','onebot.disconnected','onebot.connection_failed',
  'onebot.reconnect_scheduled','onebot.heartbeat_timeout','onebot.identity_failed','onebot.api_failed',
];
const fields = ['request_id','group_id','turn_id','wake_id','model','transport','started_at','ended_at','duration_ms','status','error_code','http_status','input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','response_id','previous_response_id','provider_request_id','request_mode','content_truncated','diagnostics'];
export class ReviewRepository {
  constructor(readonly base: Repository) {}
  private clean(value: unknown) { return sanitizeInspectionValue(value, this.base.sources.inspectionSecrets ?? []); }
  private text(value: unknown): string | null { const c = this.clean(value).value; return typeof c === 'string' && c.trim() ? c : c && typeof c === 'object' ? JSON.stringify(c) : null; }
  private rows(table: string, groupId: string, range?: Range, id?: string, scope?: Scope): Row[] {
    const db = this.base.telemetry(); if (!db) return [];
    const cols = columns(db, table); if (!cols.has('group_id') || !cols.has('request_id')) return [];
    const selection = fields.map(f => cols.has(f) ? f : `NULL AS ${f}`).join(',');
    const clauses:string[]=[],params:string[]=[];
    if(scope)for(const [key,values] of [['request_id',scope.requestIds],['turn_id',scope.turnIds],['wake_id',scope.wakeIds]] as const)if(cols.has(key)&&values?.length){clauses.push(`${key} IN (${values.map(()=>'?').join(',')})`);params.push(...values);}
    if(scope&&!clauses.length)return [];
    return cap(db.prepare(`SELECT ${selection} FROM ${table} WHERE group_id=?${range ? ' AND started_at BETWEEN ? AND ?' : ''}${id ? ' AND request_id=?' : ''}${scope?` AND (${clauses.join(' OR ')})`:''} LIMIT 10001`).all(groupId, ...(range ? [range.since, range.until] : []), ...(id ? [id] : []),...params) as Row[]);
  }
  private messages(groupId: string, scope: Scope, content=false, budget=newBudget()): Row[] {
    const db = this.base.session(groupId); if (!db) return [];
    // Extract ONLY stable metadata for association, never transfer historical bodies on list reads.
    const turn=SESSION_PHYSICAL_TURN;
    const clauses:string[]=[],params:string[]=[];
    for(const [expression,values] of [['request_id',scope.requestIds],[turn,scope.turnIds],['wake_id',scope.wakeIds]] as const)if(values?.length){clauses.push(`${expression} IN (${values.map(()=>'?').join(',')})`);params.push(...values);}
    if(!clauses.length)return [];
    const hasCreatedAt=columns(db,'model_session_messages').has('created_at');
    const statement=db.prepare(`SELECT seq,session_id,wake_id,request_id,${hasCreatedAt?'created_at':'NULL AS created_at'},${turn} AS physical_turn,${content?'substr(message,1,1048576)':'NULL'} AS message,${content?'length(message)>1048576':'0'} AS clipped FROM model_session_messages WHERE ${clauses.join(' OR ')} ORDER BY seq LIMIT ${content?'501':'10001'}`);
    return content?collectContent(statement.iterate(...params),500,budget):cap(statement.all(...params) as Row[]);
  }
  private associations(groupId: string, scope: Scope, content=false, budget=newBudget()) {
    const messages = this.messages(groupId,scope,content,budget), byRequest = new Map<string,string>(), byTurn = new Map<string,Set<string>>();
    for (const row of messages) {
      if (s(row.request_id) && s(row.wake_id)) byRequest.set(row.request_id,row.wake_id);
      const turn = s(row.physical_turn);
      if (turn && s(row.wake_id)) { const wakes = byTurn.get(turn) ?? new Set<string>(); wakes.add(row.wake_id); byTurn.set(turn,wakes); }
    }
    return { messages, byRequest, byTurn };
  }
  requests(range?: Range, groupId?: string, id?: string, scope?: Scope): ReviewRequest[] {
    const result: ReviewRequest[] = [];
    for (const g of this.base.groups.filter(g => !groupId || g.groupId === groupId)) {
      const telemetry = this.rows('model_requests',g.groupId,range,id,scope), inspection = this.rows('model_request_inspections',g.groupId,range,id,scope);
      const primaryById = new Map(telemetry.map(row=>[row.request_id,row]));
      const merged = new Map<string,Row>();
      for (const row of inspection) merged.set(row.request_id,{...row,hasInspection:true});
      for (const row of telemetry) { const old = merged.get(row.request_id); merged.set(row.request_id,{...old,...Object.fromEntries(Object.entries(row).filter(([,v])=>v!==null)),hasInspection:!!old}); }
      if (!merged.size) continue;
      const legacy = [...merged.values()].filter(row=>!s(row.wake_id));
      const a = legacy.length ? this.associations(g.groupId,{requestIds:legacy.map(row=>String(row.request_id)),turnIds:[...new Set(legacy.map(row=>s(row.turn_id)).filter((v):v is string=>v!==null))]}) : {byRequest:new Map<string,string>(),byTurn:new Map<string,Set<string>>()};
      for (const row of merged.values()) {
        // Inspection recovery writes ended_at=restart time, NOT the HTTP end.
        // Only an actual primary measurement can establish interrupted request timing.
        if(row.status==='interrupted' && n(primaryById.get(row.request_id)?.ended_at)===null) {
          row.ended_at=null;
          row.duration_ms=null;
        }
        const total = n(row.input_tokens), cached = n(row.cached_input_tokens), output = n(row.output_tokens), duration = requestDuration(row);
        const usage=summarize([row]), performance=performanceMetrics([row],{attribution:'request'});
        const wakes = a.byTurn.get(row.turn_id), wake = s(row.wake_id) ?? a.byRequest.get(row.request_id) ?? (wakes?.size === 1 ? [...wakes][0]! : null);
        result.push({performance,cacheHitRate:usage.cacheHitRate,requestId:row.request_id,groupId:g.groupId,wakeId:wake,turnId:s(row.turn_id),model:this.text(row.model),transport:s(row.transport)??'unknown',startedAt:n(row.started_at)??0,endedAt:n(row.ended_at),durationMs:duration,status:s(row.status)??'unknown',outcome:row.status==='running'||row.status==='interrupted'?row.status:requestOutcome(row.status,row.error_code),errorCode:this.text(row.error_code),httpStatus:n(row.http_status),diagnostics:normalizeModelRequestDiagnostics(parse(row.diagnostics))??null,inputTokens:total!==null&&cached!==null&&cached<=total?total-cached:null,totalInputTokens:total,cachedInputTokens:cached!==null&&total!==null&&cached>total?null:cached,outputTokens:output,reasoningTokens:n(row.reasoning_tokens),tps:performance.modelTps,responseId:this.text(row.response_id),previousResponseId:this.text(row.previous_response_id),providerRequestId:this.text(row.provider_request_id),requestMode:this.text(row.request_mode),hasInspection:row.hasInspection});
      }
      cap(result);
    }
    return result.sort((a,b)=>b.startedAt-a.startedAt||a.groupId.localeCompare(b.groupId)||a.requestId.localeCompare(b.requestId));
  }
  private tools(groupId: string, wakeIds: Set<string>, messages: Row[], budget=newBudget(), requestId?:string): {items:ReviewTool[];truncated:boolean} {
    const db=this.base.session(groupId); if(!db) return {items:[],truncated:false};
    const cols=columns(db,'model_tool_ledger'); const items:ReviewTool[]=[]; let truncated=false;
    const bySeq=new Map(messages.map(m=>[m.seq,m]));
    const assistantSeqs=requestId?messages.filter(m=>m.request_id===requestId).map(m=>m.seq):[];
    if(requestId&&(!cols.has('assistant_seq')||!assistantSeqs.length))return {items:[],truncated:false};
    for(const wake of wakeIds) {
      if(items.length>=500||budget.remaining<=0){truncated=true;break;}
      const statement=db.prepare(`SELECT ordinal,name,state,proposed_at,started_at,finished_at,substr(arguments,1,1048576) AS arguments,substr(result,1,1048576) AS result,length(arguments)>1048576 OR length(result)>1048576 AS clipped,${cols.has('assistant_seq')?'assistant_seq':'NULL AS assistant_seq'},${cols.has('call_id')?'call_id':'NULL AS call_id'} FROM model_tool_ledger WHERE wake_id=?${requestId?` AND assistant_seq IN (${assistantSeqs.map(()=>'?').join(',')})`:''} ORDER BY ordinal LIMIT 501`);
      const rows=collectContent(statement.iterate(wake,...assistantSeqs),500-items.length,budget);
      truncated ||= budget.truncated;
      for(const row of rows.slice(0,500)) {
        const args=this.clean(parse(row.arguments)),res=this.clean(parse(row.result)),raw=parse(row.result), diagnostic={...row,...(raw&&typeof raw==='object'?raw:{})};
        truncated ||= args.truncated||res.truncated||!!row.clipped;
        items.push({ordinal:row.ordinal,name:this.text(row.name)??'unknown',requestId:s(bySeq.get(row.assistant_seq)?.request_id),callId:s(row.call_id),state:s(row.state)??'unknown',status:this.text(raw?.status),outcome:toolOutcome(diagnostic),reasonCode:toolReason(diagnostic),proposedAt:n(row.proposed_at),startedAt:n(row.started_at),finishedAt:n(row.finished_at),durationMs:intervalDuration(row.started_at,row.finished_at),arguments:args.value,result:res.value});
      }
    }
    if(items.length>500) truncated=true;
    return {items:items.sort((a,b)=>a.ordinal-b.ordinal).slice(0,500),truncated};
  }
  detail(groupId:string,id:string):RequestReviewDetail|null {
    const request=this.requests(undefined,groupId,id)[0]; if(!request)return null;
    const db=this.base.telemetry(),cols=db?columns(db,'model_request_inspections'):new Set<string>();
    const bodyFields=['request_json','response_json','reasoning_text','error_text'];
    const row=db&&cols.has('group_id')?db.prepare(`SELECT ${bodyFields.map(f=>cols.has(f)?`substr(${f},1,1048576) AS ${f}`:`NULL AS ${f}`).join(',')},${cols.has('content_truncated')?'content_truncated':'0 AS content_truncated'},(${bodyFields.filter(f=>cols.has(f)).map(f=>`COALESCE(length(${f})>1048576,0)`).join(' OR ')||'0'}) AS clipped FROM model_request_inspections WHERE group_id=? AND request_id=?`).get(groupId,id) as Row|undefined:undefined;
    const budget=newBudget();budget.remaining-=Buffer.byteLength(JSON.stringify(row??{}));
    const a=this.associations(groupId,{requestIds:[id]},typeof row?.response_json!=='string',budget);
    const assistant=a.messages.find(m=>m.request_id===id);
    // Historical context is explicitly a fallback, not a reconstructed HTTP snapshot.
    const historical=assistant&&typeof row?.request_json!=='string'?collectContent(this.base.session(groupId)!.prepare('SELECT substr(message,1,1048576) AS message,length(message)>1048576 AS clipped FROM model_session_messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 501').iterate(assistant.session_id,assistant.seq),500,budget).reverse().map(m=>{budget.truncated ||= !!m.clipped;return parse(m.message);}):null;
    const tools=this.tools(groupId,new Set(a.messages.filter(m=>m.request_id===id).map(m=>m.wake_id)),a.messages,budget,id);
    const req=this.clean(parse(row?.request_json)??(historical?{source:'persisted_session_context',messages:historical}:null)),res=this.clean(parse(row?.response_json)??(assistant?parse(assistant.message):null));
    // Chains stay inside the currently authorized group, including session rotations.
    const chainIds=db&&cols.has('response_id')&&cols.has('previous_response_id')?db.prepare('SELECT request_id FROM model_request_inspections WHERE group_id=? AND (response_id=? OR previous_response_id=?) LIMIT 502').all(groupId,request.previousResponseId,request.responseId).map(r=>String(r.request_id)):[];
    const all=chainIds.length?this.requests(undefined,groupId,undefined,{requestIds:chainIds}):[],link=(r:ReviewRequest)=>({requestId:r.requestId,groupId:r.groupId,wakeId:r.wakeId});
    const previous=request.previousResponseId?all.find(r=>r.requestId!==id&&r.responseId===request.previousResponseId):undefined;
    return {request,requestBody:req.value,responseBody:res.value,reasoningText:this.text(row?.reasoning_text),errorText:this.text(row?.error_text),contentTruncated:budget.truncated||chainIds.length>501||!!row?.content_truncated||!!row?.clipped||req.truncated||res.truncated||tools.truncated||this.clean(row?.reasoning_text).truncated||this.clean(row?.error_text).truncated,tools:tools.items.filter(t=>t.requestId===id),previousRequest:previous?link(previous):null,nextRequests:request.responseId?all.filter(r=>r.requestId!==id&&r.previousResponseId===request.responseId).slice(0,500).map(link):[]};
  }
  /** One bounded metadata-only scope shared by the list and expanded review. */
  private wakeRequestScope(groupId:string,wakeId:string) {
    const initial=this.associations(groupId,{wakeIds:[wakeId]}),turns=new Set(initial.byTurn.keys());
    const direct=this.requests(undefined,groupId,undefined,{wakeIds:[wakeId],requestIds:[...initial.byRequest.keys()]});for(const r of direct)if(r.turnId)turns.add(r.turnId);
    const requests=this.requests(undefined,groupId,undefined,{wakeIds:[wakeId],requestIds:[...initial.byRequest.keys()],turnIds:[...turns]});
    const related=this.associations(groupId,{turnIds:[...turns]});
    const wakes=new Set([wakeId,...requests.map(r=>r.wakeId).filter((w):w is string=>w!==null)]); for(const t of turns)for(const w of related.byTurn.get(t)??[])wakes.add(w);
    return {requests,turns,wakes};
  }
  private summarizeWake(wake:WakeItem,requests:ReviewRequest[]):WakeItem {
    const rows=requests.map(request=>({interval_known:request.performance.coverage.modelIntervalRequests===1,started_at:request.startedAt,ended_at:request.endedAt,input_tokens:request.totalInputTokens,cached_input_tokens:request.cachedInputTokens,output_tokens:request.outputTokens,status:request.status,error_code:request.errorCode,duration_ms:request.durationMs}));
    const usage=summarize(rows);
    const tools=this.base.toolTimings(undefined,wake.groupId,wake.wakeId);
    const performance=performanceMetrics(rows,{attribution:'wake',startedAt:wake.startedAt,finishedAt:wake.finishedAt,tools,sourceComplete:this.base.telemetry()!==null && this.base.session(wake.groupId)!==null});
    return {...wake,performance,tps:usage.tps,cacheHitRate:usage.cacheHitRate,modelRequests:requests.length,inputTokens:usage.inputTokens,uncachedInputTokens:usage.uncachedInputTokens,cachedInputTokens:usage.cachedInputTokens,outputTokens:usage.outputTokens};
  }
  wakeSummary(wake:WakeItem):WakeItem {
    return this.summarizeWake(wake,this.wakeRequestScope(wake.groupId,wake.wakeId).requests);
  }
  wake(groupId:string,wakeId:string):WakeReviewDetail|null {
    const legacy=this.base.detail(groupId,wakeId); if(!legacy)return null;
    const {requests,turns,wakes}=this.wakeRequestScope(groupId,wakeId);
    const budget=newBudget();
    const a=this.associations(groupId,{wakeIds:[...wakes]},true,budget);
    const tools=this.tools(groupId,wakes,this.messages(groupId,{wakeIds:[...wakes]}),budget); let truncated=tools.truncated||requests.length>500;
    const rawMessages=a.messages.filter(m=>wakes.has(m.wake_id)); truncated ||= rawMessages.length>500;
    const messages=rawMessages.slice(0,500).map(row=>{const raw=parse(row.message),clean=this.clean(raw?.content??raw);truncated ||= clean.truncated||!!row.clipped;return {role:s(raw?.role)??'unknown',content:clean.value,...(s(raw?.tool_call_id)?{toolCallId:raw.tool_call_id}:{}),...(s(row.request_id)?{requestId:row.request_id}:{}),createdAt:n(row.created_at)};});
    const events:WakeReviewDetail['events']=[];const db=this.base.session(groupId)!;
    for(const w of wakes){const rows=collectContent(db.prepare('SELECT created_at,kind,substr(payload,1,1048576) AS payload,length(payload)>1048576 AS clipped FROM model_session_journal WHERE wake_id=? ORDER BY seq LIMIT 501').iterate(w),Math.max(0,500-events.length),budget);truncated ||= budget.truncated;for(const row of rows.slice(0,500)){const clean=this.clean(parse(row.payload));truncated ||= clean.truncated||!!row.clipped;events.push({time:n(row.created_at),kind:s(row.kind)??'unknown',title:eventTitle(s(row.kind)??'unknown'),detail:clean.value});}}
    const telemetry=this.base.telemetry();
    if(telemetry&&columns(telemetry,'runtime_events').has('turn_id'))for(const turn of turns){
      const rows=collectContent(telemetry.prepare('SELECT observed_at,event,substr(fields,1,1048576) AS fields FROM runtime_events WHERE group_id=? AND turn_id=? ORDER BY seq LIMIT 501').iterate(groupId,turn),Math.max(0,500-events.length),budget);
      truncated ||= budget.truncated;
      for(const row of rows.slice(0,500)){const clean=this.clean(parse(row.fields));truncated ||= clean.truncated;events.push({time:n(row.observed_at),kind:s(row.event)??'unknown',title:eventTitle(s(row.event)??'unknown'),detail:clean.value});}
    }
    const meta=rawMessages.map(m=>parse(parse(m.message)?.content)?.wake).find(w=>w?.trigger);
    const trigger=meta?.trigger?{...(s(meta.trigger.type)?{type:this.text(meta.trigger.type)!}:{}),...(Array.isArray(meta.trigger.message_ids)?{messageIds:meta.trigger.message_ids.filter((v:unknown)=>typeof v==='string')}:{}),...(s(meta.trigger.actor_id)?{actorId:meta.trigger.actor_id}:{})}:null;
    return {wake:this.summarizeWake(legacy.wake,requests),requests:requests.slice(0,500),tools:tools.items,messages,events:events.sort((a,b)=>(a.time??0)-(b.time??0)).slice(0,500),trigger,contentTruncated:truncated||budget.truncated||events.length>500};
  }
  events(range:Range, groupId:string|undefined, category:string|undefined, query:string|undefined, after:number, limit:number):{items:ReviewEvent[];hasMore:boolean} {
    const db=this.base.telemetry();if(!db||!columns(db,'runtime_events').has('event'))return {items:[],hasMore:false};
    const groups=this.base.groups.filter(g=>!groupId||g.groupId===groupId).map(g=>g.groupId);
    // Only connection/lifecycle events are global. Unknown null-group events fail closed.
    const global=`(group_id IS NULL AND event IN (${GLOBAL_REVIEW_EVENTS.map(()=>'?').join(',')}))`;
    // Heartbeats support health inference, not the human event timeline.
    const terms=['observed_at BETWEEN ? AND ?','seq<?',"event!='app.heartbeat'",`(${global}${groups.length?` OR group_id IN (${groups.map(()=>'?').join(',')})`:''})`];
    const params:(number|string)[]=[range.since,range.until,after,...GLOBAL_REVIEW_EVENTS,...groups];
    if(category){terms.push("(event=? OR event LIKE ? ESCAPE '\\')");params.push(category,category+'.%');}
    if(query){terms.push("(instr(lower(event),?)>0 OR instr(lower(COALESCE(group_id,'')),?)>0 OR instr(lower(COALESCE(turn_id,'')),?)>0 OR instr(lower(COALESCE(message_id,'')),?)>0)");params.push(...Array(4).fill(query.toLowerCase()));}
    const rows=db.prepare(`SELECT seq,observed_at,event,group_id,turn_id,message_id,substr(fields,1,65536) AS fields FROM runtime_events WHERE ${terms.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...params,limit+1) as Row[];
    return {items:rows.slice(0,limit).map(row=>{const raw=parse(row.fields);return {sequence:row.seq,time:row.observed_at,event:this.text(row.event)??'unknown',level:this.text(raw?.level),groupId:s(row.group_id),turnId:s(row.turn_id),messageId:s(row.message_id),title:eventTitle(s(row.event)??'unknown'),detail:this.clean(raw).value};}),hasMore:rows.length>limit};
  }
  health(now:number):HealthResponse {
    const availability=this.base.availability();
    const groups=this.base.groups.map(g=>{let lastObservedMessageAt:number|null=null,db:DatabaseSync|undefined;
      try{if(g.worldPath&&lstatSync(g.worldPath).isFile()){db=new DatabaseSync(g.worldPath,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');if(db.prepare('SELECT group_id FROM world_identity WHERE singleton=1').get()?.group_id===g.groupId)lastObservedMessageAt=n(db.prepare("SELECT MAX(observed_at)*1000 AS time FROM world_events WHERE group_id=? AND type='message.created'").get(g.groupId)?.time);}}catch{}finally{db?.close();}
      const t=this.base.telemetry(); let lastRequestAt:number|null=null;try{lastRequestAt=n(t?.prepare('SELECT MAX(started_at) AS time FROM model_requests WHERE group_id=?').get(g.groupId)?.time);}catch{}
      let observationSource:'runtime_received'|'legacy_world'|null=lastObservedMessageAt!==null?'legacy_world':null;
      if(t&&columns(t,'runtime_events').has('event')){const received=n(t.prepare("SELECT MAX(observed_at) AS time FROM runtime_events WHERE group_id=? AND event='onebot.message_received'").get(g.groupId)?.time);if(received!==null){lastObservedMessageAt=received;observationSource='runtime_received';}}
      return {groupId:g.groupId,sessionAvailable:availability.sessions.find(s=>s.groupId===g.groupId)?.available??false,lastObservedMessageAt,observationSource,lastRequestAt};});
    let connectivity:HealthResponse['connectivity']='unknown',lastHeartbeatAt:number|null=null,lastConnectionEventAt:number|null=null;
    const telemetry=this.base.telemetry();
    if(telemetry&&columns(telemetry,'runtime_events').has('event')){
      const heartbeat=telemetry.prepare("SELECT observed_at,fields FROM runtime_events WHERE event='app.heartbeat' ORDER BY seq DESC LIMIT 1").get();
      lastHeartbeatAt=n(heartbeat?.observed_at);
      const heartbeatStatus=parse(heartbeat?.fields)?.status;
      const latest=telemetry.prepare("SELECT observed_at,event FROM runtime_events WHERE event IN ('onebot.ready','onebot.disconnected','app.stopping','app.stopped') ORDER BY seq DESC LIMIT 1").get();
      lastConnectionEventAt=n(latest?.observed_at);
      if(lastHeartbeatAt!==null&&now-lastHeartbeatAt>45000)connectivity='stale';
      else if(lastHeartbeatAt!==null&&lastHeartbeatAt>=(lastConnectionEventAt??0)&&['connected','disconnected'].includes(heartbeatStatus))connectivity=heartbeatStatus;
      else if(latest?.event&&latest.event!=='onebot.ready')connectivity='disconnected';
      else if(latest?.event==='onebot.ready'&&lastHeartbeatAt!==null)connectivity='connected';
    }
    return {now,availability,connectivity,lastHeartbeatAt,lastConnectionEventAt,groups,note:'Local observations only; silence does not establish offline status.'};
  }
}
