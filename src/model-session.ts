import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { resolveGroupId, type ChatContentPart, type ChatMessage, type Completion, type JsonObject, type ToolDefinition } from './contracts.js';

export interface ModelSessionOptions { path:string; groupId?:string; maxTranscriptBytes?:number }
export interface ModelSessionState { sessionId:string; generation:number; wakeId?:string; resetReason?:string; needsRecovery:boolean }
export interface AssistantCheckpoint { assistantSeq:number; callIds:string[] }
type LedgerRow={ordinal:number;assistant_seq:number;call_id:string;name:string;state:string;arguments:string;result:string|null};
const DEFAULT_MAX=512*1024, CHECKPOINT_MAX=256*1024, IMAGE_MAX=8*1024*1024, RESULT_RESERVE=1024;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function encode(value:unknown,max:number):string {
 const text=JSON.stringify(value);
 if(typeof text!=='string'||Buffer.byteLength(text)>max)throw new Error('session_resource_limit');
 return text;
}
function canonical(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(object(value))return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`;
 const text=JSON.stringify(value);if(text===undefined)throw new Error('invalid_session_json');return text;
}
function reasonText(reason:string):string {
 if(typeof reason!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(reason))throw new Error('invalid_session_reason');return reason;
}
/** Reject links (including directory and SQLite sidecar links) before touching a file.
 * The enclosing directory must be controlled by the application, as for other local DBs. */
function checkPath(path:string):void {
 for(let p=resolve(path);;p=dirname(p)){
  try{const stat=lstatSync(p);if(stat.isSymbolicLink())throw new Error('session_symlink_refused');if(p===resolve(path)&&(!stat.isFile()||stat.nlink!==1))throw new Error('session_file_refused');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(dirname(p)===p)break;
 }
 for(const suffix of ['-journal','-wal','-shm']){
  try{const stat=lstatSync(path+suffix);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw new Error('session_sidecar_refused');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
}

/** Per-group AI history only: no World Store reads, QQ API, logging, or replay of writes.
 * Every mutating method is synchronous and durable before returning. The caller MUST
 * dispatch a tool only after startTool returns true. A failed checkpoint is fail-closed.
 * Reset rotates the current projection; prior sessions and ledger audit rows remain.
 */
export class ModelSession {
 private readonly db:DatabaseSync;
 private readonly maxBytes:number;
 private readonly groupId:string;
 private stateValue!:ModelSessionState;
 private readonly images=new Map<number,ChatMessage>();
 private closed=false;
 constructor(options:ModelSessionOptions){
  if(!options||typeof options.path!=='string'||!options.path)throw new Error('invalid_session_options');
  this.groupId=resolveGroupId(options.groupId);this.maxBytes=options.maxTranscriptBytes??DEFAULT_MAX;
  if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<4096||this.maxBytes>16*1024*1024)throw new Error('invalid_session_options');
  if(options.path!==':memory:'){
   checkPath(options.path);
   // Read identity BEFORE chmod, schema creation, or writable SQLite open.
   if(existsSync(options.path)&&lstatSync(options.path).size){
    const probe=new DatabaseSync(options.path,{readOnly:true});
    try{
     if(!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_session_meta'").get()||probe.prepare('SELECT group_id FROM model_session_meta WHERE singleton=1').get()?.group_id!==this.groupId)throw new Error('session_group_mismatch');
    }finally{probe.close();}
   }
   const fd=openSync(options.path,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
   try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('session_file_refused');}finally{closeSync(fd);}
   chmodSync(options.path,0o600);
   for(const suffix of ['-journal','-wal','-shm'])if(existsSync(options.path+suffix))chmodSync(options.path+suffix,0o600);
  }
  this.db=new DatabaseSync(options.path);
  try{
   this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS model_session_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),group_id TEXT NOT NULL,session_id TEXT NOT NULL,generation INTEGER NOT NULL,wake_id TEXT,reset_reason TEXT,fingerprint TEXT,checkpoint TEXT);
    CREATE TABLE IF NOT EXISTS model_session_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS model_session_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,message TEXT NOT NULL,bytes INTEGER NOT NULL,transient_image INTEGER NOT NULL DEFAULT 0,request_id TEXT,UNIQUE(session_id,request_id));
    CREATE INDEX IF NOT EXISTS model_session_messages_session ON model_session_messages(session_id,seq);
    CREATE TABLE IF NOT EXISTS model_tool_ledger(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,assistant_seq INTEGER NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,arguments TEXT NOT NULL,state TEXT NOT NULL,result TEXT,proposed_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,UNIQUE(assistant_seq,call_id));
    CREATE INDEX IF NOT EXISTS model_tool_ledger_session ON model_tool_ledger(session_id,ordinal);`);
   const meta=this.db.prepare('SELECT * FROM model_session_meta WHERE singleton=1').get();
   if(meta&&meta.group_id!==this.groupId)throw new Error('session_group_mismatch');
   if(meta)this.stateValue={sessionId:String(meta.session_id),generation:Number(meta.generation),...(typeof meta.wake_id==='string'?{wakeId:meta.wake_id}:{}),...(typeof meta.reset_reason==='string'?{resetReason:meta.reset_reason}:{}),needsRecovery:meta.fingerprint===null&&typeof meta.reset_reason==='string'};
   else {
    this.stateValue={sessionId:randomUUID(),generation:0,needsRecovery:false};
    this.db.prepare('INSERT INTO model_session_meta(singleton,group_id,session_id,generation) VALUES(1,?,?,0)').run(this.groupId,this.stateValue.sessionId);
   }
   this.transaction(()=>{
    this.resolvePending('recovered_after_crash');
    if(this.stateValue.wakeId){this.audit('wake_recovered',{});delete this.stateValue.wakeId;this.saveMeta();}
    if(this.db.prepare('SELECT 1 FROM model_session_messages WHERE session_id=? AND transient_image=1 LIMIT 1').get(this.stateValue.sessionId))this.rotate('transient_images_lost');
   });
  }catch(error){this.db.close();throw error;}
 }
 private check():void {if(this.closed)throw new Error('session_closed');}
 private transaction<T>(fn:()=>T):T {
  this.check();const before=structuredClone(this.stateValue);this.db.exec('BEGIN IMMEDIATE');
  try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{}this.stateValue=before;throw error;}
 }
 private saveMeta():void {this.db.prepare('UPDATE model_session_meta SET session_id=?,generation=?,wake_id=?,reset_reason=? WHERE singleton=1').run(this.stateValue.sessionId,this.stateValue.generation,this.stateValue.wakeId??null,this.stateValue.resetReason??null);}
 private audit(kind:string,payload:JsonObject):void {this.db.prepare('INSERT INTO model_session_journal(session_id,wake_id,kind,payload,created_at) VALUES(?,?,?,?,?)').run(this.stateValue.sessionId,this.stateValue.wakeId??null,kind,encode(payload,CHECKPOINT_MAX),Date.now());}
 private terminal():boolean {return !!this.db.prepare("SELECT 1 FROM model_session_journal WHERE session_id=? AND wake_id=? AND kind='wake_terminal' LIMIT 1").get(this.stateValue.sessionId,this.stateValue.wakeId??null);}
 private size():number {return Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM model_session_messages WHERE session_id=?').get(this.stateValue.sessionId)!.n);}
 private pending():LedgerRow[] {return this.db.prepare("SELECT * FROM model_tool_ledger WHERE session_id=? AND state IN ('pending','started') ORDER BY ordinal").all(this.stateValue.sessionId) as unknown as LedgerRow[];}
 private append(message:ChatMessage,extraReserve=0,transient=false,requestId?:string):number {
  const text=encode(message,this.maxBytes),bytes=Buffer.byteLength(text);
  if(this.size()+bytes+extraReserve>this.maxBytes)throw new Error('session_resource_limit');
  return Number(this.db.prepare('INSERT INTO model_session_messages(session_id,wake_id,message,bytes,transient_image,request_id) VALUES(?,?,?,?,?,?)').run(this.stateValue.sessionId,this.stateValue.wakeId??null,text,bytes,transient?1:0,requestId??null).lastInsertRowid);
 }
 private rotate(reason:string):void {
  this.resolvePending(reason);this.audit('session_reset',{reason,next_generation:this.stateValue.generation+1});
  this.stateValue={sessionId:randomUUID(),generation:this.stateValue.generation+1,resetReason:reason,needsRecovery:true};
  this.saveMeta();this.db.prepare('UPDATE model_session_meta SET fingerprint=NULL,checkpoint=NULL WHERE singleton=1').run();
 }
 state():ModelSessionState {this.check();return structuredClone(this.stateValue);}
 messages():ChatMessage[] {
  this.check();return this.db.prepare('SELECT seq,message FROM model_session_messages WHERE session_id=? ORDER BY seq').all(this.stateValue.sessionId).map(row=>structuredClone(this.images.get(Number(row.seq))??JSON.parse(String(row.message)) as ChatMessage));
 }
 /** Instructions and tools are fingerprinted, never patched into an existing prefix.
  * Empty wake metadata adds no placeholder input. Resource/config reset adds an explicit
  * recovery notice directing the model to read tools again, never a fabricated summary. */
 beginWake(system:string,tools:ToolDefinition[],wakeMeta:JsonObject={}):ChatMessage[] {
  this.check();if(this.stateValue.wakeId)throw new Error('wake_already_active');
  if(typeof system!=='string'||!Array.isArray(tools)||!object(wakeMeta))throw new Error('invalid_wake');
  encode({system,tools},this.maxBytes);encode(wakeMeta,65536);
  const fingerprint=createHash('sha256').update(canonical({system,tools})).digest('hex');
  const oldSession=this.stateValue.sessionId;
  this.transaction(()=>{
   const old=this.db.prepare('SELECT fingerprint FROM model_session_meta WHERE singleton=1').get()!.fingerprint;
   if(old&&old!==fingerprint)this.rotate('configuration_changed');
   const wakeBytes=Buffer.byteLength(encode({role:'user',content:JSON.stringify({wake:wakeMeta})},this.maxBytes));
   if(this.size()&&(this.size()>this.maxBytes*0.75||this.size()+wakeBytes+RESULT_RESERVE>this.maxBytes))this.rotate('transcript_resource_boundary');
   this.stateValue.wakeId=randomUUID();this.saveMeta();
   this.db.prepare('UPDATE model_session_meta SET fingerprint=? WHERE singleton=1').run(fingerprint);
   if(!this.size())this.append({role:'system',content:system});
   const reset=this.stateValue.needsRecovery?this.stateValue.resetReason:undefined;
   if(Object.keys(wakeMeta).length||reset)this.append({role:'user',content:JSON.stringify({wake:wakeMeta,...(reset?{session_reset:{reason:reset,read_tools_again:true}}:{})})});
   this.stateValue.needsRecovery=false;this.audit('wake_begin',{fingerprint});
  });
  if(this.stateValue.sessionId!==oldSession)this.images.clear();
  return this.messages();
 }
 /** Image bytes/URLs live in memory only, with an 8 MiB aggregate bound. A reopened
  * session containing such inputs explicitly rotates and drops the transport chain. */
 appendInput(content:ChatContentPart[]|string):void {
  this.check();if(!this.stateValue.wakeId||this.pending().length)throw new Error('invalid_input_boundary');
  if(typeof content!=='string'&&!Array.isArray(content))throw new Error('invalid_session_input');
  const actual:ChatMessage={role:'user',content:structuredClone(content)};
  let hasImages=false;
  const persisted:ChatMessage={role:'user',content:typeof content==='string'?content:content.map(part=>{
   if(!object(part))throw new Error('invalid_session_input');
   if(part.type==='text'&&typeof part.text==='string')return{type:'text',text:part.text};
   if(part.type==='image_url'&&object(part.image_url)&&typeof part.image_url.url==='string'){hasImages=true;return{type:'text',text:'[session image omitted]'};}
   throw new Error('invalid_session_input');
  })};
  if(hasImages){let total=Buffer.byteLength(encode(actual,IMAGE_MAX));for(const value of this.images.values())total+=Buffer.byteLength(JSON.stringify(value));if(total>IMAGE_MAX)throw new Error('session_image_resource_limit');}
  const seq=this.transaction(()=>{const seq=this.append(persisted,0,hasImages);this.audit('input_checkpoint',{message_seq:seq,image_omitted:hasImages});return seq;});
  if(hasImages)this.images.set(seq,actual);
 }
 appendAssistant(completion:Completion,requestId?:string):AssistantCheckpoint {
  this.check();if(!this.stateValue.wakeId)throw new Error('wake_not_active');
  if(!completion||(completion.content!==null&&typeof completion.content!=='string')||!Array.isArray(completion.tool_calls))throw new Error('invalid_completion');
  if(requestId!==undefined&&(typeof requestId!=='string'||!requestId||requestId.length>256))throw new Error('invalid_request_id');
  const ids=new Set<string>();for(const call of completion.tool_calls){
   if(!call||call.type!=='function'||typeof call.id!=='string'||!call.id||Buffer.byteLength(JSON.stringify(call.id))>256||ids.has(call.id)||!call.function||typeof call.function.name!=='string'||!call.function.name||call.function.name.length>128||typeof call.function.arguments!=='string')throw new Error('invalid_completion');ids.add(call.id);
  }
  const message:ChatMessage={role:'assistant',content:completion.content,tool_calls:structuredClone(completion.tool_calls)};
  if(requestId){const old=this.db.prepare('SELECT seq,message FROM model_session_messages WHERE session_id=? AND request_id=?').get(this.stateValue.sessionId,requestId);if(old){if(String(old.message)!==encode(message,this.maxBytes))throw new Error('request_id_conflict');return{assistantSeq:Number(old.seq),callIds:[...ids]};}}
  if(this.terminal())throw new Error('wake_finished');
  if(this.pending().length)throw new Error('tool_results_pending');
  return this.transaction(()=>{
   const seq=this.append(message,completion.tool_calls.length*RESULT_RESERVE, false,requestId);
   for(const call of completion.tool_calls)this.db.prepare("INSERT INTO model_tool_ledger(session_id,wake_id,assistant_seq,call_id,name,arguments,state,proposed_at) VALUES(?,?,?,?,?,?,'pending',?)").run(this.stateValue.sessionId,this.stateValue.wakeId!,seq,call.id,call.function.name,call.function.arguments,Date.now());
   this.audit('assistant_checkpoint',{assistant_seq:seq,tool_count:ids.size,...(requestId?{request_id:requestId}:{})});return{assistantSeq:seq,callIds:[...ids]};
  });
 }
 private call(callId:string,assistantSeq?:number):LedgerRow|undefined {
  const seq=assistantSeq??Number(this.db.prepare("SELECT COALESCE(MAX(assistant_seq),0) AS n FROM model_tool_ledger WHERE session_id=?").get(this.stateValue.sessionId)!.n);
  return this.db.prepare('SELECT * FROM model_tool_ledger WHERE session_id=? AND assistant_seq=? AND call_id=?').get(this.stateValue.sessionId,seq,callId) as unknown as LedgerRow|undefined;
 }
 startTool(callId:string,assistantSeq?:number):boolean {
  this.check();return this.transaction(()=>{
   const row=this.call(callId,assistantSeq);if(!this.stateValue.wakeId||!row||row.state!=='pending'||this.pending()[0]?.ordinal!==row.ordinal)return false;
   this.db.prepare("UPDATE model_tool_ledger SET state='started',started_at=? WHERE ordinal=? AND state='pending'").run(Date.now(),row.ordinal);
   this.audit('tool_intent',{ordinal:row.ordinal,assistant_seq:row.assistant_seq,call_id:callId});return true;
  });
 }
 private complete(row:LedgerRow,result:JsonObject,state:string):void {
  const text=encode(result,CHECKPOINT_MAX);
  this.append({role:'tool',tool_call_id:row.call_id,content:text},Math.max(0,this.pending().length-1)*RESULT_RESERVE);
  this.db.prepare('UPDATE model_tool_ledger SET state=?,result=?,finished_at=? WHERE ordinal=?').run(state,text,Date.now(),row.ordinal);
  this.audit('tool_result',{ordinal:row.ordinal,state});
 }
 /** Duplicate completions never overwrite the first durable result. */
 finishTool(callId:string,result:JsonObject,assistantSeq?:number):void {
  this.check();if(!object(result))throw new Error('invalid_tool_result');
  this.transaction(()=>{
   const row=this.call(callId,assistantSeq);if(!row)throw new Error('tool_not_found');if(!['pending','started'].includes(row.state))return;
   if(row.state!=='started')throw new Error('tool_not_started');
   this.complete(row,result,'finished');
   if(row.name==='finish'&&result.status==='ok'){let valid=false;try{const args:unknown=JSON.parse(row.arguments);valid=object(args)&&Object.keys(args).length===0;}catch{}if(valid){this.resolvePending('turn_finished');this.audit('wake_terminal',{reason:'finish'});}}
  });
 }
 private resolvePending(reason:string):void {
  for(const row of this.pending())this.complete(row,row.state==='started'?{status:'unknown',error:'execution_result_unknown',reason}:{status:'skipped',error:reason},row.state==='started'?'unknown':'skipped');
 }
 skipPending(reason:string):void {reasonText(reason);this.transaction(()=>this.resolvePending(reason));}
 finishWake(reason='finished'):void {
  reasonText(reason);this.transaction(()=>{this.resolvePending(reason);this.audit('wake_terminal',{reason});this.audit('wake_finish',{reason});delete this.stateValue.wakeId;this.saveMeta();});
 }
 reset(reason='reset'):void {reasonText(reason);this.transaction(()=>this.rotate(reason));this.images.clear();}
 getTransportCheckpoint():JsonObject|undefined {
  this.check();const value=this.db.prepare('SELECT checkpoint FROM model_session_meta WHERE singleton=1').get()!.checkpoint;return typeof value==='string'?JSON.parse(value) as JsonObject:undefined;
 }
 setTransportCheckpoint(value:JsonObject|undefined):void {
  this.check();if(value!==undefined&&!object(value))throw new Error('invalid_transport_checkpoint');const text=value===undefined?null:encode(value,CHECKPOINT_MAX);
  this.transaction(()=>{this.db.prepare('UPDATE model_session_meta SET checkpoint=? WHERE singleton=1').run(text);this.audit('transport_checkpoint',{present:value!==undefined});});
 }
 close():void {if(this.closed)return;this.db.close();this.closed=true;this.images.clear();}
}
