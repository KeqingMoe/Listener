import { createHash, randomUUID } from 'node:crypto';
import type { ChatContentPart, ChatMessage, Completion, Model, ToolCall, ToolDefinition } from './contracts.js';
import { ModelError, type ModelErrorCode, type OpenAIModelOptions } from './model.js';
import { providerRequestId, responseInspection } from './request-inspection.js';
import { parseResponsesUsage, type ModelRequestInspection, type ModelRequestRecord, type ModelUsage } from './model-usage.js';
import { normalizeModelRequestDiagnostics, providerDiagnostics, upstreamAbortSource, type ModelRequestDiagnostics } from './model-diagnostics.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const MAX_BYTES=2*1024*1024, MAX_ARGS=16*1024;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export class ResponseStateExpiredError extends ModelError {
  readonly stateExpired=true;
  constructor(httpStatus?:number,diagnostics?:ModelRequestDiagnostics){super('invalid_response',httpStatus,diagnostics);this.name='ResponseStateExpiredError';}
}
export interface ResponsesModelOptions extends OpenAIModelOptions {
  sessionId:string; compactionThreshold?:number; serverCompactionVerified?:boolean;
}
/** Contains conversation material. Treat as private; never log this checkpoint. */
export interface ResponsesCheckpoint {
  responseId:string;
  baselineMessages:ChatMessage[];
  headerHash:string;
  outputItems:unknown[];
}
export interface ResponsesContinuationCheckpoint extends Record<string,unknown> {
  version:1;
  responseId:string;
  headerHash:string;
  baselineLength:number;
  baselineHash:string;
  baselineNullContentHash?:string;
}
function parts(value:string|ChatContentPart[]|null,assistant=false):unknown[] {
  if(value===null)return [];
  if(typeof value==='string')return [{type:assistant?'output_text':'input_text',text:value}];
  return value.map(p=>p.type==='text'?{type:assistant?'output_text':'input_text',text:p.text}:
    {type:'input_image',image_url:p.image_url.url,...(p.image_url.detail?{detail:p.image_url.detail}:{})});
}
function inputItem(m:ChatMessage):unknown[] {
  if(m.role==='system')return [];
  if(m.role==='user')return [{role:'user',content:parts(m.content)}];
  if(m.role==='tool')return [{type:'function_call_output',call_id:m.tool_call_id??'',output:typeof m.content==='string'?m.content:JSON.stringify(m.content)}];
  const result:unknown[]=[];
  if(m.content!==null)result.push({role:'assistant',content:parts(m.content,true)});
  for(const c of m.tool_calls??[])result.push({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments});
  return result;
}
function completion(raw:Record<string,unknown>):Completion {
  if(raw.status!=='completed'||!bounded(raw.id,256)||!Array.isArray(raw.output))throw new ModelError('invalid_response');
  const calls:ToolCall[]=[],ids=new Set<string>(),texts:string[]=[];
  for(const item of raw.output){
    if(!object(item)||typeof item.type!=='string')throw new ModelError('invalid_response');
    if(item.type==='function_call'){
      if(!bounded(item.call_id,256)||ids.has(item.call_id)||!bounded(item.name,128)||typeof item.arguments!=='string'||Buffer.byteLength(item.arguments)>MAX_ARGS)throw new ModelError('invalid_response');
      ids.add(item.call_id);calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});
    }else if(item.type==='message'){
      if(item.role!=='assistant'||!Array.isArray(item.content))throw new ModelError('invalid_response');
      for(const p of item.content){
        if(!object(p))throw new ModelError('invalid_response');
        if(p.type==='output_text'&&typeof p.text==='string')texts.push(p.text);
        else if(p.type==='refusal'&&typeof p.refusal==='string')texts.push(p.refusal);
        else throw new ModelError('invalid_response');
      }
    }else if(item.type!=='reasoning'&&item.type!=='compaction')throw new ModelError('invalid_response');
  }
  if(calls.length>8)throw new ModelError('invalid_response');
  return {content:texts.length?texts.join('\n'):null,tool_calls:calls};
}
async function readBody(response:Response,stage:(value:ModelRequestDiagnostics['failureStage'])=>void,capture:(text:string,partial:boolean)=>void):Promise<unknown>{
  stage('response_body');
  if(!response.body)throw new ModelError('invalid_response');
  const length=response.headers.get('content-length');
  if(length&&Number(length)>MAX_BYTES){await response.body.cancel();throw new ModelError('response_too_large');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,complete=false;
  try{while(true){const x=await reader.read();if(x.done){complete=true;break;}size+=x.value.byteLength;if(size>MAX_BYTES){chunks.push(x.value.subarray(0,Math.max(0,MAX_BYTES-(size-x.value.byteLength))));await reader.cancel();throw new ModelError('response_too_large');}chunks.push(x.value);}}finally{reader.releaseLock();capture(Buffer.concat(chunks).toString('utf8'),!complete);}
  stage('response_parse');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ModelError('invalid_response');}
}
const expired=(raw:unknown):boolean=>object(raw)&&object(raw.error)&&
  typeof raw.error.code==='string'&&['previous_response_not_found','previous_response_id_not_found','response_not_found'].includes(raw.error.code);
