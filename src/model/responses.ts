import { createHash, randomUUID } from 'node:crypto';
import type { ChatContentPart, ChatMessage, Completion, Model } from '../contracts/model.js';
import type { ToolCall, ToolDefinition } from '../contracts/tools.js';
import { ModelError, type ModelErrorCode, type OpenAIModelOptions } from './chat.js';
import { providerRequestId, responseInspection } from '../observability/request-inspection.js';
import { parseResponsesUsage, type ModelRequestInspection, type ModelRequestRecord, type ModelUsage } from '../observability/model-usage.js';
import { normalizeModelRequestDiagnostics, providerDiagnostics, upstreamAbortSource, type ModelRequestDiagnostics } from '../observability/model-diagnostics.js';
import { MODEL_USER_AGENT } from '../config/version.js';
import { readSse, SseError } from './sse.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const MAX_BYTES=2*1024*1024, MAX_WIRE_BYTES=32*1024*1024, MAX_ARGS=16*1024;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
export class ResponseStateExpiredError extends ModelError {
  readonly stateExpired=true;
  constructor(httpStatus?:number,diagnostics?:ModelRequestDiagnostics){super('invalid_response',httpStatus,diagnostics);this.name='ResponseStateExpiredError';}
}
export interface ResponsesModelOptions extends OpenAIModelOptions {
  sessionId:string; incremental?:boolean; compactionThreshold?:number; serverCompactionVerified?:boolean;
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
  /** Full mode stores only native assistant outputs; user/tool inputs live in ModelSession. */
  outputHistory?:Array<{index:number;items:unknown[]}>;
  outputHistoryStart?:number;
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
  private outputHistory:Array<{index:number;items:unknown[]}>=[];
  constructor(options:ResponsesModelOptions){
    try{
      const u=new URL(options.baseUrl),local=u.hostname==='localhost'||u.hostname==='[::1]'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname);
      if(u.username||u.password||u.search||u.hash||options.baseUrl.includes('?')||options.baseUrl.includes('#')||
        (u.protocol!=='https:'&&!(u.protocol==='http:'&&local))||!bounded(options.model,128)||!bounded(options.sessionId,256)||
        !options.apiKey||/[\r\n]/.test(options.apiKey)||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>2147483647||
        !Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||
        (options.compactionThreshold!==undefined&&(!Number.isSafeInteger(options.compactionThreshold)||options.compactionThreshold<1))||
        (options.incremental!==undefined&&typeof options.incremental!=='boolean')||
        (options.serverCompactionVerified!==undefined&&typeof options.serverCompactionVerified!=='boolean'))throw Error();
      u.pathname=u.pathname.replace(/\/+$/,'')+'/responses';
      this.endpoint=u.toString();this.options={...options};this.cacheKey=hash('qqbot-responses:'+options.sessionId);
    }catch{throw new Error('Invalid Responses model configuration');}
  }
  reset():void {this.generation++;this.state=undefined;this.baselineWithoutContent=undefined;this.restored=undefined;this.outputHistory=[];}
  getCheckpoint():ResponsesCheckpoint|undefined {return this.state?structuredClone(this.state):undefined;}
  getContinuationCheckpoint():ResponsesContinuationCheckpoint|undefined {
    const s=this.state;if(!s)return this.restored?structuredClone(this.restored):undefined;
    const baseline=s.baselineMessages;
    const out:ResponsesContinuationCheckpoint={version:1,responseId:s.responseId,headerHash:s.headerHash,baselineLength:baseline.length,baselineHash:hash(JSON.stringify(baseline)),...(this.options.incremental===false?{outputHistory:structuredClone(this.outputHistory),outputHistoryStart:this.outputHistory[0]?.index??baseline.length}:{})};
    if(this.baselineWithoutContent){const nullHash=hash(JSON.stringify(this.baselineWithoutContent));if(nullHash!==out.baselineHash)out.baselineNullContentHash=nullHash;}
    return out;
  }
  restoreContinuationCheckpoint(value:unknown):void {
    const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    const valid=object(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&
      Reflect.ownKeys(value).every(k=>typeof k==='string'&&['version','responseId','headerHash','baselineLength','baselineHash','baselineNullContentHash','outputHistory','outputHistoryStart'].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'))&&
      value.version===1&&bounded(value.responseId,256)&&digest(value.headerHash)&&
      typeof value.baselineLength==='number'&&Number.isSafeInteger(value.baselineLength)&&value.baselineLength>=0&&value.baselineLength<=10000&&digest(value.baselineHash)&&
      (!Object.hasOwn(value,'baselineNullContentHash')||digest(value.baselineNullContentHash))&&
      (this.options.incremental===false?Array.isArray(value.outputHistory)&&typeof value.outputHistoryStart==='number'&&Number.isSafeInteger(value.outputHistoryStart):!Object.hasOwn(value,'outputHistory'));
    let historyValid=valid;
    if(valid&&Array.isArray(value.outputHistory)){
      try{
        if(Buffer.byteLength(JSON.stringify(value))>16*1024*1024||value.outputHistory.length===0)throw Error();
        let previous=-1;
        for(const entry of value.outputHistory){
          if(!object(entry)||Object.keys(entry).some(k=>k!=='index'&&k!=='items')||typeof entry.index!=='number'||!Number.isSafeInteger(entry.index)||entry.index<=previous||entry.index>=Number(value.baselineLength))throw Error();
          completion({id:'checkpoint',status:'completed',output:entry.items});previous=entry.index;
        }
        if(previous!==Number(value.baselineLength)-1||!object(value.outputHistory[0])||value.outputHistory[0].index!==value.outputHistoryStart)throw Error();
      }catch{historyValid=false;}
    }
    if(!historyValid){this.reset();throw new Error('Invalid continuation checkpoint');}
    const checkpoint=value as Record<string,unknown>;
    this.outputHistory=[];
    this.generation++;this.state=undefined;this.baselineWithoutContent=undefined;this.restored={version:1,responseId:String(checkpoint.responseId),headerHash:String(checkpoint.headerHash),baselineLength:Number(checkpoint.baselineLength),baselineHash:String(checkpoint.baselineHash),...(checkpoint.baselineNullContentHash===undefined?{}:{baselineNullContentHash:String(checkpoint.baselineNullContentHash)}),...(Array.isArray(checkpoint.outputHistory)?{outputHistory:structuredClone(checkpoint.outputHistory) as Array<{index:number;items:unknown[]}>,outputHistoryStart:Number(checkpoint.outputHistoryStart)}:{})};
  }
  async complete(messages:ChatMessage[],tools:ToolDefinition[]=[],signal?:AbortSignal):Promise<Completion>{
    if(this.busy)throw new ModelError('invalid_response');
    this.busy=true;
    const generation=this.generation,started=performance.now(),startedAt=Date.now(),requestId=randomUUID();
    const snapshot=structuredClone(messages),toolSnapshot=structuredClone(tools);
    let ttftMs:number|null=null,decodeDurationMs:number|null=null;
     let usage:ModelUsage=parseResponsesUsage(undefined),status:ModelRequestRecord['status']='error',failure:ModelErrorCode='network_error',httpStatus:number|undefined;
    const instructions=snapshot.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n\n');
    const functions=toolSnapshot.map(t=>({type:'function',name:t.function.name,description:t.function.description,parameters:t.function.parameters}));
    const headerHash=hash(JSON.stringify({endpoint:this.endpoint,account:hash(this.options.apiKey),instructions,functions,model:this.options.model,maxTokens:this.options.maxTokens}));
    const prefix=(base:ChatMessage[]|undefined)=>base!==undefined&&base.length<=snapshot.length&&base.every((m,i)=>JSON.stringify(m)===JSON.stringify(snapshot[i]));
    const fullMode=this.options.incremental===false;
    const restored=this.restored;
    if(fullMode&&restored?.outputHistory)this.outputHistory=structuredClone(restored.outputHistory);
    const restoredPrefix=restored&&restored.baselineLength<=snapshot.length?hash(JSON.stringify(snapshot.slice(0,restored.baselineLength))):undefined;
    const restoredMatch=!!restored&&restoredPrefix!==undefined&&restored.headerHash===headerHash&&(restoredPrefix===restored.baselineHash||restoredPrefix===restored.baselineNullContentHash);
    const liveMatch=this.state?.headerHash===headerHash&&(prefix(this.state.baselineMessages)||prefix(this.baselineWithoutContent));
    const matched=liveMatch||restoredMatch;
    const reuse=!fullMode&&matched;
    const baselineLength=liveMatch?this.state!.baselineMessages.length:restored?.baselineLength??0;
    const responseId=liveMatch?this.state!.responseId:restored?.responseId;
    const history=fullMode&&matched?this.outputHistory:[];
    const outputs=new Map(history.map(entry=>[entry.index,entry.items]));
    const expectedIndices=snapshot.slice(Number((restored as any)?.outputHistoryStart??history[0]?.index??0),baselineLength).map((m,i)=>m.role==='assistant'?i+Number((restored as any)?.outputHistoryStart??history[0]?.index??0):-1).filter(i=>i>=0);
    const historyValid=!fullMode||!matched||history.length===expectedIndices.length&&history.every((entry,pos)=>entry.index===expectedIndices[pos]&&(()=>{
      const message=snapshot[entry.index];
      if(!message||message.role!=='assistant')return false;
      let projection:Completion;
      try{projection=completion({id:'checkpoint',status:'completed',output:entry.items});}catch{return false;}
      return message?.role==='assistant'&&(message.content===projection.content||message.content===null&&projection.tool_calls.length>0)&&JSON.stringify(message.tool_calls??[])===JSON.stringify(projection.tool_calls);
    })());
    const input=fullMode?snapshot.flatMap((message,index)=>outputs.get(index)??inputItem(message)):(reuse?snapshot.slice(baselineLength):snapshot).flatMap(inputItem);
    const diagnostics:ModelRequestDiagnostics={requestMode:fullMode?'fresh':liveMatch?'continue_live':restoredMatch?'continue_restored':'fresh',requestTimeoutMs:this.options.timeoutMs};
    let inspection:ModelRequestInspection={requestMode:diagnostics.requestMode,...(reuse?{previousResponseId:responseId}:{})};
    const capture=(text:string,partial:boolean)=>{inspection={...inspection,...responseInspection(text,partial)};if(httpStatus)inspection.errorText=`${partial?'[partial HTTP error body; incomplete]\\n':''}${text}`;};
    let stage:ModelRequestDiagnostics['failureStage']='request';
    const controller=new AbortController();let aborted:'cancelled'|'timeout'|undefined;
    const stop=()=>{if(!aborted){aborted='cancelled';diagnostics.abortSource=upstreamAbortSource(signal?.reason);}controller.abort();};signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const timer=setTimeout(()=>{if(!aborted){aborted='timeout';diagnostics.abortSource='request_timeout';}controller.abort();},this.options.timeoutMs);
    try{
      if(!historyValid){this.reset();throw new ModelError('invalid_response');}
      const body:Record<string,unknown>={model:this.options.model,input,instructions,store:true,stream:true,max_output_tokens:this.options.maxTokens,prompt_cache_key:this.cacheKey,
        ...(functions.length?{tools:functions,tool_choice:'auto'}:{}),...(reuse?{previous_response_id:responseId}:{})};
      if(this.options.serverCompactionVerified&&this.options.compactionThreshold!==undefined)body.context_management=[{type:'compaction',compact_threshold:this.options.compactionThreshold}];
      const requestJson=JSON.stringify(body);inspection.requestJson=requestJson;
      try{this.options.onRequestStart?.(Object.freeze({requestId,startedAt,transport:'responses',model:this.options.model,requestJson,requestMode:diagnostics.requestMode??'fresh',...(reuse?{previousResponseId:responseId}:{})}));}catch{}
      const headers=new Headers(this.options.requestHeaders?.());
      headers.set('content-type','application/json');headers.set('authorization',`Bearer ${this.options.apiKey}`);headers.set('user-agent',MODEL_USER_AGENT);
      const fetchStarted=performance.now();
      const response=await fetch(this.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers,body:requestJson});
      inspection.providerRequestId=providerRequestId(response.headers);
      if(!response.ok){
        httpStatus=response.status;failure='http_error';stage='http_status';
        let raw:unknown;try{raw=await readBody(response,()=>{},capture);}catch{/* Keep HTTP status/code even for non-JSON or oversized error bodies. */}
        Object.assign(diagnostics,providerDiagnostics(raw));
        if(reuse&&expired(raw))throw new ResponseStateExpiredError(httpStatus);
        throw new ModelError('http_error',httpStatus);
      }
      failure='invalid_response';stage='response_body';
       if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='text/event-stream'||!response.body)throw new ModelError('invalid_response');
       let raw:unknown, firstOutput:number|undefined,streamCompletedAt:number|undefined,deltaBytes=0;
       const deltas=new Map<string,{type:string,index:number,part:number,text:string}>();
       const addedCalls=new Map<number,Record<string,unknown>>();
       const observed=(at:number)=>{firstOutput??=at;ttftMs=Math.max(0,firstOutput-fetchStarted);};
       try{await readSse(response.body,(data,at)=>{
         const event:unknown=JSON.parse(data);
         if(!object(event)||typeof event.type!=='string')throw new ModelError('invalid_response');
         if(['response.output_text.delta','response.refusal.delta','response.function_call_arguments.delta','response.reasoning_text.delta'].includes(event.type)){
           if(typeof event.delta!=='string'||!Number.isSafeInteger(event.output_index)||Number(event.output_index)<0)throw new ModelError('invalid_response');
           deltaBytes+=Buffer.byteLength(event.delta);if(deltaBytes>MAX_BYTES)throw new ModelError('response_too_large');
            const part=event.content_index??0;
           if(!Number.isSafeInteger(part)||Number(part)<0)throw new ModelError('invalid_response');
           const key=`${event.type}:${event.output_index}:${part}`,entry=deltas.get(key)??{type:event.type,index:Number(event.output_index),part:Number(part),text:''};entry.text+=event.delta;deltas.set(key,entry);
           if(event.delta)observed(at);
         }
         if(event.type==='response.output_item.added'&&object(event.item)&&event.item.type==='function_call'){
           if(!Number.isSafeInteger(event.output_index)||Number(event.output_index)<0||!bounded(event.item.name,128)||!bounded(event.item.call_id,256)||!bounded(event.item.id,256)||addedCalls.has(Number(event.output_index)))throw new ModelError('invalid_response');
           addedCalls.set(Number(event.output_index),event.item);observed(at);
         }
         if(['response.completed','response.incomplete','response.failed'].includes(event.type)){
           if(raw!==undefined||!object(event.response)||event.response.status!==event.type.slice('response.'.length))throw new ModelError('invalid_response');raw=event.response;streamCompletedAt=at;return true;
         }
         if(event.type==='error')throw new ModelError('invalid_response');
       },{signal:controller.signal,maxBytes:MAX_WIRE_BYTES,onBytes:bytes=>{if(bytes.byteLength>MAX_WIRE_BYTES)throw new SseError('response_too_large');}});}catch(error){if(error instanceof ModelError)throw error;throw new ModelError(error instanceof SseError?error.code:'invalid_response');}
       if(raw===undefined)throw new ModelError('invalid_response');
       const responseJson=JSON.stringify(raw);
       if(Buffer.byteLength(responseJson)>MAX_BYTES)throw new ModelError('response_too_large');
       capture(responseJson,false);
      stage='response_validate';
      if(!object(raw))throw new ModelError('invalid_response');
      usage=parseResponsesUsage(raw.usage);
      if(raw.error!=null)Object.assign(diagnostics,providerDiagnostics(raw));
      if(expired(raw)&&reuse)throw new ResponseStateExpiredError();
      if(raw.status==='incomplete')throw new ModelError('truncated_response');
      if(raw.error!=null)throw new ModelError('invalid_response');
      const result=completion(raw);
      /* Validate observed deltas against the authoritative terminal snapshot. */
      for(const delta of deltas.values()){
        const item=(raw.output as unknown[])[delta.index];
        if(!object(item))throw new ModelError('invalid_response');
        if(delta.type==='response.reasoning_text.delta')continue;
        const part=Array.isArray(item.content)?item.content[delta.part]:undefined;
        const expected=delta.type==='response.function_call_arguments.delta'?item.arguments:object(part)?(delta.type==='response.refusal.delta'?part.refusal:part.text):undefined;
        if(expected!==delta.text)throw new ModelError('invalid_response');
      }
      for(const [index,added] of addedCalls){const item=(raw.output as unknown[])[index];if(!object(item)||item.type!=='function_call'||item.id!==added.id||item.call_id!==added.call_id||item.name!==added.name)throw new ModelError('invalid_response');}
      decodeDurationMs=firstOutput!==undefined&&streamCompletedAt!==undefined?streamCompletedAt-firstOutput:null;
      stage='post_response';
      if(generation!==this.generation&&!aborted)diagnostics.abortSource='generation_changed';
      if(controller.signal.aborted||generation!==this.generation)throw new ModelError('cancelled');
      const assistant:ChatMessage={role:'assistant',content:result.content,...(result.tool_calls.length?{tool_calls:structuredClone(result.tool_calls)}:{})};
      const nativeOutput=structuredClone(raw.output as unknown[]);
      this.state={responseId:raw.id as string,baselineMessages:[...snapshot,assistant],headerHash,outputItems:nativeOutput};
      if(fullMode)this.outputHistory=[...(matched?history:snapshot.flatMap((m,index)=>m.role==='assistant'?[{index,items:inputItem(m).map(item=>{const x=item as Record<string,unknown>;return x.role==='assistant'?{type:'message',...x}:x;})}]:[])),{index:snapshot.length,items:nativeOutput}];
      this.baselineWithoutContent=result.tool_calls.length?[...snapshot,{...assistant,content:null}]:undefined;
      this.restored=undefined;
      status='success';return result;
    }catch(error){
      if(!inspection.errorText&&error instanceof Error&&!(error instanceof ModelError)&&error.message)inspection.errorText=error.message;
      // A failed full-mode request did not append anything: keep the previous native
      // output mapping so retry/restart cannot silently lose reasoning or compaction.
      if(!fullMode){this.state=undefined;this.baselineWithoutContent=undefined;this.restored=undefined;}
      const code=aborted??(error instanceof ModelError?error.code:failure);failure=code;
      diagnostics.failureStage=stage;
      if(error instanceof ResponseStateExpiredError&&!aborted)throw new ResponseStateExpiredError(httpStatus,diagnostics);
      throw new ModelError(code,httpStatus,diagnostics);
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',stop);this.busy=false;
      if(status==='error'&&!inspection.errorText)inspection.errorText=failure;
      try{this.options.onRequest?.({inspection,requestId,startedAt,endedAt:Date.now(),durationMs:Math.max(0,performance.now()-started),ttftMs,decodeDurationMs:status==='success'?decodeDurationMs:null,transport:'responses',model:this.options.model,status,
        ...(status==='error'?{errorCode:failure}:{}),...(httpStatus===undefined?{}:{httpStatus}),usage,diagnostics:normalizeModelRequestDiagnostics(diagnostics)});}catch{/* Observers never change transport results. */}
    }
  }
}
