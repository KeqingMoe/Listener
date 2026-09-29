import {getQuickJS} from 'quickjs-emscripten';
import type {QuickJSHandle} from 'quickjs-emscripten';
import {isExecutionDiagnostic,normalizeOptions,type ExecutionResult,type ExecutionDiagnostic,type DiagnosticPhase} from './protocol.js';
let started=false,cancelled=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async (message:unknown)=>{
 if(started)return;started=true;
 let logs:string[]=[],logSize=0,diagnostic:ExecutionDiagnostic|undefined;
  const contract=(message:string):ExecutionDiagnostic=>({kind:'contract_error',phase:'result',message,truncated:false});
 const send=(result:ExecutionResult)=>{if(process.connected)process.send!(result,()=>process.exit(0));else process.exit(0);};
 try {
  if(!message||typeof message!=='object')throw Error('invalid_request');
  const {code,limits}=normalizeOptions(message as Parameters<typeof normalizeOptions>[0]);
  const Q=await getQuickJS(),runtime=Q.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);runtime.setMaxStackSize(limits.stackBytes);
  const deadline=limits.timeoutMs===null?Infinity:performance.now()+limits.timeoutMs;
  runtime.setInterruptHandler(()=>cancelled||performance.now()>=deadline);
  const vm=runtime.newContext();let promise:QuickJSHandle|undefined;
  let fault:string|undefined;
  const init=vm.evalCode(`(()=>{const stringify=JSON.stringify,create=Object.create,slice=Function.prototype.call.bind(String.prototype.slice),primitive=String;return e=>{let truncated=false;const trim=(v,n)=>{if(typeof v!=='string')return undefined;if(v.length>n){truncated=true;return slice(v,0,n)}return v};const out=create(null);if(e!==null&&(typeof e==='object'||typeof e==='function')){out.name=trim(e.name,96);out.message=trim(e.message,512)||'Code threw an object without a readable error message.';out.stack=trim(e.stack,512)}else{out.name='ThrownValue';out.message=trim(primitive(e),512)}out.truncated=truncated;return stringify(out)}})()`);
  if(init.error){init.error.dispose();throw Error('execution_error');}
  const extractor=init.value;
  const diagnose=(h:QuickJSHandle,phase:DiagnosticPhase):ExecutionDiagnostic=>{
   const fallback:ExecutionDiagnostic={kind:'guest_exception',phase,message:'Exception details could not be safely extracted.',truncated:false};
   const until=performance.now()+50;runtime.setInterruptHandler(()=>cancelled||performance.now()>=until);
   try{const r=vm.callFunction(extractor,vm.undefined,h);if(r.error){r.error.dispose();return fallback;}try{const raw=string(r.value,8192);const d={...JSON.parse(raw),kind:'guest_exception',phase};return isExecutionDiagnostic(d)?d:fallback;}finally{r.value.dispose();}}catch{return fallback;}finally{runtime.setInterruptHandler(()=>cancelled||performance.now()>=deadline);}
  };
  const string=(h:QuickJSHandle,max:number)=>{
   if(vm.typeof(h)!=='string'){diagnostic=contract(`Expected a primitive string, received ${vm.typeof(h)}; serialize the result explicitly before returning.`);throw Error('invalid_return_type');}
   const len=vm.getProp(h,'length');let length:number;try{length=vm.getNumber(len);}finally{len.dispose();}
   if(length>max)throw Error('output_too_large');
   const value=vm.getString(h);if(Buffer.byteLength(value)>max)throw Error('output_too_large');return value;
  };
  try {
   const consoleObject=vm.newObject();
   for(const name of ['log','info','warn','error','debug']){
    const fn=vm.newFunction(name,(...args)=>{try{
     const parts:string[]=[];let size=1;
     for(const h of args){const separator=parts.length?1:0;const available=limits.logBytes-logSize-size-separator;if(available<0)throw Error('logs_too_large');const part=string(h,available);size+=separator+Buffer.byteLength(part);parts.push(part);}
     if(logSize+size>limits.logBytes)throw Error('logs_too_large');logSize+=size;logs.push(parts.join(' '));
    }catch(error){fault=error instanceof Error&&error.message==='invalid_return_type'?'invalid_log_type':'logs_too_large';throw Error('Log arguments must be bounded strings');}});
    vm.setProp(consoleObject,name,fn);fn.dispose();
   }
   vm.setProp(vm.global,'console',consoleObject);consoleObject.dispose();
   // The Function constructor is QuickJS's, not the host's. A function body cannot escape into wrapper source.
   const compiled=vm.evalCode('(async function(){}).constructor');
   if(compiled.error){const d=diagnose(compiled.error,'compile');compiled.error.dispose();send({status:'failed',error:'syntax_error',logs,diagnostic:d});return;}
   const source=vm.newString(code);const fnResult=vm.callFunction(compiled.value,vm.undefined,source);source.dispose();compiled.value.dispose();
   if(fnResult.error){const d=diagnose(fnResult.error,'compile');fnResult.error.dispose();send({status:'failed',error:'syntax_error',logs,diagnostic:d});return;}
   const evaluation=vm.callFunction(fnResult.value,vm.undefined);fnResult.value.dispose();
   if(evaluation.error){const d=diagnose(evaluation.error,'execute');evaluation.error.dispose();send({status:'failed',error:'execution_error',logs,diagnostic:d});return;}promise=evaluation.value;
   while(true){
    if(fault)throw Error(fault);
    if(cancelled)throw Error('cancelled');
    if(performance.now()>=deadline)throw Error('execution_timeout');
    const state=vm.getPromiseState(promise);
    if(state.type==='fulfilled'){try{const value=string(state.value,limits.resultBytes);send({status:'completed',value,logs});}finally{state.value.dispose();}break;}
    if(state.type==='rejected'){diagnostic=diagnose(state.error,'execute');state.error.dispose();throw Error('execution_error');}
    const jobs=runtime.executePendingJobs(64);
    if(jobs.error){diagnostic=diagnose(jobs.error,'execute');jobs.error.dispose();throw Error('execution_error');}
    // Yield to IPC/watchdog between bounded microtask batches; an unresolved promise may wait indefinitely.
    await new Promise<void>(resolve=>setTimeout(resolve,runtime.hasPendingJob()?0:10));
   }
  }finally{promise?.dispose();extractor.dispose();vm.dispose();runtime.dispose();}
 }catch(error){const safe=new Set(['invalid_limits','code_too_large','invalid_request','invalid_return_type','output_too_large','logs_too_large','invalid_log_type','syntax_error','execution_timeout','cancelled']);const reason=error instanceof Error&&safe.has(error.message)?error.message:'execution_error';if(['invalid_log_type','logs_too_large','output_too_large'].includes(reason))diagnostic=contract(reason==='invalid_log_type'?'Console arguments must be primitive strings; serialize them explicitly.':reason==='logs_too_large'?'Console output exceeded the log byte limit.':'Returned string exceeded the result byte limit.');send({status:reason==='cancelled'?'cancelled':'failed',error:reason,logs,...(diagnostic?{diagnostic}:{})});}
});
process.on('SIGTERM',()=>{cancelled=true;process.exit(0);});