/** One instance per conversation. Prefix mutations start an explicit fresh chain. */
export class ResponsesModel implements Model {
  private readonly options:ResponsesModelOptions;
  private readonly endpoint:string;
  private readonly cacheKey:string;
  private state?:ResponsesCheckpoint;
  private baselineWithoutContent?:ChatMessage[];
  private generation=0;
  private busy=false;
  private restored?:ResponsesContinuationCheckpoint;
  constructor(options:ResponsesModelOptions){
    try{
      const u=new URL(options.baseUrl),local=u.hostname==='localhost'||u.hostname==='[::1]'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname);
      if(u.username||u.password||u.search||u.hash||options.baseUrl.includes('?')||options.baseUrl.includes('#')||
        (u.protocol!=='https:'&&!(u.protocol==='http:'&&local))||!bounded(options.model,128)||!bounded(options.sessionId,256)||
        !options.apiKey||/[\r\n]/.test(options.apiKey)||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>2147483647||
        !Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||
        (options.compactionThreshold!==undefined&&(!Number.isSafeInteger(options.compactionThreshold)||options.compactionThreshold<1))||
        (options.serverCompactionVerified!==undefined&&typeof options.serverCompactionVerified!=='boolean'))throw Error();
      u.pathname=u.pathname.replace(/\/+$/,'')+'/responses';
      this.endpoint=u.toString();this.options={...options};this.cacheKey=hash('qqbot-responses:'+options.sessionId);
    }catch{throw new Error('Invalid Responses model configuration');}
  }
  reset():void {this.generation++;this.state=undefined;this.baselineWithoutContent=undefined;this.restored=undefined;}
  getCheckpoint():ResponsesCheckpoint|undefined {return this.state?structuredClone(this.state):undefined;}
  getContinuationCheckpoint():ResponsesContinuationCheckpoint|undefined {
    const s=this.state;if(!s)return this.restored?{...this.restored}:undefined;
    const baseline=s.baselineMessages;
    const out:ResponsesContinuationCheckpoint={version:1,responseId:s.responseId,headerHash:s.headerHash,baselineLength:baseline.length,baselineHash:hash(JSON.stringify(baseline))};
    if(this.baselineWithoutContent){const nullHash=hash(JSON.stringify(this.baselineWithoutContent));if(nullHash!==out.baselineHash)out.baselineNullContentHash=nullHash;}
    return out;
  }
  restoreContinuationCheckpoint(value:unknown):void {
    const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    const valid=object(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&
      Reflect.ownKeys(value).every(k=>typeof k==='string'&&['version','responseId','headerHash','baselineLength','baselineHash','baselineNullContentHash'].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'))&&
      value.version===1&&bounded(value.responseId,256)&&digest(value.headerHash)&&
      typeof value.baselineLength==='number'&&Number.isSafeInteger(value.baselineLength)&&value.baselineLength>=0&&value.baselineLength<=10000&&digest(value.baselineHash)&&
      (!Object.hasOwn(value,'baselineNullContentHash')||digest(value.baselineNullContentHash));
    if(!valid){this.reset();throw new Error('Invalid continuation checkpoint');}
    this.generation++;this.state=undefined;this.baselineWithoutContent=undefined;this.restored={version:1,responseId:String(value.responseId),headerHash:String(value.headerHash),baselineLength:Number(value.baselineLength),baselineHash:String(value.baselineHash),...(value.baselineNullContentHash===undefined?{}:{baselineNullContentHash:String(value.baselineNullContentHash)})};
  }
  async complete(messages:ChatMessage[],tools:ToolDefinition[]=[],signal?:AbortSignal):Promise<Completion>{
    if(this.busy)throw new ModelError('invalid_response');
    this.busy=true;
    const generation=this.generation,started=performance.now(),startedAt=Date.now(),requestId=randomUUID();
    const snapshot=structuredClone(messages),toolSnapshot=structuredClone(tools);
    let usage:ModelUsage=parseResponsesUsage(undefined),status:ModelRequestRecord['status']='error',failure:ModelErrorCode='network_error',httpStatus:number|undefined;
    const instructions=snapshot.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n\n');
    const functions=toolSnapshot.map(t=>({type:'function',name:t.function.name,description:t.function.description,parameters:t.function.parameters}));
    const headerHash=hash(JSON.stringify({endpoint:this.endpoint,account:hash(this.options.apiKey),instructions,functions,model:this.options.model,maxTokens:this.options.maxTokens}));
    const prefix=(base:ChatMessage[]|undefined)=>base!==undefined&&base.length<=snapshot.length&&base.every((m,i)=>JSON.stringify(m)===JSON.stringify(snapshot[i]));
    const restored=this.restored;
    const restoredPrefix=restored&&restored.baselineLength<=snapshot.length?hash(JSON.stringify(snapshot.slice(0,restored.baselineLength))):undefined;
    const restoredMatch=!!restored&&restoredPrefix!==undefined&&restored.headerHash===headerHash&&(restoredPrefix===restored.baselineHash||restoredPrefix===restored.baselineNullContentHash);
    const liveMatch=this.state?.headerHash===headerHash&&(prefix(this.state.baselineMessages)||prefix(this.baselineWithoutContent));
    const reuse=liveMatch||restoredMatch;
    const baselineLength=liveMatch?this.state!.baselineMessages.length:restored?.baselineLength??0;
    const responseId=liveMatch?this.state!.responseId:restored?.responseId;
    const input=(reuse?snapshot.slice(baselineLength):snapshot).flatMap(inputItem);
    const diagnostics:ModelRequestDiagnostics={requestMode:liveMatch?'continue_live':restoredMatch?'continue_restored':'fresh',requestTimeoutMs:this.options.timeoutMs};
    let inspection:ModelRequestInspection={requestMode:diagnostics.requestMode,...(reuse?{previousResponseId:responseId}:{})};
    const capture=(text:string,partial:boolean)=>{inspection={...inspection,...responseInspection(text,partial)};if(httpStatus)inspection.errorText=`${partial?'[partial HTTP error body; incomplete]\\n':''}${text}`;};
    let stage:ModelRequestDiagnostics['failureStage']='request';
    const controller=new AbortController();let aborted:'cancelled'|'timeout'|undefined;
    const stop=()=>{if(!aborted){aborted='cancelled';diagnostics.abortSource=upstreamAbortSource(signal?.reason);}controller.abort();};signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const timer=setTimeout(()=>{if(!aborted){aborted='timeout';diagnostics.abortSource='request_timeout';}controller.abort();},this.options.timeoutMs);
    try{
      const body:Record<string,unknown>={model:this.options.model,input,instructions,store:true,stream:false,max_output_tokens:this.options.maxTokens,prompt_cache_key:this.cacheKey,
        ...(functions.length?{tools:functions,tool_choice:'auto'}:{}),...(reuse?{previous_response_id:responseId}:{})};
      if(this.options.serverCompactionVerified&&this.options.compactionThreshold!==undefined)body.context_management=[{type:'compaction',compact_threshold:this.options.compactionThreshold}];
      const requestJson=JSON.stringify(body);inspection.requestJson=requestJson;
      try{this.options.onRequestStart?.(Object.freeze({requestId,startedAt,transport:'responses',model:this.options.model,requestJson,requestMode:diagnostics.requestMode??'fresh',...(reuse?{previousResponseId:responseId}:{})}));}catch{}
      const response=await fetch(this.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',authorization:`Bearer ${this.options.apiKey}`},body:requestJson});
      inspection.providerRequestId=providerRequestId(response.headers);
      if(!response.ok){
        httpStatus=response.status;failure='http_error';stage='http_status';
        let raw:unknown;try{raw=await readBody(response,()=>{},capture);}catch{/* Keep HTTP status/code even for non-JSON or oversized error bodies. */}
        Object.assign(diagnostics,providerDiagnostics(raw));
        if(reuse&&expired(raw))throw new ResponseStateExpiredError(httpStatus);
        throw new ModelError('http_error',httpStatus);
      }
      failure='invalid_response';const raw=await readBody(response,value=>{stage=value;},capture);
      stage='response_validate';
      if(!object(raw))throw new ModelError('invalid_response');
      usage=parseResponsesUsage(raw.usage);
      if(raw.error!=null)Object.assign(diagnostics,providerDiagnostics(raw));
      if(expired(raw)&&reuse)throw new ResponseStateExpiredError();
      if(raw.status==='incomplete')throw new ModelError('truncated_response');
      if(raw.error!=null)throw new ModelError('invalid_response');
      const result=completion(raw);
      stage='post_response';
      if(generation!==this.generation&&!aborted)diagnostics.abortSource='generation_changed';
      if(controller.signal.aborted||generation!==this.generation)throw new ModelError('cancelled');
      const assistant:ChatMessage={role:'assistant',content:result.content,...(result.tool_calls.length?{tool_calls:structuredClone(result.tool_calls)}:{})};
      this.state={responseId:raw.id as string,baselineMessages:[...snapshot,assistant],headerHash,outputItems:structuredClone(raw.output as unknown[])};
      this.baselineWithoutContent=result.tool_calls.length?[...snapshot,{...assistant,content:null}]:undefined;
      this.restored=undefined;
      status='success';return result;
    }catch(error){
      if(!inspection.errorText&&error instanceof Error&&!(error instanceof ModelError)&&error.message)inspection.errorText=error.message;
      this.state=undefined;this.baselineWithoutContent=undefined;this.restored=undefined;
      const code=aborted??(error instanceof ModelError?error.code:failure);failure=code;
      diagnostics.failureStage=stage;
      if(error instanceof ResponseStateExpiredError&&!aborted)throw new ResponseStateExpiredError(httpStatus,diagnostics);
      throw new ModelError(code,httpStatus,diagnostics);
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',stop);this.busy=false;
      if(status==='error'&&!inspection.errorText)inspection.errorText=failure;
      try{this.options.onRequest?.({inspection,requestId,startedAt,endedAt:Date.now(),durationMs:Math.max(0,performance.now()-started),transport:'responses',model:this.options.model,status,
        ...(status==='error'?{errorCode:failure}:{}),...(httpStatus===undefined?{}:{httpStatus}),usage,diagnostics:normalizeModelRequestDiagnostics(diagnostics)});}catch{/* Observers never change transport results. */}
    }
  }
}
