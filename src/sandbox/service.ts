import {createHash} from 'node:crypto';
import {startExecution,encodeToolValue} from './executor.js';
import type {JsonObject} from '../contracts/json.js';
import type {ExecutionOptions,ExecutionResult,ExecutionDiagnostic} from './protocol.js';
import {SandboxJobStore,validateInput,validateScope,type Job,type JobInput,type JobScope,type JobQuery,type JobStatus,type ToolCallSummary,type ToolCallStatus} from './store.js';
export type JobResponse={status:'pending';job_id:string}|{status:'completed';job_id:string;value:string;logs:string[];diagnostic?:ExecutionDiagnostic;tool_calls?:ToolCallSummary}|{status:'failed'|'cancelled'|'interrupted'|'timeout';job_id?:string;error:string;logs:string[];diagnostic?:ExecutionDiagnostic;tool_calls?:ToolCallSummary};
/** Who started a job. Held in memory only: jobs never survive a restart. */
export interface JobCaller {actorId:string;messageId:string}
/** Host tools reachable from guest code. Authorization happens inside call(), at call time. */
export interface SandboxToolBridge {
 names(scope:JobScope):readonly string[];
 call(scope:JobScope&JobCaller,name:string,args:unknown,signal:AbortSignal):Promise<JsonObject>;
}
const ID_FIELDS=['message_id','notification_message_id','artifact_id','job_id','reminder_id','code'];
function callStatus(result:JsonObject):{status:ToolCallStatus;error?:string}{
 const error=typeof result.error==='string'&&/^[-a-zA-Z0-9_]{1,128}$/.test(result.error)?result.error:undefined;
 if(result.status==='unknown'||result.status==='confirmation_required')return {status:result.status,...(error?{error}:{})};
 if(result.status==='error'||result.status==='partial')return {status:'error',error:error??String(result.status)};
 return {status:'ok'};
}
type Executor=(options:ExecutionOptions)=>{result:Promise<ExecutionResult>;cancel():void};
interface Live {job:Job;code:string;caller?:JobCaller;calls:number;resolve:(value:JobResponse)=>void;delivery:'foreground'|'background'|'returned';timer?:NodeJS.Timeout;signal?:AbortSignal;abort?:()=>void;handle?:ReturnType<Executor>}
const active=(j:Job)=>j.status==='queued'||j.status==='running';
const response=(j:Job):JobResponse=>j.status==='completed'?{status:'completed',job_id:j.job_id,value:j.value!,logs:j.logs,...(j.diagnostic?{diagnostic:j.diagnostic}:{}),...(j.toolCalls?{tool_calls:j.toolCalls}:{})}:{status:j.status as 'failed'|'cancelled'|'interrupted'|'timeout',job_id:j.job_id,error:j.error??'execution_failed',logs:j.logs,...(j.diagnostic?{diagnostic:j.diagnostic}:{}),...(j.toolCalls?{tool_calls:j.toolCalls}:{})};
/** Persistent task ownership plus a bounded in-memory execution queue. No per-call quotas. */
export class SandboxService {
 private live=new Map<string,Live>();private queue:string[]=[];private running=0;private stopped=false;private listeners=new Set<()=>void>();private readonly executor:Executor;private readonly concurrency:number;private readonly queued:number;
 private bridge?:SandboxToolBridge;
 constructor(private options:{store:SandboxJobStore;maxConcurrent?:number;maxQueued?:number;executor?:Executor;limits?:Omit<ExecutionOptions,'code'|'tools'|'callTool'>}){this.executor=options.executor??startExecution;this.concurrency=options.maxConcurrent??2;this.queued=options.maxQueued??64;for(const n of [this.concurrency,this.queued])if(!Number.isSafeInteger(n)||n<=0||n>2147483647)throw Error('invalid_limits');}
 /** Late binding: the bridge reaches group listeners, which are created after the service. */
 setToolBridge(bridge:SandboxToolBridge):void{this.bridge=bridge;}
 execute(input:JobInput,signal?:AbortSignal,caller?:JobCaller):Promise<JobResponse>{validateInput(input);if(signal?.aborted)return Promise.resolve({status:'cancelled',error:'cancelled',logs:[]});if(this.stopped)return Promise.resolve({status:'failed',error:'service_stopped',logs:[]});if(this.running+this.queue.length>=this.concurrency+this.queued)return Promise.resolve({status:'failed',error:'queue_full',logs:[]});const job=this.options.store.create(input);
 return new Promise(resolve=>{const item:Live={job,code:input.code,...(caller?{caller:{...caller}}:{}),calls:0,resolve,delivery:input.mode==='async'?'background':'foreground'};this.live.set(job.job_id,item);this.queue.push(job.job_id);
 if(input.mode==='async')resolve({status:'pending',job_id:job.job_id});else{item.timer=setTimeout(()=>{if(item.delivery!=='foreground')return;if(input.mode==='sync')this.terminate(item,'timeout','execution_timeout');else this.detach(item);},input.waitMs!);
 if(signal){item.signal=signal;item.abort=()=>{if(item.delivery!=='foreground')return;if(input.mode==='sync')this.terminate(item,'cancelled','cancelled');else this.detach(item);};signal.addEventListener('abort',item.abort,{once:true});if(signal.aborted)item.abort();}}
 this.pump();});}
 private clean(item:Live){if(item.timer)clearTimeout(item.timer);if(item.signal&&item.abort)item.signal.removeEventListener('abort',item.abort);item.timer=undefined;item.signal=undefined;item.abort=undefined;}
 private notify(){for(const fn of this.listeners)try{fn();}catch{/* completion remains durable for retry */}}
 private detach(item:Live){if(item.delivery!=='foreground')return;try{this.options.store.detach(item.job,item.job.job_id);}catch{this.terminate(item,'cancelled','storage_failed');return;}item.delivery='background';this.clean(item);item.resolve({status:'pending',job_id:item.job.job_id});}
 private finish(item:Live,result:{status:Exclude<JobStatus,'queued'|'running'>;value?:string;error?:string;logs?:string[];diagnostic?:ExecutionDiagnostic}){if(!this.live.has(item.job.job_id))return;let job:Job;try{job=this.options.store.settle(item.job,item.job.job_id,result)!;}catch{console.error('sandbox job persistence failed',item.job.job_id);this.clean(item);this.live.delete(item.job.job_id);this.queue=this.queue.filter(id=>id!==item.job.job_id);item.code='';if(item.delivery==='foreground')item.resolve({status:'failed',job_id:item.job.job_id,error:'storage_failed',logs:[]});item.delivery='returned';return;}this.clean(item);this.live.delete(job.job_id);this.queue=this.queue.filter(id=>id!==job.job_id);item.code='';if(item.delivery==='foreground'){item.delivery='returned';item.resolve(response(job));}else if(item.delivery==='background')this.notify();}
 private terminate(item:Live,status:'cancelled'|'timeout'|'interrupted',error:string){try{item.handle?.cancel();}catch{/* state still records terminal cancellation */}finally{this.finish(item,{status,error,logs:[]});}this.pump();}
 private pump(){if(this.stopped)return;while(this.running<this.concurrency&&this.queue.length){const id=this.queue.shift()!,item=this.live.get(id);if(!item)continue;try{if(!this.options.store.start(item.job,id))continue;}catch{this.finish(item,{status:'failed',error:'storage_failed'});continue;}this.running++;
 try{const tools=this.bridge?[...this.bridge.names(item.job)]:[];
 item.handle=this.executor({...this.options.limits,code:item.code,...(tools.length?{tools,callTool:(name,args,signal)=>this.callTool(item,name,args,signal)}:{})});item.code='';Promise.resolve(item.handle.result).then(r=>this.finish(item,r),()=>this.finish(item,{status:'failed',error:'executor_failed',logs:[]})).finally(()=>{this.running--;this.pump();});}
 catch{this.running--;this.finish(item,{status:'failed',error:'executor_failed',logs:[]});}}}
 private async callTool(item:Live,name:string,args:unknown,signal:AbortSignal):Promise<JsonObject>{
  const seq=++item.calls,startedAt=Date.now();
  let encoded:{json:string;attachments:Uint8Array[]};try{encoded=encodeToolValue(args);}catch{encoded={json:'null',attachments:[]};}
  const hash=createHash('sha256').update(encoded.json);for(const a of encoded.attachments)hash.update(a);
  let result:JsonObject;
  try{result=this.bridge&&item.caller?await this.bridge.call({selfId:item.job.selfId,groupId:item.job.groupId,...item.caller},name,args,signal):{status:'error',error:'host_unavailable'};}
  catch{result={status:'error',error:'tool_failed'};}
  if(!result||typeof result!=='object'||Array.isArray(result))result={status:'error',error:'invalid_host_result'};
  const ids:Record<string,string>={};for(const key of ID_FIELDS){const v=result[key];if((typeof v==='string'&&v.length<=128)||(typeof v==='number'&&Number.isSafeInteger(v)))ids[key]=String(v);}
  try{this.options.store.recordCall(item.job,item.job.job_id,{seq,tool:name,...callStatus(result),ids,argsBytes:Buffer.byteLength(encoded.json)+encoded.attachments.reduce((n,a)=>n+a.byteLength,0),argsHash:hash.digest('hex'),startedAt,finishedAt:Date.now()});}
  catch{console.error('sandbox tool call record failed',item.job.job_id);}
  return result;
 }
 calls(scope:JobScope,jobId:string,offset?:number,limit?:number){return this.options.store.calls(scope,jobId,offset,limit);}
  query(scope:JobScope,q:JobQuery={}){return this.options.store.query(scope,q);}
 cancel(scope:JobScope,jobId:string):Job|undefined{validateScope(scope);const job=this.options.store.get(scope,jobId);if(!job||!active(job))return job;const item=this.live.get(jobId);if(item)this.terminate(item,'cancelled','cancelled');else this.options.store.settle(scope,jobId,{status:'cancelled',error:'cancelled'});return this.options.store.get(scope,jobId);}
 pendingResults(selfId:string,limit=100,cursor=0){return this.options.store.pendingResults(selfId,limit,cursor);}
 ackResult(selfId:string,groupId:string,jobId:string){return this.options.store.markDelivered({selfId,groupId},jobId);}
 summary(selfId:string,groupId:string){return this.options.store.summary(selfId,groupId);}
 subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 async stop():Promise<void>{if(this.stopped)return;this.stopped=true;const waits:Promise<unknown>[]=[];for(const item of [...this.live.values()]){if(item.delivery==='foreground'){try{this.options.store.detach(item.job,item.job.job_id);}catch{/* startup recovery keeps unfinished durable jobs */}this.clean(item);item.delivery='background';item.resolve({status:'interrupted',job_id:item.job.job_id,error:'service_stopped',logs:[]});}if(item.handle)waits.push(item.handle.result.catch(()=>{}));this.terminate(item,'interrupted','service_stopped');}await Promise.all(waits);this.listeners.clear();}
}
