import {fork, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {isExecutionDiagnostic,normalizeOptions,TOOL_CALL_LIMITS,type ExecutionOptions,type ExecutionResult} from './protocol.ts';

/** Replace guest {"$bytes":i} placeholders; every attachment must be referenced exactly once. */
export function decodeToolValue(json:string,attachments:readonly Uint8Array[]):unknown {
 const used=new Set<number>();
 const value=JSON.parse(json,(_key,v:unknown)=>{
  if(v===null||typeof v!=='object'||Array.isArray(v)||!Object.hasOwn(v,'$bytes'))return v;
  const index=(v as Record<string,unknown>).$bytes;
  if(Object.keys(v).length!==1||typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>=attachments.length||used.has(index))throw Error('invalid_bytes');
  used.add(index);return Buffer.from(attachments[index]!);
 });
 if(used.size!==attachments.length)throw Error('invalid_bytes');
 return value;
}
/** Host → guest encoding: Uint8Array (incl. Buffer) values become placeholders. */
export function encodeToolValue(value:unknown):{json:string;attachments:Uint8Array[]} {
 const attachments:Uint8Array[]=[];
 const walk=(v:unknown):unknown=>{
  if(v instanceof Uint8Array){attachments.push(Uint8Array.from(v));return {$bytes:attachments.length-1};}
  if(Array.isArray(v))return v.map(walk);
  if(v&&typeof v==='object'){const out:Record<string,unknown>={};for(const [k,x] of Object.entries(v)){if(k==='$bytes')continue;out[k]=walk(x);}return out;}
  return v;
 };
 return {json:JSON.stringify(walk(value)??null),attachments};
}
export function startExecution(options:ExecutionOptions):{result:Promise<ExecutionResult>;cancel:()=>void}{
 const normalized=normalizeOptions(options);let child:ChildProcess|undefined,settled=false,cancelled=false,timer:NodeJS.Timeout|undefined;
 const calls=new AbortController();let lastCallId=0;
 const tools=options.tools??[],callTool=options.callTool;
 if(tools.length&&!callTool)throw Error('invalid_request');
 const result=new Promise<ExecutionResult>((resolve)=>{
  const finish=(value:ExecutionResult)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);calls.abort();resolve(value);};
  const fault=()=>{child?.kill('SIGKILL');finish({status:'failed',error:'executor_ipc_error',logs:[]});};
  const source=dirname(fileURLToPath(import.meta.url));const worker=join(source,'worker'+(source.endsWith('/src/sandbox')?'.ts':'.js'));
  try {
   child=fork(worker,[],{silent:true,serialization:'advanced',execArgv:worker.endsWith('.ts')?['--import','tsx']:[],env:{PATH:process.env.PATH??'/usr/bin:/bin',NODE_NO_WARNINGS:'1'},stdio:['ignore','ignore','ignore','ipc']});
   child.on('message',(message:unknown)=>{
    if(settled)return;
    const m=message as Record<string,unknown>|null;
    if(m&&typeof m==='object'&&m.type==='tool_call'){
     const {id,name,json,attachments}=m;
     if(typeof id!=='number'||id!==lastCallId+1||typeof name!=='string'||!tools.includes(name)||typeof json!=='string'||Buffer.byteLength(json)>TOOL_CALL_LIMITS.jsonBytes||
      !Array.isArray(attachments)||attachments.length>TOOL_CALL_LIMITS.attachments||!attachments.every(a=>a instanceof Uint8Array)||attachments.reduce((n,a:Uint8Array)=>n+a.byteLength,0)>TOOL_CALL_LIMITS.attachmentBytes)return fault();
     lastCallId=id;
     void (async()=>{
      let reply:unknown;
      try{let args:unknown;try{args=decodeToolValue(json,attachments as Uint8Array[]);}catch{args=undefined;}
       reply=args===undefined?{status:'error',error:'invalid_arguments'}:await callTool!(name,args,calls.signal);}
      catch{reply={status:'error',error:'tool_failed'};}
      if(settled||!child?.connected)return;
      let encoded:{json:string;attachments:Uint8Array[]};
      try{encoded=encodeToolValue(reply);}catch{encoded={json:'{"status":"error","error":"invalid_host_result"}',attachments:[]};}
      child.send({type:'tool_result',id,...encoded},error=>{if(error&&!settled)fault();});
     })();
     return;
    }
    const r=m as Partial<ExecutionResult>|null;
    const valid=r&&typeof r==='object'&&(!('diagnostic'in r)||((r.status==='failed'||r.status==='cancelled')&&isExecutionDiagnostic(r.diagnostic)))&&Array.isArray(r.logs)&&r.logs.every(x=>typeof x==='string')&&r.logs.reduce((n,x)=>n+Buffer.byteLength(x)+1,0)<=normalized.limits.logBytes&&
     ((r.status==='completed'&&'value'in r&&typeof r.value==='string'&&Buffer.byteLength(r.value)<=normalized.limits.resultBytes)||((r.status==='failed'||r.status==='cancelled')&&'error'in r&&typeof r.error==='string'&&r.error.length<=128));
    child?.kill('SIGKILL');
    finish(valid?r as ExecutionResult:{status:'failed',error:'executor_ipc_error',logs:[]});
   });
   child.once('error',()=>{child?.kill('SIGKILL');finish({status:'failed',error:'executor_process_error',logs:[]});});
   child.once('exit',()=>{if(!settled)finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':'executor_process_error',logs:[]});});
   child.once('disconnect',()=>{if(!settled){child?.kill('SIGKILL');finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':'executor_ipc_error',logs:[]});}});
   child.send({code:normalized.code,...normalized.limits,...(tools.length?{tools:[...tools]}:{})},error=>{if(error){child?.kill('SIGKILL');finish({status:'failed',error:'executor_ipc_error',logs:[]});}});
   if(normalized.limits.timeoutMs!==null)timer=setTimeout(()=>{if(!settled){child?.kill('SIGKILL');finish({status:'failed',error:'execution_timeout',logs:[]});}},normalized.limits.timeoutMs+250);
  }catch{finish({status:'failed',error:'executor_process_error',logs:[]});}
 });
 return {result,cancel:()=>{if(settled)return;cancelled=true;calls.abort();child?.kill('SIGKILL');}};
}
